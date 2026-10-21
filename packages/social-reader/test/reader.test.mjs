import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialReader, commandFor, contentUrl, queryText, parseIndexedResults, classify, scrub, feedRoute } from '../src/reader.mjs';
import { isPrivateIp } from '../src/safe-fetch.js';

const bili = 'https://www.bilibili.com/video/BV1sgMy6XEKN';
test('arguments remain one literal query, never a shell program or arbitrary subcommand', () => {
  const q = 'a; $(touch /tmp/never-run) `whoami`';
  const args = commandFor('bilibili', 'search', q, 2);
  assert.equal(args[2], q);
  assert.throws(() => commandFor('bilibili','delete',bili), /INVALID_OPERATION/);
  assert.throws(() => queryText('--execute'), /INVALID_QUERY/);
  assert.throws(() => commandFor('__proto__', 'search', 'x'), /INVALID_PLATFORM/);
  assert.throws(() => commandFor('bilibili','search','x',1000), /INVALID_LIMIT/);
});
test('URL allowlist rejects private endpoints, lookalike domains and credential input', () => {
  for (const url of ['http://127.0.0.1/', 'https://bilibili.com.evil.test/video/BV1sgMy6XEKN',
    'https://a:b@www.bilibili.com/video/BV1sgMy6XEKN','https://www.bilibili.com:444/video/BV1sgMy6XEKN',
    'https://www.bilibili.com/account','file:///etc/passwd','https://127.0.0.1/video/BV1sgMy6XEKN']) {
    assert.throws(() => contentUrl('bilibili',url));
  }
  assert.equal(contentUrl('bilibili',bili+'?redirect=http://localhost&access_token=secret').href,bili);
});
test('platform command mapping and XHS public proof', () => {
  assert.deepEqual(commandFor('zhihu','comments','https://www.zhihu.com/question/123/answer/456',3).slice(0,7),
    ['zhihu','answer-comments','456','--limit','3','--replies-limit','2']);
  assert.equal(commandFor('twitter','read','https://x.com/user/status/12345')[1], 'thread');
  assert.equal(commandFor('weibo','read','https://weibo.com/123/AbCd')[2], 'AbCd');
  assert.throws(() => commandFor('weibo','comments','https://weibo.com/123/AbCd'), /NUMERIC/);
  const note='https://www.xiaohongshu.com/explore/0123456789abcdef01234567';
  assert.throws(() => commandFor('xiaohongshu','read',note), /XHS_SEARCH/);
  assert.ok(commandFor('xiaohongshu','read',note+'?xsec_token=abc')[2].endsWith('?xsec_token=abc'));
});
test('search fallback labels excerpts and filters off-platform / private results', async () => {
  const calls=[];
  const run=async(file,args)=>{
    calls.push({file,args});
    if(file==='opencli') throw Object.assign(new Error('err'),{stderr:'Navigation rejected'});
    return {stdout:JSON.stringify({content:[{type:'text',text:`Title: Rice\nURL: ${bili}\nPublished: 2026-10-20\nText: Rice video\n\nTitle: Evil\nURL: https://evil.com/\nText: fake`} ]})};
  };
  const reader=new SocialReader({run,opencli:'opencli',mcporter:'mcporter',cooldownMs:0});
  const result=await reader.perform('search',{platform:'bilibili',query:'rice',limit:2});
  assert.equal(result.ok,true); assert.equal(result.source,'exa-index');
  assert.equal(result.nativeError,'NAVIGATION_REJECTED'); assert.equal(result.data.length,1);
  assert.equal(result.coverage,'indexed_excerpts');
  assert.equal((await reader.perform('search',{platform:'bilibili',query:'rice',limit:2})).cached,true);
  assert.equal(calls.length,3);
  assert.ok(JSON.parse(calls[2].args[3]).query.includes('site:bilibili.com'));
});
test('comment failures never turn search snippets into comments', async()=>{
  let n=0;
  const reader=new SocialReader({run:async()=>{n++;throw new Error('AUTH_REQUIRED');},cooldownMs:0});
  const result=await reader.perform('comments',{platform:'bilibili',url:bili});
  assert.equal(result.ok,false);assert.equal(result.error,'LOGIN_REQUIRED');assert.equal(n,1);
  const threads=await reader.perform('comments',{platform:'threads',url:'https://www.threads.com/@foo/post/abc'});
  assert.equal(threads.ok,false);assert.equal(n,1);
});
test('public reader consumes body, rejects login gates and off-platform redirects',async()=>{
  const reader=new SocialReader({run:async()=>{throw new Error('unavailable');},cooldownMs:0,
    fetchPage:async()=>({statusCode:200,url:bili,body:'<script>secret</script><p>'+ 'public text '.repeat(20)+'</p>'})});
  const result=await reader.perform('read',{platform:'bilibili',url:bili});
  assert.equal(result.ok,true);assert.equal(result.source,'public-page');assert.ok(!result.text.includes('secret'));
  reader.cache.clear(); reader.fetchPage=async()=>({statusCode:200,url:'https://evil.com',body:'a'.repeat(500)});
  assert.equal((await reader.perform('read',{platform:'bilibili',url:bili})).ok,false);
});
test('secrets and diagnostics are not returned to the model',()=>{
  assert.deepEqual(scrub({text:'hello',cookie:'secret',nested:{access_token:'secret',ok:true}}),{text:'hello',nested:{ok:true}});
  assert.equal(classify(new Error('/Users/someone/.cookies auth_token=secret')), 'BACKEND_UNAVAILABLE');
  assert.equal(classify({stdout:'AUTH_REQUIRED: secret'}), 'LOGIN_REQUIRED');
});
test('native calls serialize, but failures do not poison the queue',async()=>{
  let running=0, peak=0, n=0;
  const reader=new SocialReader({cooldownMs:0,run:async()=>{
    peak=Math.max(peak,++running); await new Promise(r=>setTimeout(r,5)); running--;n++;
    if(n===1)throw new Error('AUTH_REQUIRED');return {stdout:'[{"title":"ok"}]'};
  }});
  await Promise.all(['a','b','c'].map(query=>reader.perform('search',{platform:'bilibili',query,source:'native'})));
  assert.equal(peak,1);assert.equal(n,3);
});
test('SSRF protection still rejects actual private and fake addresses',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::1','198.18.0.1'])assert.equal(isPrivateIp(ip),true,ip);
});
test('home and hot use separate fixed read-only adapters without a target positional',()=>{
  assert.deepEqual(commandFor('zhihu','read','https://www.zhihu.com/',3).slice(0,4),['zhihu','recommend','--limit','3']);
  assert.equal(commandFor('zhihu','read','https://www.zhihu.com/hot')[1],'hot');
  assert.equal(commandFor('xiaohongshu','read','https://www.xiaohongshu.com/explore')[1],'feed');
  for(const bad of ['https://zhihu.com.evil.test/','https://evil.zhihu.com/','https://user:secret@www.zhihu.com/','https://www.zhihu.com/?redirect=http://127.0.0.1','https://www.zhihu.com/account','http://www.zhihu.com/']){
    assert.equal(feedRoute('zhihu',bad),null);
    assert.throws(()=>commandFor('zhihu','read',bad));
  }
  assert.throws(()=>commandFor('zhihu','comments','https://www.zhihu.com/'));
});
test('feed failure never falls back to index or unauthenticated HTTP',async()=>{
  let runs=0;
  const reader=new SocialReader({cooldownMs:0,run:async()=>{runs++;throw new Error('AUTH_REQUIRED');},
    fetchPage:async()=>assert.fail('must not fetch homepage directly')});
  reader.indexed=async()=>assert.fail('must not invent homepage from search');
  const r=await reader.perform('read',{platform:'zhihu',url:'https://www.zhihu.com/'});
  assert.equal(r.ok,false);assert.equal(r.coverage,'home_recommendations');assert.equal(r.error,'LOGIN_REQUIRED');
  assert.equal(runs,1);
});
test('feeds label provenance, bound result count and report empty reads honestly',async()=>{
  const reader=new SocialReader({cooldownMs:0,run:async()=>({stdout:JSON.stringify([{title:'a'},{title:'b'}])})});
  const home=await reader.perform('read',{platform:'zhihu',url:'https://www.zhihu.com/',limit:1});
  const hot=await reader.perform('read',{platform:'zhihu',url:'https://www.zhihu.com/hot',limit:1});
  assert.equal(home.coverage,'home_recommendations');assert.equal(home.data.length,1);
  assert.equal(hot.coverage,'hot_list');assert.notEqual(home.url,hot.url);
  assert.equal((await reader.perform('read',{platform:'zhihu',url:'https://www.zhihu.com/',limit:1})).cached,true);
  reader.run=async()=>({stdout:'[]'});
  const empty=await reader.perform('read',{platform:'xiaohongshu',url:'https://www.xiaohongshu.com/explore'});
  assert.equal(empty.ok,false);assert.equal(empty.error,'EMPTY_FEED');
  assert.throws(()=>contentUrl('zhihu','https://www.zhihu.com/')); // Search parser still accepts content links only.
});
