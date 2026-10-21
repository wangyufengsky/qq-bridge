import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

let serial = 0;
async function fixture(t, systemAnswers, answer) {
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => systemAnswers;
  let mod;
  try {
    mod = await import(new URL(`../src/safe-fetch.js?test=${++serial}`, import.meta.url));
  } finally { dns.promises.lookup = original; }
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough();
      res.complete = true;
      res.statusCode = 200;
      res.headers = {};
      const query = new URL(options.path, 'https://cloudflare-dns.com');
      const type = query.searchParams.get('type') === 'AAAA' ? 28 : 1;
      const name = query.searchParams.get('name');
      const result = answer({ options, type, name, res });
      callback(res);
      if (!res.destroyed) res.end(typeof result === 'string' ? result : JSON.stringify(result));
    });
    return req;
  });
  return { mod, calls };
}
const fake = [{ address: '198.18.0.48', family: 4 }];
const publicAnswers = ({ type, name }) => ({
  Status: 0, Question: [{ name, type }],
  Answer: type === 1 ? [{ type, data: '93.184.216.34' }] : [],
});

test('Fake-IP resolves via pinned HTTPS DNS then pins the actual HTTPS connection', async t => {
  const { mod, calls } = await fixture(t, fake, args =>
    args.options.servername === 'cloudflare-dns.com' ? publicAnswers(args) : 'public page');
  const result = await mod.safeFetch('https://public.test/');
  assert.equal(result.body, 'public page');
  assert.equal(calls.length, 3);
  for (const options of calls.slice(0, 2)) {
    assert.equal(options.hostname, '1.1.1.1');
    assert.equal(options.servername, 'cloudflare-dns.com');
    assert.equal(options.rejectUnauthorized, true);
  }
  assert.equal(calls[2].hostname, '93.184.216.34');
  assert.equal(calls[2].servername, 'public.test');
  assert.equal(calls[2].rejectUnauthorized, true);
});

test('normal public DNS and existing QQ media route are preserved', async t => {
  const { mod, calls } = await fixture(t, fake, publicAnswers);
  assert.deepEqual(await mod.resolveSafeAddresses('p.qpic.cn'), ['198.18.0.48']);
  assert.equal(calls.length, 0);
  const normal = await fixture(t, [{ address: '93.184.216.34', family: 4 }], publicAnswers);
  assert.deepEqual(await normal.mod.resolveSafeAddresses('public.test'), ['93.184.216.34']);
  assert.equal(normal.calls.length, 0);
});

test('private literals and local names are rejected without outgoing requests', async t => {
  const { mod, calls } = await fixture(t, fake, publicAnswers);
  for (const host of ['localhost', 'x.local', '127.0.0.1', '192.168.1.1', '10.0.0.1',
    '169.254.169.254', '198.18.0.1', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(mod.resolveSafeAddresses(host), /内网|本机/);
  }
  assert.equal(calls.length, 0);
});

test('mixed genuine private and Fake-IP answer cannot trigger fallback', async t => {
  const { mod, calls } = await fixture(t, [...fake, { address: '192.168.1.1', family: 4 }], publicAnswers);
  await assert.rejects(mod.resolveSafeAddresses('public.test'), /内网/);
  assert.equal(calls.length, 0);
});

test('all DoH addresses are checked including private AAAA mixed with public A', async t => {
  const { mod } = await fixture(t, fake, ({ type, name }) => ({
    Status: 0, Question: [{ name, type }],
    Answer: [{ type, data: type === 1 ? '93.184.216.34' : '::1' }],
  }));
  await assert.rejects(mod.resolveSafeAddresses('public.test'), /非公网/);
});

test('DoH Fake-IP response is rejected rather than recursively allowed', async t => {
  const { mod } = await fixture(t, fake, ({ type, name }) => ({
    Status: 0, Question: [{ name, type }],
    Answer: type === 1 ? [{ type, data: '198.18.0.9' }] : [],
  }));
  await assert.rejects(mod.resolveSafeAddresses('public.test'), /非公网/);
});

for (const [label, transform] of [
  ['malformed JSON', () => '{'],
  ['mismatched question', r => ({ ...r, Question: [{ name: 'other.test', type: 1 }] })],
  ['invalid address', r => ({ ...r, Answer: [{ type: 1, data: 'not-an-ip' }] })],
  ['failed AAAA query', (r, type) => type === 28 ? { ...r, Status: 2 } : r],
  ['truncated DNS response', r => ({ ...r, TC: true })],
  ['empty answer', r => ({ ...r, Answer: [] })],
]) {
  test(`fails closed on ${label}`, async t => {
    const { mod } = await fixture(t, fake, args => transform(publicAnswers(args), args.type));
    await assert.rejects(mod.resolveSafeAddresses('public.test'), /公网 DNS 解析失败/);
  });
}

test('HTTPS DNS redirects are rejected', async t => {
  const { mod, calls } = await fixture(t, fake, ({ res }) => {
    res.statusCode = 302;
    res.headers.location = 'http://127.0.0.1/';
    return '';
  });
  await assert.rejects(mod.resolveSafeAddresses('public.test'), /HTTP 302/);
  assert.ok(calls.every(c => ['1.1.1.1', '1.0.0.1'].includes(c.hostname)));
});

test('public page redirect to local address is rejected', async t => {
  const { mod, calls } = await fixture(t, fake, args => {
    if (args.options.servername === 'cloudflare-dns.com') return publicAnswers(args);
    args.res.statusCode = 302;
    args.res.headers.location = 'http://127.0.0.1/';
    return '';
  });
  await assert.rejects(mod.safeFetch('https://public.test/'), /内网|本机/);
  assert.equal(calls.length, 3);
});
