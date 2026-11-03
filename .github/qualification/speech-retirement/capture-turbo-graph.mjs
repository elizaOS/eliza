/** Metadata-only normal Turbo invocation. No producer task runs in --dry=json. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const command = ['/workspace/packages/scripts/run-turbo.ts', 'run', 'typecheck',
  '--filter=@elizaos/cloud-api', '--dry=json'];
if (!fs.lstatSync('/workspace/.git').isDirectory() || fs.lstatSync('/workspace/.git').isSymbolicLink()) throw new Error('Linked or external Git worktree cache is not admitted');
const canonicalTurbo = JSON.parse(fs.readFileSync('/workspace/turbo.json', 'utf8'));
if (canonicalTurbo.cacheDir !== undefined) throw new Error('Nondefault cache directory not in this normal cold contract');
if (fs.existsSync('/tmp/home') && fs.readdirSync('/tmp/home').length) throw new Error('Nonempty external tool HOME not admitted');
for (const key of ['TURBO_TOKEN', 'TURBO_TEAM', 'TURBO_API', 'TURBO_CACHE_DIR', 'TURBO_CONFIG_DIR', 'TURBO_REMOTE_CACHE_SIGNATURE_KEY']) {
  if (process.env[key]) throw new Error('External Turbo cache/credential environment not admitted: ' + key);
}
for (const directory of ['/workspace/.turbo', '/workspace/.turbo/cache']) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Borrowed Turbo cache link');
}
if (fs.existsSync('/workspace/.turbo/config.json')) throw new Error('External Turbo link/config not admitted');
if (fs.existsSync('/workspace/.turbo/cache') && fs.readdirSync('/workspace/.turbo/cache').length) throw new Error('Preexisting task cache not admitted');
// Linux hard file limit bounds the regular-file transport in the kernel.
// Direct regular-file stdout makes the unchanged wrapper's writes synchronous.
const stdoutLimit = 8388608, stderrLimit = 1048576;
const limits = fs.readFileSync('/proc/self/limits', 'utf8');
const fileLimit = limits.match(/^Max file size\s+(\d+)\s+(\d+)\s+bytes\s*$/m);
if (!fileLimit || Number(fileLimit[1]) !== stdoutLimit || Number(fileLimit[2]) !== stdoutLimit) {
  throw new Error('Missing exact inherited hard metadata file-size limit');
}
const rawPath = '/results/TURBO-GRAPH.stdout.json';
const stdoutFd = fs.openSync(rawPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
const stderrChunks = [];
let child, stderrBytes = 0, overflow = false, spawnError = null;
const describeError = error => ({ name: error.name, code: error.code, message: error.message });
function finish(code, signal) {
  fs.writeFileSync('/results/TURBO-GRAPH.stderr.log', Buffer.concat(stderrChunks));
  const stdoutBytes = fs.statSync(rawPath).size;
  const diagnostic = { code, signal, spawnError, stderrOverflow: overflow, stdoutBytes,
    stderrBytes, stdoutSHA256: null, hardFileSizeLimitBytes: stdoutLimit,
    stdoutAtOrOverHardLimit: stdoutBytes >= stdoutLimit, transport: 'regular-file-descriptor',
    canonicalCommand: ['/usr/local/bin/node', ...command], parse: 'NOT_ATTEMPTED' };
  const save = () => fs.writeFileSync('/results/TURBO-GRAPH-CAPTURE.json', JSON.stringify(diagnostic, null, 2) + '\n');
  save();
  if (stdoutBytes > stdoutLimit) throw new Error('Kernel metadata output limit failed; raw hash not read beyond bound');
  const stdout = fs.readFileSync(rawPath);
  diagnostic.stdoutSHA256 = crypto.createHash('sha256').update(stdout).digest('hex'); save();
  if (overflow || stdoutBytes >= stdoutLimit || spawnError || signal || code !== 0) {
    throw new Error('Normal Turbo metadata command failed');
  }
  let graph;
  try {
    graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout));
    diagnostic.parse = 'WELL_FORMED_JSON';
  } catch (error) {
    diagnostic.parse = 'FAILED'; diagnostic.parseError = error.message; save(); throw error;
  }
  if (!Array.isArray(graph.tasks)) {
    diagnostic.schema = 'FAILED_TASKS_ARRAY'; save(); throw new Error('Unrecognized actual Turbo metadata schema');
  }
  diagnostic.schema = 'TASKS_ARRAY_ONLY_FULL_GRAPH_CHECKS_PENDING'; save();
  fs.writeFileSync('/results/TURBO-GRAPH.json', JSON.stringify(graph, null, 2) + '\n');
}
try {
  child = spawn('/usr/local/bin/node', command, { cwd: '/workspace', env: process.env,
    stdio: ['ignore', stdoutFd, 'pipe'] });
} catch (error) {
  spawnError = describeError(error);
} finally { fs.closeSync(stdoutFd); }
if (!child) {
  finish(null, null);
} else {
  child.on('error', error => { spawnError = describeError(error); });
  child.on('close', finish);
  if (child.stderr) {
    child.stderr.on('data', chunk => {
      if (overflow) return;
      if (stderrBytes + chunk.length > stderrLimit) {
        overflow = true; child.kill('SIGTERM'); return;
      }
      stderrBytes += chunk.length; stderrChunks.push(chunk);
    });
  } else {
    spawnError = { name: 'MissingStderrPipe', message: 'Canonical metadata child has no stderr pipe' };
    if (child.pid) child.kill('SIGTERM');
  }
}
