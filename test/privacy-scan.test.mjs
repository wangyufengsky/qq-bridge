import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('privacy scan advances past benign first match and still detects later secret-shaped text',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'privacy-regression-'));
  try{
    fs.mkdirSync(path.join(root,'scripts'));
    fs.copyFileSync(new URL('../scripts/privacy-scan.mjs',import.meta.url),path.join(root,'scripts/privacy-scan.mjs'));
    // Deliberately synthetic mixed-case string, not a credential.
    const fake='zQ7'.repeat(12);
    fs.writeFileSync(path.join(root,'candidate.txt'),'PUBLIC_CONSTANT_NAME_THAT_IS_LONG_ENOUGH\n'+fake);
    const run=spawnSync(process.execPath,['scripts/privacy-scan.mjs','--json'],{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(run.status,1);assert.ok(!run.stderr.includes('提前结束'));
    const report=JSON.parse(run.stdout);
    assert.ok(report.findings.some(f=>f.file==='candidate.txt'&&f.line===2));
    assert.ok(!run.stdout.includes(fake),'diagnostics must redact the matched value');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
