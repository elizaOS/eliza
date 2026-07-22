/**
 * Drives the production Smithers subprocess boundary against real workers that
 * remain alive after an OS-level or stream-level payload channel failure.
 */
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode } from '../../src/types/index';

const REDACTION_SENTINEL = 'redaction-sentinel-redaction-sentinel';
const outputPath = process.env.SMITHERS_RUNTIME_CASE_OUTPUT;
if (!outputPath) throw new Error('Smithers early-close fixture requires an output path');
const workerReadyPath = `${outputPath}.worker-ready`;
const fixtureCase = process.argv[2] ?? 'early-child-close';
const closesDescriptor = fixtureCase === 'early-child-close';
const FAILURE_MARKER = closesDescriptor
  ? 'smithers child exited before payload'
  : 'smithers payload stream closed without error';
const workerScript = `
  const { closeSync, writeFileSync } = require('node:fs');
  ${closesDescriptor ? 'closeSync(3);' : ''}
  process.stderr.write(${JSON.stringify(
    `${FAILURE_MARKER}; OPENAI_API_KEY=${REDACTION_SENTINEL}\n${'x'.repeat(8_192)}`
  )}, () => writeFileSync(${JSON.stringify(workerReadyPath)}, 'ready'));
  setInterval(() => {}, 1_000);
`;
const realSpawn = childProcess.spawn;
let spawnedWorker: childProcess.ChildProcess | undefined;
let workerClosed = false;

// Only process creation is redirected: the replacement is still a real child
// with the same four-pipe topology as the production worker.
Object.defineProperty(childProcess, 'spawn', {
  configurable: true,
  value: (_command: unknown, _args: unknown, options: childProcess.SpawnOptions | undefined) => {
    if (!options) throw new Error('Smithers early-close fixture requires spawn options');
    const child = realSpawn(process.execPath, ['-e', workerScript], {
      ...options,
      env: { PATH: process.env.PATH },
    });
    const payloadInput = child.stdio[3];
    if (!payloadInput) {
      child.kill('SIGKILL');
      throw new Error('Smithers early-close fixture requires payload input');
    }
    if (!closesDescriptor) {
      const closeOnlyPayloadInput = new PassThrough();
      Object.defineProperty(closeOnlyPayloadInput, 'end', {
        configurable: true,
        value: () => {
          closeOnlyPayloadInput.emit('close');
          return closeOnlyPayloadInput;
        },
      });
      Object.defineProperty(child.stdio, '3', {
        configurable: true,
        value: closeOnlyPayloadInput,
      });
    }
    spawnedWorker = child;
    child.once('close', () => {
      workerClosed = true;
    });
    const readyDeadline = Date.now() + 5_000;
    while (!existsSync(workerReadyPath) && Date.now() < readyDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (!existsSync(workerReadyPath)) {
      child.kill('SIGKILL');
      throw new Error('Smithers early-close worker did not reach payload readiness');
    }
    return child;
  },
});
syncBuiltinESMExports();

const { ElizaError } = await import('@elizaos/core');
const { runWorkflowWithSmithers } = await import('../../src/services/smithers-runtime');

const workflowId = 'smithers-early-close';
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

function causeCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return undefined;
  return String(cause.code);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

let result: Record<string, unknown>;
const startedAt = Date.now();
try {
  await runWorkflowWithSmithers({
    tenantId: 'smithers-runtime-fixture-agent',
    workflow,
    executionId: `run-${workflowId}`,
    pending,
    mode: 'manual',
    triggerData: { payload: 'p'.repeat(1024 * 1024) },
    plan: { enabledNodes: [workflowNode], startNodes: [workflowNode.name], incoming: {} },
    runNode: async () => [[{ json: { unexpected: true } }]],
    timeoutMs: 5_000,
  });
  result = { threw: false };
} catch (error) {
  if (!(error instanceof ElizaError)) throw error;
  result = {
    threw: true,
    code: error.code,
    message: error.message,
    phase: error.context?.phase,
    exitCode: error.context?.exitCode,
    causeCode: causeCode(error.cause),
  };
}
result = {
  ...result,
  elapsedMs: Date.now() - startedAt,
  workerPid: spawnedWorker?.pid,
  workerKilled: spawnedWorker?.killed ?? false,
  workerClosed,
  workerAlive: isProcessAlive(spawnedWorker?.pid),
};
const worker = spawnedWorker;
if (result.workerAlive === true && worker) {
  const closePromise = workerClosed
    ? Promise.resolve()
    : new Promise<void>((resolve) => worker.once('close', () => resolve()));
  worker.kill('SIGKILL');
  await closePromise;
}

const serialized = JSON.stringify(result);
await writeFile(outputPath, serialized, 'utf8');
process.stdout.write(`${serialized}\n`);
