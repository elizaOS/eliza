import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import test from "node:test";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const owner = new URL("./cloud-enrollment.mjs", import.meta.url).href;
const output = testOutputPath("native-enrollment-recovery", "fixtures");
mkdirSync(output, { recursive: true });
const child = `
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createNativeCloudAuth } from ${JSON.stringify(owner)};
const root = await mkdtemp(join(${JSON.stringify(output)}, 'journal-'));
const journal = join(root, 'pending.json'), credential = join(root, 'active');
const binding = {clientId:'org.example.recovery',environment:'test',redirectUri:'https://example.org/native/callback'};
const secret = 'eliza_' + 'a'.repeat(64);
const proof = {...binding, secret, credentialId:'00000000-0000-4000-8000-000000000001'};
let requests = 0;
const server = createServer((request,response) => { requests++; request.resume(); response.writeHead(503, {'Content-Type':'application/json'}); response.end(JSON.stringify({error:'unavailable'})); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const api = 'http://127.0.0.1:' + server.address().port;
function host() {
 return createNativeCloudAuth({binding,appName:'Disposable Recovery',api,auth:api,
 pendingStore:{read:()=>readFile(journal,'utf8'),write:value=>writeFile(journal,value),clear:()=>unlink(journal)},
 readActive:()=>readFile(credential,'utf8'),clearActive:()=>unlink(credential),
 activate:async()=>{throw Error('Unexpected activation');}});
}
try {
 const mode = process.argv[1];
 if(mode === 'malformed') {
  for(const raw of ['null','{','{}','[]','"text"','123']) {
   for(const operation of ['resume','cancel','disconnect']) {
    await writeFile(journal,raw,{mode:0o600}); await writeFile(credential,secret,{mode:0o600});
    const auth = host();
    await assert.rejects(operation === 'disconnect' ? auth.cancel({disconnect:true}) : auth.handle(operation), error => error instanceof Error && !(error instanceof TypeError) && error.status === 409);
    assert.equal(await readFile(journal,'utf8'),raw);
    assert.equal(await readFile(credential,'utf8'),secret);
   }
  }
  assert.equal(requests,0);
 } else {
  const raw = JSON.stringify({version:1,proof,acknowledgeBy:new Date(Date.now()+300000).toISOString()});
  await writeFile(journal,raw,{mode:0o600}); await writeFile(credential,secret,{mode:0o600});
  await assert.rejects(host().handle('resume'),error=>error.status===502);
  assert.equal(await readFile(journal,'utf8'),raw);
  await assert.rejects(host().handle('cancel'),error=>error.status===502);
  const saved=JSON.parse(await readFile(journal,'utf8'));
  assert.equal(saved.kind,'revocation'); assert.deepEqual(saved.proof,proof);
  assert.equal(await readFile(credential,'utf8'),secret);
  assert.equal(requests,2);
 }
 console.log(JSON.stringify({mode,requests,passed:true}));
} finally {
 await new Promise(resolve=>server.close(resolve));
 await rm(root,{recursive:true,force:true});
}
`;

for (const [mode, name] of [
  [
    "malformed",
    "malformed disk journals require typed recovery before effects",
  ],
  ["outage", "real provider outages preserve pending authority and revocation"],
]) {
  test(name, () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", child, mode],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(JSON.parse(result.stdout).passed, true);
  });
}
