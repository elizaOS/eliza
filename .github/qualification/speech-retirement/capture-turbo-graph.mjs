/** Metadata-only normal Turbo invocation. No producer task runs in --dry=json. */
import fs from 'node:fs';
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
const child = spawn('/usr/local/bin/node', command, { cwd: '/workspace', env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', overflow = false;
function receive(label, chunk) {
  if (overflow) return;
  const previous = label === 'stdout' ? stdout : stderr;
  const limit = label === 'stdout' ? 8388608 : 1048576;
  if (Buffer.byteLength(previous) + chunk.length > limit) { overflow = true; child.kill('SIGTERM'); return; }
  if (label === 'stdout') stdout += chunk; else stderr += chunk;
}
child.stdout.on('data', chunk => receive('stdout', chunk));
child.stderr.on('data', chunk => receive('stderr', chunk));
child.on('error', (error) => { throw error; });
child.on('close', (code, signal) => {
  fs.writeFileSync('/results/TURBO-GRAPH.stderr.log', stderr);
  if (overflow || signal || code !== 0) throw new Error('Normal Turbo metadata command failed');
  const graph = JSON.parse(stdout);
  if (!Array.isArray(graph.tasks)) throw new Error('Unrecognized actual Turbo metadata schema');
  fs.writeFileSync('/results/TURBO-GRAPH.json', JSON.stringify(graph, null, 2) + '\n');
});
