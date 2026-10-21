import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {validateBots,prepareInstance} from './instance.mjs';
import {BanterCoordinator} from './banter.mjs';

const codeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function createManager(config,{spawnProcess=spawn}={}) {
  const bots=validateBots(config), children=new Map(),failures=new Map(),busy=new Set();
  const token=config.token||randomBytes(32).toString('hex');
  const coordinatorToken=randomBytes(32).toString('hex');
  const banter=new BanterCoordinator({botIds:bots.map(b=>b.accountId).filter(Boolean),...config.banter});
  let actualPort=config.port??3110,globalPaused=false;
  const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
  const localConfig=b=>JSON.parse(fs.readFileSync(path.join(b.instanceDir,'config.json'),'utf8'));
  const instanceToken=b=>{
    const configured=String(localConfig(b).consoleToken||'').trim();
    if(/^[A-Za-z0-9_-]{16,128}$/.test(configured))return configured;
    return fs.readFileSync(path.join(b.instanceDir,'state/console-token'),'utf8').trim();
  };
  async function control(b,endpoint,body){
    const r=await fetch(`http://127.0.0.1:${b.consolePort}${endpoint}`,{method:body?'POST':'GET',
      headers:{'x-console-token':instanceToken(b),'content-type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2500)});
    if(!r.ok)throw new Error('INSTANCE_UNAVAILABLE');return r.json();
  }
  async function start(b) {
    if(b.external)throw new Error('现有实例通过原启动方式管理；此处可暂停发言');
    if(globalPaused)throw new Error('请先解除全局暂停');
    if(b.backend==='dsh')throw new Error('DSH 首版接入现有实例，请配置 external:true');
    if(children.has(b.id))return;
    if(!b.accountId)throw new Error('请先在 multi-bot.json 配置第二个 QQ 号和 OneBot 连接');
    prepareInstance({bot:b,codeRoot,managerUrl:`http://127.0.0.1:${actualPort}`,managerToken:coordinatorToken});
    const output=fs.openSync(path.join(b.instanceDir,'state/worker.log'),'a',0o600);
    let child;
    try{child=spawnProcess(process.execPath,[path.join(codeRoot,'src/bridge.js')],{
      cwd:codeRoot,env:{...process.env,QQ_BRIDGE_INSTANCE_DIR:path.resolve(b.instanceDir)},stdio:['ignore',output,output]});}
    finally{fs.closeSync(output);}
    children.set(b.id,child);failures.delete(b.id);
    const finish=()=>{if(children.get(b.id)===child){children.delete(b.id);failures.set(b.id,'进程已退出，请查看该实例日志');}};
    child.once('exit',finish);child.once('error',finish);
  }
  async function stop(b){
    if(b.external)return;
    const child=children.get(b.id);if(!child)return;
    // Existing bridge's pause gate rejects late sending tools before the worker exits.
    await control(b,'/api/socialV2/activity',{paused:true}).catch(()=>{});
    await new Promise(resolve=>{
      child.once('exit',resolve);child.kill('SIGTERM');
      const timer=setTimeout(()=>{if(children.get(b.id)===child)child.kill('SIGKILL');resolve();},5000);
      child.once('exit',()=>clearTimeout(timer));
    });
    children.delete(b.id);failures.delete(b.id);
  }
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const send=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
    try {
      if(req.method==='GET'&&url.pathname==='/'){
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
          'referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*"});
        res.end(fs.readFileSync(path.join(codeRoot,'public/multi-bot.html'),'utf8'));return;
      }
      const provided=req.headers['x-manager-token'];
      if(url.pathname==='/internal/observe'){
        if(!equal(provided,coordinatorToken))return send({error:'UNAUTHORIZED'},401);
      }else if(!equal(provided,token))return send({error:'UNAUTHORIZED'},401);
      let body={};if(req.method==='POST'){
        let chunks='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw new Error('BODY_TOO_LARGE');chunks+=chunk;}body=JSON.parse(chunks||'{}');
      }
      if(req.method==='POST'&&url.pathname==='/internal/observe'){
        if(!bots.some(b=>b.id===body.botId))return send({error:'UNKNOWN_BOT'},403);
        return send(banter.observe(body));
      }
      if(req.method==='GET'&&url.pathname==='/api/bots'){
        const rows=await Promise.all(bots.map(async b=>{
          let status=null;if(children.has(b.id)||b.external)try{const s=await control(b,'/api/status');status={ready:s.dshReady,online:s.snowluma?.good,paused:s.socialV2Paused,role:s.role};}catch{}
          return {id:b.id,name:b.name||b.id,backend:b.backend,external:!!b.external,running:children.has(b.id)||(!!b.external&&!!status),status,error:failures.get(b.id)||null,configured:!!b.accountId};
        }));return send({bots:rows,paused:globalPaused,banter:config.banter||{}});
      }
      if(req.method==='POST'&&url.pathname==='/api/pause-all'){
        globalPaused=body.paused!==false;banter.paused=globalPaused;
        const results=await Promise.allSettled(bots.filter(b=>children.has(b.id)||b.external).map(b=>control(b,'/api/socialV2/activity',{paused:globalPaused})));
        return send({ok:results.every(r=>r.status==='fulfilled'),paused:globalPaused});
      }
      const match=url.pathname.match(/^\/api\/bots\/([a-z][a-z0-9-]*)\/(start|stop|pause|resume|console)$/);
      if(req.method==='POST'&&match){
        const b=bots.find(b=>b.id===match[1]);if(!b)return send({error:'UNKNOWN_BOT'},404);
        if(busy.has(b.id))return send({error:'操作正在进行'},409);busy.add(b.id);
        try{
          const action=match[2];
          if(action==='start')await start(b);
          if(action==='stop')await stop(b);
          if(action==='pause'||action==='resume'){
            if(action==='resume'&&globalPaused)throw new Error('请先解除全局暂停');
            await control(b,'/api/socialV2/activity',{paused:action==='pause'});
          }
          if(action==='console'){
            if(!children.has(b.id)&&!b.external)throw new Error('机器人未启动');
            return send({url:`http://127.0.0.1:${b.consolePort}/?token=${encodeURIComponent(instanceToken(b))}`});
          }
          return send({ok:true});
        }finally{busy.delete(b.id);}
      }
      send({error:'NOT_FOUND'},404);
    }catch(error){send({error:error.message},400);}
  });
  return {server,token,children,async listen(){await new Promise((r,j)=>{server.once('error',j);server.listen(actualPort,'127.0.0.1',r);});actualPort=server.address().port;return actualPort;},
    async close(){globalPaused=true;banter.paused=true;await Promise.all(bots.map(stop));await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const configFile=path.resolve(process.argv[2]||'multi-bot.json');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  config.bots.forEach(b=>{b.instanceDir=path.resolve(path.dirname(configFile),b.instanceDir);});
  const tokenFile=path.join(path.dirname(configFile),'state','manager-token');
  if(!config.token&&fs.existsSync(tokenFile)){
    const saved=fs.readFileSync(tokenFile,'utf8').trim();
    if(/^[a-f0-9]{64}$/.test(saved))config.token=saved;
  }
  const manager=createManager(config);const port=await manager.listen();
  fs.mkdirSync(path.dirname(tokenFile),{recursive:true,mode:0o700});fs.writeFileSync(tokenFile,manager.token,{mode:0o600});
  console.log(`双 AI 管理台 http://127.0.0.1:${port}（令牌保存在 state/manager-token）`);
  process.on('SIGTERM',()=>manager.close().then(()=>process.exit(0)));
  process.on('SIGINT',()=>manager.close().then(()=>process.exit(0)));
}
