#!/usr/bin/env node
// 打印当前运行中的 DSH Web URL，供「启动.command」使用。
//
// 桌面版 DSH 每次启动会随机挑一个本地端口，所以不能把 51430 写死。
// 优先读 dsh-relay 插件维护的 relay-endpoint.json（并做一次探活，避免端口已变），
// 读不到/已失效时用 lsof 在 DSH 进程的监听端口里找。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

async function alive(url) {
  try {
    // 401 也算活着：DSH 要求鉴权，但服务在监听。
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

let url = '';
try {
  const p = path.join(os.homedir(), '.dsh/plugins/dsh-relay/web/relay-endpoint.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (typeof j?.hostWebUrl === 'string') url = j.hostWebUrl.replace(/\/+$/, '');
} catch {}

if (url && await alive(url)) {
  console.log(url);
  process.exit(0);
}

url = '';
try {
  const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    if (!/DeepSeek/i.test(line)) continue;
    const m = line.match(/127\.0\.0\.1:(\d+)/);
    if (m) {
      url = `http://127.0.0.1:${m[1]}`;
      break;
    }
  }
} catch {}

if (url) console.log(url);
