import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const aliases={'snowluma':'qq','web-search-safe':'web','social-reader':'social'};
export function codexToolPrompt(text) {
  let result=String(text);
  for(const [server,alias] of Object.entries(aliases))result=result.replaceAll(`mcp__${server}__`,`${alias}__`);
  return result;
}
/** Fixed server inventory supplied by the local administrator, never by a QQ message. */
export class McpTools {
  constructor(servers) { this.servers=servers; this.clients=[]; this.routes=new Map(); }
  async connect() {
    try {
      for(const server of this.servers) {
        const client=new Client({name:'qq-codex-tool-router',version:'0.3.0'});
        const transport=new StdioClientTransport({command:server.command,args:server.args,env:server.env,stderr:'pipe'});
        this.clients.push(client); await client.connect(transport);
        transport.stderr?.on('data',()=>{});
        let cursor;
        do {
          const page=await client.listTools(cursor?{cursor}:undefined);
          for(const tool of page.tools) {
            if(server.allowedTools && !server.allowedTools.includes(tool.name))continue;
            if(!aliases[server.name])throw new Error('UNSUPPORTED_TOOL_SERVER');
            const name=`${aliases[server.name]}__${tool.name}`;
            if(this.routes.has(name))throw new Error('DUPLICATE_TOOL');
            this.routes.set(name,{client,tool,server});
          }
          cursor=page.nextCursor;
        }while(cursor);
      }
      return this.specs();
    }catch(error){await this.close();throw error;}
  }
  specs() { return [...this.routes].map(([name,{tool}])=>({name,description:codexToolPrompt(tool.description||name),inputSchema:tool.inputSchema})); }
  originalName(name) { const r=this.routes.get(name);return r?`mcp__${r.server.name}__${r.tool.name}`:name; }
  async call(name,args) {
    const route=this.routes.get(name);if(!route)throw new Error('TOOL_NOT_ALLOWED');
    return route.client.callTool({name:route.tool.name,arguments:args},undefined,{timeout:900000});
  }
  async close() { await Promise.allSettled(this.clients.map(c=>c.close()));this.clients=[];this.routes.clear(); }
}
