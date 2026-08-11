/**
 * Drives the production Smithers subprocess boundary against a worker that
 * exits while a grandchild keeps its stdio pipes open, so the parent observes
 * 'exit' but never a full stdio 'close'. Pins the bounded drain fallback:
 * before it existed, this run hung past its own deadline until the pipes'
 * eventual holder died — the shape of the CI plugin-lane wedge.
 */
import childProcess from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode } from '../../src/types/index';

const outputPath = process.env.SMITHERS_RUNTIME_CASE_OUTPUT;
if (!outputPath) throw new Error('Smithers exit-without-close fixture requires an output path');

// The worker consumes the payload pipe to EOF first so the payload write
// deterministically succeeds, then hands its stdout/stderr write ends to a
// detached grandchild and exits. The grandchild never writes; it only holds
// the pipes open long past the run deadline.
const workerScript = `
  const { readFileSync } = require('node:fs');
  readFileSync(3, 'utf8');
  const { spawn } = require('node:child_process');
  const grandchild = spawn('sleep', ['60'], { stdio: ['ignore', 1, 2], detached: true });
  grandchild.unref();
  process.exit(0);
`;

const realSpawn = childProcess.spawn;
let workerExited = false;
let workerClosed = false;

// Only process creation is redirected: the replacement is still a real child
// with the same four-pipe topology as the production worker.
Object.defineProperty(childProcess, 'spawn', {
  configurable: true,
  value: (_command: unknown, _args: unknown, options: childProcess.SpawnOptions | undefined) => {
    if (!options) throw new Error('Smithers exit-without-close fixture requires spawn options');
    const child = realSpawn(process.execPath, ['-e', workerScript], {
      ...options,
      env: { PATH: process.env.PATH },
    });
    child.once('exit', () => {
      workerExited = true;
    });
    child.once('close', () => {
      workerClosed = true;
    });
    return child;
  },
});
syncBuiltinESMExports();

const { ElizaError } = await import('@elizaos/core');
const { runWorkflowWithSmithers } = await import('../../src/services/smithers-runtime');

const workflowId = 'smithers-exit-without-close';
const workflowNode: WorkflowNode = {
  name: 'never-runs',
  type: 'test.node',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};
const workflow: WorkflowDefinition = {
  id: workflowId,
  name: workflowId,
  nodes: [workflowNode],
  connections: {},
};
const pending: WorkflowExecution = {
  id: `exec-${workflowId}`,
  finished: false,
  mode: 'manual',
  startedAt: new Date().toISOString(),
  workflowId,
  status: 'running',
};

let result: Record<string, unknown>;
const startedAt = Date.now();
try {
  await runWorkflowWithSmithers({
    tenantId: 'smithers-runtime-fixture-agent',
    workflow,
    executionId: `run-${workflowId}`,
    pending,
    mode: 'manual',
    triggerData: {},
    plan: { enabledNodes: [workflowNode], startNodes: [workflowNode.name], incoming: {} },
    runNode: async () => [[{ json: { unexpected: true } }]],
    // Larger than the stdio drain grace so the drain fallback, not the run
    // deadline, is what settles the outcome.
    timeoutMs: 60_000,
  });
  result = { threw: false };
} catch (error) {
  if (!(error instanceof ElizaError)) throw error;
  result = { threw: true, code: error.code, message: error.message };
}
result = {
  ...result,
  elapsedMs: Date.now() - startedAt,
  workerExited,
  workerClosed,
};

const serialized = JSON.stringify(result);
await writeFile(outputPath, serialized, 'utf8');
process.stdout.write(`${serialized}\n`);
