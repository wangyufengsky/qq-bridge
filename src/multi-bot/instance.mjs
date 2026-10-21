import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

export function validateBots(config) {
  const bots=config.bots;if(!Array.isArray(bots)||!bots.length)throw new Error('BOTS_REQUIRED');
  const ids=new Set(),ports=new Set(),accounts=new Set(),dirs=new Set(),endpoints=new Set();
  for(const b of bots) {
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(b.id)||ids.has(b.id))throw new Error('INVALID_OR_DUPLICATE_BOT_ID');ids.add(b.id);
    if(!['dsh','codex'].includes(b.backend))throw new Error('INVALID_BACKEND');
    if(!Number.isInteger(b.consolePort)||b.consolePort<1024||b.consolePort>65535||ports.has(b.consolePort)||b.consolePort===config.port)throw new Error('INVALID_OR_DUPLICATE_PORT');ports.add(b.consolePort);
    if(b.accountId){if(!/^\d{5,20}$/.test(String(b.accountId))||accounts.has(String(b.accountId)))throw new Error('INVALID_OR_DUPLICATE_QQ');accounts.add(String(b.accountId));}
    const dir=path.resolve(b.instanceDir);if(dirs.has(dir))throw new Error('DUPLICATE_INSTANCE');dirs.add(dir);
    for(const [key,protocol] of [['httpUrl','http:'],['wsUrl','ws:']]) {
      const raw=b.snowluma?.[key];if(!raw)throw new Error('ONEBOT_ENDPOINT_REQUIRED');
      const url=new URL(raw);if(url.protocol!==protocol||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw new Error('ONEBOT_MUST_BE_LOOPBACK');
      const canonical=`${protocol}//127.0.0.1:${url.port||'80'}`;
      if(endpoints.has(canonical))throw new Error('DUPLICATE_ONEBOT_ENDPOINT');endpoints.add(canonical);
    }
  }
  return bots;
}
/** Create only missing instance files. Never copy another bot's state or private credentials. */
export function prepareInstance({bot,codeRoot,managerUrl,managerToken}) {
  const root=path.resolve(bot.instanceDir);fs.mkdirSync(root,{recursive:true,mode:0o700});
  for(const name of ['state','roles','audio'])fs.mkdirSync(path.join(root,name),{recursive:true,mode:0o700});
  for(const name of ['public','assets','dsh']) {
    const dest=path.join(root,name);if(!fs.existsSync(dest))fs.cpSync(path.join(codeRoot,name),dest,{recursive:true});
  }
  const file=path.join(root,'config.json');
  const existing=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):JSON.parse(fs.readFileSync(path.join(codeRoot,'config.example.json'),'utf8'));
  const config={...existing,backend:bot.backend,botId:bot.id,accountId:String(bot.accountId||''),
    consolePort:bot.consolePort,consoleToken:existing.consoleToken||randomBytes(32).toString('hex'),
    snowluma:{...bot.snowluma,followDiscoveredEndpoint:false},
    dsh:{...existing.dsh,...bot.dsh},codex:{...bot.codex,...(bot.codex?.socialReaderEntry?{socialReaderEntry:path.resolve(codeRoot,bot.codex.socialReaderEntry)}:{})},
    allow:fs.existsSync(file) ? (existing.allow || bot.allow || {groups:[],private:[]}) : (bot.allow || {groups:[],private:[]}),allowAllWhenEmpty:false,
    multiBot:{managerUrl,managerToken,botId:bot.id},slang:{...existing.slang,enabled:false},
    ackMessage:'',socialV2:{...existing.socialV2,enabled:true,agentPreset:'qq-chat-v2'}};
  if(bot.backend==='codex')config.dsh={...config.dsh,provider:'codex',model:bot.codex?.model||'',reasoningEffort:bot.codex?.effort||'medium'};
  fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  const mode=path.join(root,'state/mode.json');if(!fs.existsSync(mode))fs.writeFileSync(mode,JSON.stringify({mode:'reserved2'}));
  return config;
}
