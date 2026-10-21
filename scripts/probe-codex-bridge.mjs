// Protocol-only probe: no inference and no QQ messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexRpc} from '../src/backends/codex-rpc.mjs';
import {CODEX_RESTRICTIONS} from '../src/backends/codex-client.mjs';
import {McpTools} from '../src/backends/mcp-tools.mjs';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-codex-protocol-'));
const rpc=new CodexRpc({cwd:temporary,env:{...process.env,CODEX_HOME:temporary},
  args:['app-server','--stdio',...Object.entries(CODEX_RESTRICTIONS).flatMap(([k,v])=>['-c',`${k}=${JSON.stringify(v)}`])]});
const tools=new McpTools([{name:'social-reader',command:process.execPath,args:[path.join(root,'packages/social-reader/src/server.mjs')],
  allowedTools:['social_search','social_read','social_comments','social_status']}]);
try{
  await rpc.start();
  const auth=await rpc.request('account/read',{refreshToken:false});
  const catalog=await rpc.request('model/list',{});
  const specs=await tools.connect();
  const thread=await rpc.request('thread/start',{cwd:temporary,sandbox:'read-only',approvalPolicy:'never',
    baseInstructions:'你是 QQ 群聊工具协议检查实例。',dynamicTools:specs,config:CODEX_RESTRICTIONS,experimentalRawEvents:false});
  console.log(JSON.stringify({initialized:true,accountPresent:!!auth.account,modelCatalogCount:catalog.data.length,
    dynamicToolThreadCreated:!!thread.thread.id,tools:specs.map(s=>s.name),modelTurnTested:false,qqSendTested:false},null,2));
}finally{rpc.close();await tools.close();fs.rmSync(temporary,{recursive:true,force:true});}
