#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const script=fileURLToPath(import.meta.url);
const root=path.dirname(path.dirname(script));
const state=path.join(root,'.runtime');
fs.mkdirSync(state,{recursive:true,mode:0o700});
const operationFile=path.join(state,'operation.lock');
let ownsOperation=false;
function lockOperation(){
  try{
    const old=JSON.parse(fs.readFileSync(operationFile,'utf8'));
    let live=true;
    try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')live=false;}
    if(live)throw Error('另一次启动或停止正在进行，请等待它完成');
    fs.unlinkSync(operationFile);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const fd=fs.openSync(operationFile,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);
  ownsOperation=true;
}
const settingsFile=path.join(root,'launcher.json');
if(!fs.existsSync(settingsFile)){
  console.error('请先复制 launcher.example.json 为 launcher.json，并填写本机路径与容器名称');
  process.exit(1);
}
const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
for(const key of ['fishRoot','dualRoot']) {
  if(typeof settings[key]!=='string'||!settings[key].trim())throw Error(`launcher.json 缺少 ${key}`);
  settings[key]=path.resolve(root,settings[key]);
}
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function write(p,value){
  const temp=p+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  fs.renameSync(temp,p);
}
const multiFile=path.join(settings.dualRoot,'multi-bot.json');
function load(){
  const m=read(multiFile);
  for(const b of m.bots){
    b.instanceDir=path.resolve(settings.dualRoot,b.instanceDir);
    // The instance console is the source of truth for user edits.
    const c=read(path.join(b.instanceDir,'config.json'));
    b.allow=c.allow;
    if(b.backend==='codex'){
      b.codex={...b.codex,...c.codex};
      if(b.codex.socialReaderEntry)b.codex.socialReaderEntry=path.resolve(settings.dualRoot,b.codex.socialReaderEntry);
    }
  }
  const tokenFile=path.join(settings.dualRoot,'state/manager-token');
  m.token=m.token||fs.readFileSync(tokenFile,'utf8').trim();
  return m;
}
const multi=load();
const bots=multi.bots;
const fish=bots.find(b=>b.id==='deepseek');
const dragon=bots.find(b=>b.id==='codex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function token(b){
  const c=read(path.join(b.instanceDir,'config.json'));
  return c.consoleToken||fs.readFileSync(path.join(b.instanceDir,'state/console-token'),'utf8').trim();
}
async function api(b,endpoint,body){
  const r=await fetch(`http://127.0.0.1:${b.consolePort}${endpoint}`,{
    method:body===undefined?'GET':'POST',
    headers:{'x-console-token':token(b),'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(4000)});
  if(!r.ok)throw Error(`${b.name} 控制台请求失败（${r.status}）`);
  return r.json();
}
async function snapshot(){
  return Promise.all(bots.map(async b=>{
    try{const s=await api(b,'/api/status');return {id:b.id,name:b.name,online:true,ready:s.dshReady,qqOnline:s.snowluma?.good===true,paused:s.socialV2Paused,role:s.role};}
    catch{return {id:b.id,name:b.name,online:false};}
  }));
}
function isManaged(pid){
  if(!Number.isSafeInteger(pid)||pid<2)return false;
  try{
    const cmd=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();
    return cmd.includes(script+' serve');
  }catch{return false;}
}
function managerPid(){
  try{const n=read(path.join(state,'supervisor.json')).pid;return isManaged(n)?n:null;}catch{return null;}
}
async function portBusy(port){
  return new Promise(resolve=>{
    const s=net.connect({host:'127.0.0.1',port});
    const done=v=>{s.destroy();resolve(v);};
    s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(700,()=>done(false));
  });
}
function openConsoles(){
  for(const b of bots){
    // Pass URLs as arguments, never through a shell; never print access tokens.
    execFileSync('/usr/bin/open',[`http://127.0.0.1:${b.consolePort}/?token=${encodeURIComponent(token(b))}`],{stdio:'ignore'});
  }
}
async function preflight(){
  execFileSync('docker',['info','--format','{{.ServerVersion}}'],{stdio:'pipe',timeout:10000});
  for(const name of settings.containers){
    const running=execFileSync('docker',['inspect','--format','{{.State.Running}}',name],{encoding:'utf8',timeout:10000}).trim();
    if(running!=='true')execFileSync('docker',['start',name],{stdio:'pipe',timeout:20000});
  }
  for(const b of bots){
    const c=read(path.join(b.instanceDir,'config.json'));
    let valid=false;
    for(let i=0;i<12;i++){
      try{
        const r=await fetch(c.snowluma.httpUrl.replace(/\/$/,'')+'/get_login_info',{headers:{Authorization:`Bearer ${c.snowluma.accessToken}`},signal:AbortSignal.timeout(2000)});
        const d=await r.json();
        if(d.status==='ok'&&d.data?.user_id){
          if(String(d.data.user_id)!==String(b.accountId))throw Error('ACCOUNT_MISMATCH');
          valid=true;break;
        }
      }catch(e){if(e.message==='ACCOUNT_MISMATCH')throw Error(`${b.name} 的 QQ 登录账号不匹配，已停止启动`);}
      await sleep(1000);
    }
    if(!valid)throw Error(`${b.name} 的 QQ 尚未登录，请先完成 QQ 登录再启动`);
  }
  const dsh=execFileSync(process.execPath,[path.join(settings.dualRoot,'scripts/dsh-url.mjs')],{cwd:settings.fishRoot,encoding:'utf8',timeout:12000}).trim().split('\n').at(-1);
  const url=new URL(dsh);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('DSH 不是本机地址');
  await fetch(url,{signal:AbortSignal.timeout(4000)});
  const cf=path.join(settings.fishRoot,'config.json');const c=read(cf);
  if(c.dsh.baseUrl!==dsh){
    fs.copyFileSync(cf,path.join(state,`fish-config-${Date.now()}.backup.json`));
    c.dsh.baseUrl=dsh;write(cf,c);
  }
}
async function serve(){
  let manager,fishChild,closing=false;
  write(path.join(state,'supervisor.json'),{pid:process.pid,startedAt:new Date().toISOString()});
  const intentsFile=path.join(state,'resume-state.json');
  const intentions=fs.existsSync(intentsFile)?read(intentsFile):Object.fromEntries(bots.map(b=>{
    const s=read(path.join(b.instanceDir,'state/social-v2.json'));
    return [b.id,{paused:s.paused===true}];
  }));
  async function close(code=0){
    if(closing)return;closing=true;
    // Save the states before manager.stop changes the pause flag.
    const current=await snapshot();
    for(const s of current)if(s.online)intentions[s.id]={paused:s.paused,role:s.role};
    write(intentsFile,intentions);
    for(const b of bots)await api(b,'/api/socialV2/activity',{paused:true}).catch(()=>{});
    await manager?.close().catch(()=>{});
    if(fishChild&&fishChild.exitCode===null){
      fishChild.kill('SIGTERM');
      await Promise.race([new Promise(r=>fishChild.once('exit',r)),sleep(5000)]);
      if(fishChild.exitCode===null)fishChild.kill('SIGKILL');
    }
    try{fs.unlinkSync(path.join(state,'supervisor.json'));}catch{}
    process.exit(code);
  }
  process.on('SIGTERM',()=>void close());
  process.on('SIGINT',()=>void close());
  try{
    const {createManager}=await import(pathToFileURL(path.join(settings.dualRoot,'src/multi-bot/manager.mjs')));
    manager=createManager(multi);await manager.listen();
    const fd=fs.openSync(path.join(state,'fish-process.log'),'a',0o600);
    fishChild=spawn(process.execPath,['src/bridge.js'],{cwd:settings.fishRoot,env:process.env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
    fishChild.on('error',()=>void close(1));
    const r=await fetch(`http://127.0.0.1:${multi.port}/api/bots/codex/start`,{method:'POST',headers:{'x-manager-token':multi.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
    if(!r.ok||!(await r.json()).ok)throw Error('大肥龙启动失败');
    for(let i=0;i<60;i++){
      if(closing)return;
      const rows=await snapshot();
      if(rows.every(s=>s.online&&s.ready&&s.qqOnline)){
        for(const b of bots)await api(b,'/api/socialV2/activity',{paused:intentions[b.id]?.paused===true});
        console.log('两位机器人已就绪');
        return;
      }
      if(fishChild.exitCode!==null)throw Error('大肥鱼进程提前退出');
      await sleep(1000);
    }
    throw Error('等待模型或 QQ 连接超时');
  }catch(e){
    console.error(e.message);
    // A failed start must not replace saved resume preferences with temporary pause flags.
    const saved=JSON.stringify(intentions);
    if(manager)await manager.close().catch(()=>{});
    if(fishChild?.exitCode===null)fishChild.kill('SIGTERM');
    write(intentsFile,JSON.parse(saved));
    try{fs.unlinkSync(path.join(state,'supervisor.json'));}catch{}
    process.exit(1);
  }
}
async function main(){
  const command=process.argv[2]||'start';
  if(command==='serve')return serve();
  if(command==='status'){console.log(JSON.stringify(await snapshot(),null,2));return;}
  lockOperation();
  if(command==='stop'){
    const pid=managerPid();
    if(!pid){
      if((await snapshot()).some(s=>s.online))throw Error('存在由旧入口启动的实例；本脚本拒绝误杀，请先关闭旧入口');
      console.log('两个机器人已经停止');return;
    }
    process.kill(pid,'SIGTERM');
    for(let i=0;i<20;i++){if(!managerPid()){console.log('两个机器人已停止；DSH、Codex 和 QQ 容器保留运行');return;}await sleep(1000);}
    throw Error('停止尚未完成，请检查 .runtime/supervisor.log');
  }
  if(command!=='start')throw Error('用法：node scripts/robots.mjs start|stop|status [--no-open]');
  if(managerPid()){
    const rows=await snapshot();
    if(!rows.every(s=>s.online&&s.ready&&s.qqOnline))throw Error('统一入口正在运行，但有实例尚未就绪；请先查看状态');
    console.log('两个机器人已运行，复用现有进程');
    if(!process.argv.includes('--no-open'))openConsoles();
    return;
  }
  for(const port of [multi.port,...bots.map(b=>b.consolePort)])if(await portBusy(port))throw Error(`端口 ${port} 已占用，请先停止旧启动入口`);
  console.log('检查 DSH、Docker 和两个 QQ 登录状态…');
  await preflight();
  const fd=fs.openSync(path.join(state,'supervisor.log'),'a',0o600);
  const child=spawn(process.execPath,[script,'serve'],{cwd:root,env:process.env,detached:true,stdio:['ignore',fd,fd]});
  fs.closeSync(fd);child.unref();
  for(let i=0;i<75;i++){
    const rows=await snapshot();
    if(rows.every(s=>s.online&&s.ready&&s.qqOnline)){
      // Supervisor restores pause preferences immediately after readiness.
      await sleep(1000);
      console.log('大肥鱼和大肥龙已启动。管理台：3100 / 3112');
      if(!process.argv.includes('--no-open'))openConsoles();
      return;
    }
    try{process.kill(child.pid,0);}catch{throw Error('启动进程已退出，请查看 .runtime/supervisor.log');}
    await sleep(1000);
  }
  throw Error('启动超时，请查看 .runtime/supervisor.log');
}
main().catch(e=>{console.error(`启动器：${e.message}`);process.exitCode=1;})
  .finally(()=>{if(ownsOperation)try{fs.unlinkSync(operationFile);}catch{}});
