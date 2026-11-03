/** Read-only qualification instrumentation; no SDK import or argument rewrite. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const policyPath = '/results/COMPILER-OWNERS.json';
function failure(error) {
  try { fs.appendFileSync('/results/STAGE-RECORDER-ERROR.log', String(error?.message ?? error) + '\n'); }
  catch { process.stderr.write('[qualification stage metadata unavailable]\n'); }
}
try { if (fs.existsSync(policyPath) && process.argv[1]) {
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const cwd = fs.realpathSync(process.cwd());
  const executable = fs.realpathSync(process.argv[1]);
  let stage;
  if (cwd === '/workspace/packages/cloud/api') {
    if (executable === policy.apiTsc.file) stage = 'api-normal-tsc';
    else if (executable === '/workspace/packages/cloud/api/test/_router-contract.mjs') stage = 'api-router-contract';
    else if (executable === policy.wrangler.file) {
      if (!process.argv.includes('--dry-run') || !process.argv.includes('production') || !process.argv.includes('deploy')) {
        throw new Error('Qualification permits only the unchanged production dry-run command');
      }
      stage = 'api-worker-dry-run';
    }
  }
  if (stage) {
    const target = '/results/API-STAGES.jsonl';
    const identity = { stage, pid: process.pid, parentPid: process.ppid, cwd, executable,
      executableSHA256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
      argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS ?? '' };
    const append = (event) => {
      try {
        if (fs.existsSync(target) && fs.statSync(target).size > 1048576) throw new Error('Stage metadata cap');
        fs.appendFileSync(target, JSON.stringify({ ...identity, ...event, at: Date.now() }) + '\n', { mode: 0o600 });
      } catch (error) { failure(error); }
    };
    append({ event: 'start' });
    process.once('exit', (code) => append({ event: 'exit', code }));
  }
} } catch (error) { failure(error); }
