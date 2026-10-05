import {test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {windowsWorkflowBackend as backend} from '../../src/services/workflow-worker-lease.windows';
if(process.platform!=='win32')throw Error('Real Windows host required');
async function until(condition:()=>boolean){const until=Date.now()+30000;while(!condition()){if(Date.now()>until)throw Error('Witness deadline');await Bun.sleep(25);}}
test('actual worker survives parent death, concurrent admissions reject, terminal receipt clears only its lease',async()=>{
 const root=mkdtempSync(join(tmpdir(),'windows-worker-survivor-'));const source='export default 17;';const identity={rootDir:root,socketRoot:root,runId:randomUUID(),versionId:'v1',sourceSha256:createHash('sha256').update(source).digest('hex')};
 const ready=join(root,'ready'),release=join(root,'release'),done=join(root,'done'),effect=join(root,'effect');
 const module=pathToFileURL(join(import.meta.dir,'../../src/services/workflow-worker-lease.windows.ts')).href;
 const worker=`import {windowsWorkflowBackend as b} from ${JSON.stringify(module)};import * as fs from 'node:fs';const h=await b.acquireWorkerLease(${JSON.stringify(identity)});fs.appendFileSync(${JSON.stringify(effect)},'once\\n');fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))await Bun.sleep(20);fs.writeFileSync(${JSON.stringify(done)},'canonical-terminal');await h.finishCanonicalResult();`;
 const parentCode=`import {spawn} from 'node:child_process';const c=spawn(process.execPath,['--eval',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000);`;
 const parent=spawn(process.execPath,['--eval',parentCode],{stdio:'ignore'});
 try {await until(()=>existsSync(ready));parent.kill('SIGKILL');await until(()=>parent.exitCode!==null||parent.signalCode!==null);
  expect((await backend.inspectWorkerLease(identity)).state).toBe('live');
  const attempts=await Promise.allSettled(Array.from({length:4},()=>backend.acquireWorkerLease(identity)));expect(attempts.every(x=>x.status==='rejected' && x.reason?.code==='WORKFLOW_WORKER_UNRESOLVED')).toBe(true);
  await backend.publishWorkflowSource(join(root,'v1.ts'),source);await Promise.all(Array.from({length:8},()=>backend.publishWorkflowSource(join(root,'v1.ts'),source)));
  await expect(backend.publishWorkflowSource(join(root,'v1.ts'),'changed')).rejects.toThrow();
  writeFileSync(release,'release');await until(()=>existsSync(done));let state=await backend.inspectWorkerLease(identity);const deadline=Date.now()+30000;while(state.state!=='absent'){if(Date.now()>deadline)throw Error('Lease completion deadline');await Bun.sleep(50);state=await backend.inspectWorkerLease(identity);}
  expect(readFileSync(effect,'utf8')).toBe('once\n');
 }finally{writeFileSync(release,'release');parent.kill();/* Retain root evidence if a child fails to settle; no broad process cleanup. */}
},120000);
test('abandoned worker remains unknown and cannot replay',async()=>{
 const root=mkdtempSync(join(tmpdir(),'windows-worker-abandon-'));const identity={rootDir:root,socketRoot:root,runId:randomUUID(),versionId:'v1',sourceSha256:'a'.repeat(64)};
 const lease=await backend.acquireWorkerLease(identity);await lease.abandon();expect((await backend.inspectWorkerLease(identity)).state).toBe('unknown');await expect(backend.acquireWorkerLease(identity)).rejects.toThrow();
},60000);
