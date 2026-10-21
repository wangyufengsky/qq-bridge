import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {CodexRpc} from '../../src/backends/codex-rpc.mjs';
import {CodexClient,CODEX_RESTRICTIONS} from '../../src/backends/codex-client.mjs';
import {BanterCoordinator} from '../../src/multi-bot/banter.mjs';
import {validateBots,prepareInstance} from '../../src/multi-bot/instance.mjs';
import {createManager} from '../../src/multi-bot/manager.mjs';
import {codexToolPrompt} from '../../src/backends/mcp-tools.mjs';
import {withBrowserLock} from '../../packages/social-reader/src/browser-lock.mjs';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-dual-test-'));
const codeRoot=path.resolve('.');
function bot(id,port,accountId='10001'){return {id,backend:'codex',instanceDir:path.join(temp(),id),consolePort:port,accountId,
  snowluma:{httpUrl:`http://127.0.0.1:${port+100}`,wsUrl:`ws://127.0.0.1:${port+101}`}};}
class FakeRpc extends EventEmitter {
  constructor(){super();this.calls=[];this.responses=[];this.n=0;}
  async start(){}
  async request(method,params){
    this.calls.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='model/list')return {data:[{model:'test-model',isDefault:true}]};
    if(method==='thread/start')return {thread:{id:'thread-'+ ++this.n}};
    if(method==='thread/resume'){if(this.failResume)throw Error('resume failed');return {thread:{id:params.threadId}};}
    if(method==='turn/start'){
      const id='turn-'+ ++this.n;
      this.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn:{id}}});
      if(this.autoEnd)this.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}});
      return {turn:{id}};
    }
    if(method==='turn/interrupt')this.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}});
    return {};
  }
  respond(id,result){this.responses.push({id,result});}
  reject(id){this.responses.push({id,rejected:true});}
  close(){}
}
function client(rpc=new FakeRpc()){
  const tools={specs:()=>[{name:'qq__qq_send_message',description:'send',inputSchema:{type:'object'}}],
    originalName:name=>name.replace('qq__','mcp__snowluma__'),
    async call(name){if(name!=='qq__qq_send_message')throw Error('denied');return {content:[{type:'text',text:'sent'}]};},async close(){}};
  return new CodexClient({root:codeRoot,codeRoot,config:{},rpc,tools});
}
test('account validation rejects shared identities, ports and endpoint aliases',()=>{
  const a=bot('a',3201),b=bot('b',3211,'10002');
  assert.equal(validateBots({bots:[a,b]}).length,2);
  assert.throws(()=>validateBots({bots:[a,{...b,accountId:a.accountId}]}),/DUPLICATE_QQ/);
  assert.throws(()=>validateBots({bots:[a,{...b,instanceDir:a.instanceDir}]}),/DUPLICATE_INSTANCE/);
  assert.throws(()=>validateBots({bots:[a,{...b,snowluma:{...b.snowluma,httpUrl:a.snowluma.httpUrl.replace('127.0.0.1','localhost')}}]}),/DUPLICATE_ONEBOT/);
});
test('instance creation preserves roles, separates tokens, and disables endpoint following',()=>{
  const a=bot('a',3201),b=bot('b',3211,'10002');
  const args={codeRoot,managerUrl:'http://127.0.0.1:3110',managerToken:'test'};
  const ca=prepareInstance({...args,bot:a}),cb=prepareInstance({...args,bot:b});
  assert.notEqual(ca.consoleToken,cb.consoleToken);assert.equal(ca.snowluma.followDiscoveredEndpoint,false);
  fs.writeFileSync(path.join(a.instanceDir,'roles/private.md'),'私人人格');
  const changed={...ca,allow:{groups:['456'],private:['123']}};fs.writeFileSync(path.join(a.instanceDir,'config.json'),JSON.stringify(changed));
  prepareInstance({...args,bot:a});assert.equal(fs.readFileSync(path.join(a.instanceDir,'roles/private.md'),'utf8'),'私人人格');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.instanceDir,'config.json'))).allow,changed.allow);
  assert.equal(fs.existsSync(path.join(b.instanceDir,'roles/private.md')),false);
});
test('banter permits peers, deduplicates observations, cools down, and resets on human input',()=>{
  let now=0;const c=new BanterCoordinator({botIds:['1','2'],maxMessages:2,cooldownMs:1000,clock:()=>now});
  const e=(messageId,senderId='1')=>c.observe({groupId:'g',messageId,senderId});
  assert.equal(e('a').allow,true);assert.equal(e('a').duplicate,true);assert.equal(e('b','2').allow,true);
  assert.equal(e('c').allow,false);assert.equal(e('d','2').allow,false);
  now=1001;assert.equal(e('e').allow,true);assert.equal(e('f','human').count,0);
  c.paused=true;assert.equal(e('g','human').allow,false);
});
test('Codex uses dedicated read-only thread instructions and rejects non-QQ preset',async()=>{
  const c=client();await assert.rejects(c.create({agentPreset:'standard'}),/REQUIRES/);
  await c.create({agentPreset:'qq-chat-v2'});
  const p=c.rpc.calls.find(x=>x.method==='thread/start').params;
  assert.equal(p.sandbox,'read-only');assert.equal(p.approvalPolicy,'never');
  assert.equal(p.config['features.shell_tool'],false);assert.ok(p.baseInstructions.includes('不会自动发送到 QQ'));
  assert.deepEqual(p.dynamicTools.map(t=>t.name),['qq__qq_send_message']);
  assert.ok(p.baseInstructions.includes('qq__qq_send_message'));
  assert.equal(codexToolPrompt('mcp__social-reader__social_read'),'social__social_read');
});
test('Codex serializes turns and handles completion before start receipt without duplicate text',async()=>{
  const c=client();const id=(await c.create({agentPreset:'qq-chat-v2'})).result.value.sessionId;
  await c.prompt({sessionId:id,content:[{type:'text',text:'one'}]});
  await c.prompt({sessionId:id,content:[{type:'text',text:'two'}]});await sleep(5);
  assert.equal(c.rpc.calls.filter(x=>x.method==='turn/start').length,1);
  const turn=c.getSession(id).active;
  c.rpc.emit('notification',{method:'item/completed',params:{threadId:id,turnId:turn,item:{type:'agentMessage',text:'hello'}}});
  c.rpc.autoEnd=true;c.rpc.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:turn,status:'completed'}}});
  await c.getSession(id).tail;
  assert.equal(c.rpc.calls.filter(x=>x.method==='turn/start').length,2);assert.equal(c.getSession(id).active,null);
  assert.equal(c.frames.filter(f=>f.payload.event.type==='assistant/message').length,1);
});
test('interrupt invalidates queued work and resumed failure emits terminal error',async()=>{
  const c=client();const id=(await c.create({agentPreset:'qq-chat-v2'})).result.value.sessionId;
  await c.prompt({sessionId:id,content:[]});await sleep(5);
  await c.prompt({sessionId:id,content:[]});await c.stopSessionWork(id);await c.getSession(id).tail;
  assert.equal(c.rpc.calls.filter(x=>x.method==='turn/start').length,1);
  c.rpc.failResume=true;await c.prompt({sessionId:'restored',content:[]});await c.getSession('restored').tail;
  assert.ok(c.frames.some(f=>f.payload.sessionId==='restored'&&f.payload.event.type==='turn/end'));
});
test('dynamic tools reject unknown methods and foreign thread/turn identities',async()=>{
  const c=client();await c.handleRequest({id:1,method:'item/commandExecution/requestApproval',params:{}});
  await c.handleRequest({id:2,method:'item/tool/call',params:{threadId:'foreign'}});
  const id=(await c.create({agentPreset:'qq-chat-v2'})).result.value.sessionId;c.getSession(id).active='t';
  await c.handleRequest({id:3,method:'item/tool/call',params:{threadId:id,turnId:'t',tool:'exec',arguments:{},callId:'c'}});
  assert.equal(c.rpc.responses[0].rejected,true);assert.equal(c.rpc.responses[1].rejected,true);assert.equal(c.rpc.responses[2].result.success,false);
  await c.handleRequest({id:4,method:'item/tool/call',params:{threadId:id,turnId:'t',tool:'qq__qq_send_message',arguments:{},callId:'d'}});
  assert.equal(c.rpc.responses[3].result.success,true);
  assert.ok(c.frames.some(f=>f.payload.event.type==='tool/call'&&f.payload.event.data.name==='mcp__snowluma__qq_send_message'));
});
test('RPC handles interleaved replies and reports unknown receipts without replay',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  let sent=[];child.stdin.on('data',b=>{sent.push(JSON.parse(b.toString()));});
  const rpc=new CodexRpc({spawnProcess:()=>child,timeoutMs:20});
  const init=rpc.start();await sleep(1);child.stdout.write(JSON.stringify({id:sent[0].id,result:{}})+'\n');await init;
  const a=rpc.request('a'),b=rpc.request('b');
  const ar=sent.find(x=>x.method==='a'),br=sent.find(x=>x.method==='b');
  child.stdout.write(JSON.stringify({id:br.id,result:2})+'\n'+JSON.stringify({id:ar.id,result:1})+'\n');
  assert.deepEqual(await Promise.all([a,b]),[1,2]);
  await assert.rejects(rpc.request('write'),/RECEIPT_UNKNOWN/);assert.equal(sent.filter(x=>x.method==='write').length,1);rpc.close();
});
test('browser lock releases on failure and enforces a bounded wait',async()=>{
  const lockPath=path.join(temp(),'lock');
  await assert.rejects(withBrowserLock(async()=>{throw Error('fail');},{lockPath,cooldownMs:0}),/fail/);
  assert.equal(fs.existsSync(lockPath),false);
  fs.mkdirSync(lockPath);
  await assert.rejects(withBrowserLock(()=>{}, {lockPath,timeoutMs:10,pollMs:5,cooldownMs:0}),/QUEUE_TIMEOUT/);
});
test('two MCP processes cannot overlap browser work',async()=>{
  const dir=temp(),lock=path.join(dir,'lock'),log=path.join(dir,'log');
  const moduleUrl=new URL('../../packages/social-reader/src/browser-lock.mjs',import.meta.url).href;
  const run=id=>new Promise((resolve,reject)=>{
    const source=`import fs from 'node:fs';import {withBrowserLock} from ${JSON.stringify(moduleUrl)};await withBrowserLock(async()=>{fs.appendFileSync(${JSON.stringify(log)},'${id} start\\n');await new Promise(r=>setTimeout(r,30));fs.appendFileSync(${JSON.stringify(log)},'${id} end\\n');},{lockPath:${JSON.stringify(lock)},cooldownMs:0,pollMs:5});`;
    const child=spawn(process.execPath,['--input-type=module','-e',source]);child.on('error',reject);child.on('exit',code=>code?reject(Error('child failed')):resolve());
  });
  await Promise.all([run('a'),run('b')]);const lines=fs.readFileSync(log,'utf8').trim().split('\n');
  assert.equal(lines[0][0],lines[1][0]);assert.equal(lines[2][0],lines[3][0]);assert.notEqual(lines[0][0],lines[2][0]);
});
test('manager is authenticated, does not auto-start, and refuses unconfigured account',async()=>{
  const b=bot('codex',3255,'');let spawned=0;
  const m=createManager({port:0,bots:[b]},{spawnProcess:()=>{spawned++;throw Error('must not spawn');}});
  const port=await m.listen(),base=`http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base+'/api/bots')).status,401);
    const h={'x-manager-token':m.token,'content-type':'application/json'};
    const data=await(await fetch(base+'/api/bots',{headers:h})).json();assert.equal(data.bots[0].running,false);
    const start=await fetch(base+'/api/bots/codex/start',{method:'POST',headers:h,body:'{}'});assert.equal(start.status,400);
    assert.equal(spawned,0);
    assert.equal((await fetch(base+'/internal/observe',{method:'POST',headers:h,body:'{}'})).status,401);
  }finally{await m.close();}
});
test('external DSH instance uses its token file and is never spawned or stopped by manager',async()=>{
  const existing=http.createServer((req,res)=>{
    if(req.headers['x-console-token']!=='test-token-from-file'){res.writeHead(401);res.end('{}');return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({dshReady:true,snowluma:{good:true},role:'existing'}));
  });
  await new Promise(r=>existing.listen(0,'127.0.0.1',r));
  const b=bot('dsh',existing.address().port);b.backend='dsh';b.external=true;
  fs.mkdirSync(path.join(b.instanceDir,'state'),{recursive:true});
  fs.writeFileSync(path.join(b.instanceDir,'config.json'),'{"consoleToken":""}');
  fs.writeFileSync(path.join(b.instanceDir,'state/console-token'),'test-token-from-file');
  const m=createManager({port:0,bots:[b]});const port=await m.listen();
  try{const data=await(await fetch(`http://127.0.0.1:${port}/api/bots`,{headers:{'x-manager-token':m.token}})).json();
    assert.equal(data.bots[0].running,true);assert.equal(data.bots[0].status.role,'existing');
  }finally{await m.close();await new Promise(r=>existing.close(r));}
});


