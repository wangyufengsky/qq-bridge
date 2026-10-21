import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readGeneratedImage,deliverGeneratedImage,MAX_GENERATED_IMAGE_BYTES} from '../../src/generated-image.mjs';
import {bridgeHarness} from '../../scripts/audit-bridge-harness.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=','base64');
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-image-test-'));const dir=path.join(home,'generated_images/thread-a');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'image.png'),png);return {home,dir};}
test('image path is limited to current thread; blocks traversal, links, oversized and non-images',()=>{
 const {home,dir}=fixture();const read=filePath=>readGeneratedImage({home,sessionId:'thread-a',filePath});
 try{
  assert.equal(read('image.png').bytes,png.length);assert.equal(read(path.join(dir,'image.png')).bytes,png.length);
  assert.throws(()=>read('../thread-b/image.png'),/OUTSIDE/);assert.throws(()=>read('/etc/passwd'),/OUTSIDE/);
  fs.symlinkSync(path.join(dir,'image.png'),path.join(dir,'link.png'));assert.throws(()=>read('link.png'),/SYMLINK/);
  fs.linkSync(path.join(dir,'image.png'),path.join(dir,'hard.png'));assert.throws(()=>read('hard.png'),/REGULAR/);fs.unlinkSync(path.join(dir,'hard.png'));
  fs.writeFileSync(path.join(dir,'fake.png'),'secret not an image');assert.throws(()=>read('fake.png'),/FORMAT/);
  fs.writeFileSync(path.join(dir,'huge.png'),Buffer.alloc(MAX_GENERATED_IMAGE_BYTES+1));assert.throws(()=>read('huge.png'),/SIZE/);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('delivery uses base64, persists receipt, deduplicates; uncertain receipt is not retried',async()=>{
 const {home}=fixture();let calls=0;const image=readGeneratedImage({home,sessionId:'thread-a',filePath:'image.png'});
 const args={image,key:'group:456',sessionId:'thread-a',receiptFile:path.join(home,'receipts.json'),httpUrl:'http://localhost:3000',guard:()=>{},fetchImpl:async(url,init)=>{calls++;assert.equal(JSON.parse(init.body).message[0].data.file,'base64://'+png.toString('base64'));return {ok:true,json:async()=>({status:'ok',retcode:0,data:{message_id:55}})};}};
 try{
  assert.equal((await deliverGeneratedImage(args)).messageId,'55');assert.equal((await deliverGeneratedImage(args)).duplicate,true);assert.equal(calls,1);
  const bad={...args,key:'private:123',fetchImpl:async()=>{calls++;throw Error('timeout')}};
  await assert.rejects(deliverGeneratedImage(bad),/timeout/);await assert.rejects(deliverGeneratedImage(bad),/RECEIPT_UNKNOWN/);assert.equal(calls,2);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('real bridge endpoint enforces token, session, pause, tool switch, rate; records successful image',async()=>{
 const h=await bridgeHarness({config:{backend:'codex',socialV2:{enabled:true,send:{maxSendPerMinute:20}}}});
 h.setMode('reserved2');h.socialV2.paused=false;h.state.sessions['group:456']='thread-a';h.state.sessions['private:123']='thread-b';
 const st=h.getSocialV2State('group:456'),other=h.getSocialV2State('private:123');
 const dir=path.join(h.temp,'state/codex-home/generated_images/thread-a');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'image.png'),png);
 const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/api/socialV2/send-generated-image`;
 async function send(token=st.agentToken,body={key:'group:456',filePath:'image.png'}){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-call':'1',...(token?{'x-agent-token':token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 try{
  assert.equal((await send('')).status,403);assert.equal((await send(other.agentToken)).status,403);
  h.socialV2.paused=true;assert.equal((await send()).status,403);h.socialV2.paused=false;
  h.cfg.socialV2.tools.sendGeneratedImage=false;assert.equal((await send()).status,403);h.cfg.socialV2.tools.sendGeneratedImage=true;
  assert.equal((await send(st.agentToken,{key:'group:456',filePath:'../thread-b/image.png'})).data.error,'GENERATED_IMAGE_OUTSIDE_SESSION');
  st.sendTimes=Array(20).fill(Date.now());assert.equal((await send()).data.error,'IMAGE_SEND_RATE_LIMIT');st.sendTimes=[];
  const sent=await send();assert.equal(sent.status,200,JSON.stringify(sent));assert.equal(sent.data.messageId,'9001');
  const repeat=await send();assert.equal(repeat.data.duplicate,true);
  assert.equal(h.calls.http.filter(c=>c.url.endsWith('/send_group_msg')).length,1);
  assert.equal(st.recentMessages.at(-1).hasMedia,true);
 }finally{await new Promise(r=>server.close(r));await h.close();}
});
