/** Metadata-only normal Turbo invocation. No producer task runs in --dry=json. */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const command = ['/workspace/packages/scripts/run-turbo.ts', 'run', 'typecheck',
  '--filter=@elizaos/cloud-api', '--dry=json', '--force', '--cache=local:rw'];
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