test('Codex preset save and restore leave installed DSH presets untouched',async()=>{
  const {runtimePresetPath,syncPresetCopy}=await import('../../src/backends/preset-storage.mjs');
  const dir=temp(),source=path.join(dir,'instance.yml'),dshHome=path.join(dir,'dsh');
  const target=path.join(dshHome,'.agent-presets','qq-chat-v2','agent.cordis.yml');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'DSH original');
  const options={backend:'codex',source,dshHome,name:'qq-chat-v2'};
  for(const text of ['Codex edited','Codex restored']){
    fs.writeFileSync(source,text);assert.equal(syncPresetCopy(options),true);
    assert.equal(runtimePresetPath(options),source);
    assert.equal(fs.readFileSync(target,'utf8'),'DSH original');
  }
  syncPresetCopy({...options,backend:'dsh'});
  assert.equal(fs.readFileSync(target,'utf8'),'Codex restored');
  fs.rmSync(dir,{recursive:true,force:true});
});


test('uncertain turn receipt blocks replay and cancels queued turns',async()=>{
  const c=client();const id=(await c.create({agentPreset:'qq-chat-v2'})).result.value.sessionId;
  const original=c.rpc.request.bind(c.rpc);let starts=0;
  c.rpc.request=async(method,params)=>{if(method==='turn/start'){starts++;throw Error('CODEX_RECEIPT_UNKNOWN:turn/start');}return original(method,params);};
  await c.prompt({sessionId:id,content:[]});await c.getSession(id).tail;
  await assert.rejects(c.prompt({sessionId:id,content:[]}),/RECEIPT_UNKNOWN/);
  assert.equal(starts,1);assert.equal(c.getSession(id).uncertain,true);
});

test('process disconnect invalidates queued work and unrelated notifications are ignored',async()=>{
  const c=client();const id=(await c.create({agentPreset:'qq-chat-v2'})).result.value.sessionId;
  c.notification({method:'turn/started',params:{threadId:'foreign',turn:{id:'x'}}});
  assert.equal(c.sessionsState.has('foreign'),false);
  await c.prompt({sessionId:id,content:[]});await sleep(1);
  await c.prompt({sessionId:id,content:[]});c.rpc.emit('disconnected');
  await c.getSession(id).tail;
  assert.equal(c.rpc.calls.filter(x=>x.method==='turn/start').length,1);
  assert.equal(c.getSession(id).loaded,false);
});


test('real Codex console save and restore routes cannot alter a DSH installation',async()=>{
  const {bridgeHarness}=await import('../../scripts/audit-bridge-harness.mjs');
  const {extractPresetPrefix}=await import('../../src/preset-prompt.js');
  const dir=temp(),dshHome=path.join(dir,'dsh'),installed=path.join(dshHome,'.agent-presets/qq-chat-v2/agent.cordis.yml');
  fs.mkdirSync(path.dirname(installed),{recursive:true});fs.writeFileSync(installed,'LIVE DSH SENTINEL');
  const h=await bridgeHarness({config:{backend:'codex'},globals:{process:{pid:process.pid,platform:process.platform,kill:process.kill,env:{DSH_HOME:dshHome},once(){},exit(){throw Error('unexpected exit');}}}});
  let server;
  try{
    const source=fs.readFileSync(path.join(codeRoot,'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'),'utf8');
    const local=path.join(h.temp,'dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
    fs.mkdirSync(path.dirname(local),{recursive:true});fs.writeFileSync(local,source);
    server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}/api/preset/sim-prompt`;
    const call=async(suffix,body)=>{const r=await fetch(base+suffix,{method:body?'POST':'GET',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200);return r.json();};
    const prefix=extractPresetPrefix(source);await call('',{preset:'qq-chat-v2',content:prefix+'\n\n【实例测试】只修改当前机器人。'});
    assert.ok(fs.readFileSync(local,'utf8').includes('实例测试'));
    assert.equal(fs.readFileSync(installed,'utf8'),'LIVE DSH SENTINEL');
    const backups=await call('/backups?preset=qq-chat-v2');
    await call('/restore',{preset:'qq-chat-v2',file:backups.backups[0].file});
    assert.equal(fs.readFileSync(installed,'utf8'),'LIVE DSH SENTINEL');
    assert.equal(extractPresetPrefix(fs.readFileSync(local,'utf8')),prefix);
  }finally{if(server)await new Promise(r=>server.close(r));await h.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('fixed OneBot discovery preserves separate WS token and rejects wrong accounts/endpoints',async()=>{
  const {discoverSnowLumaConnection}=await import('../../src/snowluma-conn.js');
  let account='10001',otherHits=0;
  const gateway=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:account}}));});
  const other=http.createServer((req,res)=>{otherHits++;res.end('{}');});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));await new Promise(r=>other.listen(0,'127.0.0.1',r));
  const home=temp();fs.mkdirSync(path.join(home,'config'));
  fs.writeFileSync(path.join(home,'config/onebot_10002.json'),JSON.stringify({networks:{httpServers:[{host:'127.0.0.1',port:other.address().port,accessToken:'other'}]}}));
  const cfg={accountId:'10001',snowluma:{httpUrl:`http://127.0.0.1:${gateway.address().port}`,accessToken:'http-only',wsAccessToken:'ws-only',followDiscoveredEndpoint:false}};
  try{
    const good=await discoverSnowLumaConnection({cfg,homeDirs:[home]});assert.equal(good.ok,true);assert.equal(good.wsToken,'ws-only');
    account='10002';const bad=await discoverSnowLumaConnection({cfg,homeDirs:[home]});assert.equal(bad.ok,false);assert.equal(otherHits,0);
  }finally{await new Promise(r=>gateway.close(r));await new Promise(r=>other.close(r));fs.rmSync(home,{recursive:true,force:true});}
});

test('Codex startup preserves medium effort instead of DSH max',async()=>{
  const {bridgeHarness}=await import('../../scripts/audit-bridge-harness.mjs');
  const h=await bridgeHarness({config:{backend:'codex',dsh:{reasoningEffort:'medium'}}});
  try{assert.equal(h.cfg.dsh.reasoningEffort,'medium');}finally{await h.close();}
});
