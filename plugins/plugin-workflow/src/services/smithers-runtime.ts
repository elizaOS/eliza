/**
 * Executes persisted Smithers workflow modules in an isolated Bun child process
 * and streams native Smithers progress events back to the owning elizaOS
 * runtime. The child speaks a private stdout protocol; there is no Smithers
 * Gateway, HTTP sidecar, or foreign workflow translation layer.
 *
 * Incomplete stdout lines are fail-closed at {@link MAX_PROTOCOL_LINE_BYTES}
 * before the parent concatenates them. A worker that never emits `\n` used to
 * grow `stdoutBuffer` without bound for the whole run timeout.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { ElizaError, redactSensitiveText } from '@elizaos/core';
import type {
  WorkflowDefinitionResponse,
  WorkflowExecutionMode,
  WorkflowExecutionStatus,
  WorkflowRunEvent,
} from '../types/index';

const PROTOCOL_PREFIX = '__ELIZA_SMTHRS__';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_STDERR_CHARS = 8_192;
/** Fail-closed ceiling for one protocol line (complete or incomplete). */
const MAX_PROTOCOL_LINE_BYTES = 1_048_576;
const WORKER_TERMINATION_GRACE_MS = 1_000;
const WORKER_STDIO_DRAIN_GRACE_MS = 1_000;
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type WorkerTerminationCause = 'abort' | 'timeout' | 'overflow';

export function resolveSmithersBunExecutable(): string {
  const configured = process.env.BUN_BIN?.trim();
  if (configured) return configured;
  if (process.versions.bun) return process.execPath;
  return 'bun';
}

function appendSmithersProtocolChunk(
  buffer: string,
  chunk: string,
  maxBytes: number = MAX_PROTOCOL_LINE_BYTES
): { buffer: string; lines: string[]; overflow: boolean } {
  const next = `${buffer}${chunk}`;
  const parts = next.split('\n');
  const incomplete = parts.pop() ?? '';
  if (Buffer.byteLength(incomplete, 'utf8') > maxBytes) {
    return { buffer: '', lines: [], overflow: true };
  }
  for (const line of parts) {
    if (Buffer.byteLength(line, 'utf8') > maxBytes) {
      return { buffer: '', lines: [], overflow: true };
    }
  }
  return { buffer: incomplete, lines: parts, overflow: false };
}

interface WorkerEventMessage {
  kind: 'event';
  event: Record<string, unknown>;
}

interface WorkerResultMessage {
  kind: 'result';
  result: {
    runId: string;
    status: string;
    output?: unknown;
    error?: unknown;
    nextRunId?: string;
  };
}

interface WorkerErrorMessage {
  kind: 'error';
  error: { message: string; stack?: string };
}

interface WorkerAgentRequestMessage {
  kind: 'agent-request';
  requestId: string;
  prompt: unknown;
  messages?: unknown;
}

type WorkerMessage =
  | WorkerEventMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerAgentRequestMessage;

export interface SmithersRunRequest {
  tenantId: string;
  workflow: WorkflowDefinitionResponse;
  runId: string;
  mode: WorkflowExecutionMode;
  input: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: WorkflowRunEvent) => void | Promise<void>;
  generate: (request: {
    prompt: unknown;
    messages?: unknown;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

export interface SmithersRunResult {
  runId: string;
  status: WorkflowExecutionStatus;
  output?: unknown;
  error?: { message: string; stack?: string };
  nextRunId?: string;
  events: WorkflowRunEvent[];
}

export type SmithersControlRequest =
  | {
      kind: 'approve';
      runId: string;
      nodeId: string;
      iteration: number;
      note?: string;
      decidedBy?: string;
      decision?: unknown;
    }
  | {
      kind: 'deny';
      runId: string;
      nodeId: string;
      iteration: number;
      note?: string;
      decidedBy?: string;
      decision?: unknown;
    }
  | { kind: 'signal'; runId: string; signal: string; payload?: unknown; receivedBy?: string };

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

export function resolveSmithersWorkflowDir(tenantId: string, workflowId: string): string {
  if (!tenantId.trim()) {
    throw new ElizaError('Smithers execution requires a tenant id', {
      code: 'SMTHRS_TENANT_REQUIRED',
      context: { workflowId },
    });
  }
  return join(process.cwd(), '.eliza', 'smthrs', safePathPart(tenantId), safePathPart(workflowId));
}

export function resolveSmithersTimeoutMs(value?: number): number {
  const raw = process.env.ELIZA_SMTHRS_TIMEOUT_MS;
  let configured: number;
  if (value !== undefined) {
    configured = value;
  } else if (raw === undefined) {
    configured = DEFAULT_TIMEOUT_MS;
  } else {
    configured = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  }
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > MAX_TIMEOUT_MS) {
    throw new ElizaError(`Smithers timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}`, {
      code: 'SMTHRS_TIMEOUT_INVALID',
      context: {
        configured: value ?? raw,
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
      },
    });
  }
  return configured;
}

async function linkWorkflowDependency(
  rootDir: string,
  packageName: 'smthrs' | 'zod'
): Promise<void> {
  const packageDir = dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`)));
  const linkPath = join(rootDir, 'node_modules', packageName);
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    await symlink(packageDir, linkPath, 'junction');
  } catch (error) {
    // error-policy:J4 an existing dependency link is the expected steady state;
    // every other filesystem failure must stop workflow execution.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

export function validateSmithersSource(source: unknown): void {
  // A stored workflow record can reach dispatch without a source (stale
  // trigger pointing at a legacy or partially-saved definition, live repro:
  // system-device-health-check). That must fail as the typed
  // SMTHRS_SOURCE_REQUIRED error, not a TypeError on `.trim()`.
  const trimmed = typeof source === 'string' ? source.trim() : '';
  if (!trimmed)
    throw new ElizaError('Workflow source is required', { code: 'SMTHRS_SOURCE_REQUIRED' });
  if (!/\bfrom\s+['"]smthrs(?:\/[^'"]+)?['"]/.test(trimmed)) {
    throw new ElizaError('Workflow source must import its runtime from smthrs', {
      code: 'SMTHRS_IMPORT_REQUIRED',
    });
  }
  if (!/\bexport\s+default\b/.test(trimmed)) {
    throw new ElizaError('Workflow source must default-export a Smithers workflow', {
      code: 'SMTHRS_DEFAULT_EXPORT_REQUIRED',
    });
  }
  if (/\b(?:@smithers-orchestrator|smithers-orchestrator|workflows-nodes-base)\b/.test(trimmed)) {
    throw new ElizaError('Legacy workflow packages and node definitions are not supported', {
      code: 'SMTHRS_LEGACY_SOURCE_REJECTED',
    });
  }
}

export function createSmithersWorkerScript(): string {
  return String.raw`
    import { readFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    import { Effect } from 'effect';
    import { runWorkflow } from 'smthrs';
    import { createInterface } from 'node:readline';

    const PREFIX = ${JSON.stringify(PROTOCOL_PREFIX)};
    const payload = JSON.parse(readFileSync(process.env.ELIZA_SMTHRS_PAYLOAD_PATH, 'utf8'));
    const encode = (message) => PREFIX + JSON.stringify(message, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ) + '\n';
    const emit = (message) => process.stdout.write(encode(message));
    const emitAndFlush = (message) => new Promise((resolve, reject) => {
      process.stdout.write(encode(message), (error) => error ? reject(error) : resolve());
    });
    const serializeError = (error) => ({
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
    const responses = new Map();
    let requestSequence = 0;
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        const pending = responses.get(response.requestId);
        if (!pending) return;
        responses.delete(response.requestId);
        if (response.ok) {
          const text = typeof response.value === 'string'
            ? response.value
            : JSON.stringify(response.value);
          pending.resolve({ text });
        }
        else pending.reject(new Error(response.error?.message ?? 'elizaOS model request failed'));
      } catch (error) {
        const failure = new Error('Invalid elizaOS model response: ' + String(error));
        for (const pending of responses.values()) pending.reject(failure);
        responses.clear();
      }
    });
    globalThis.__elizaSmithers = {
      agent: {
        id: 'elizaos-runtime',
        generate: (args = {}) => new Promise((resolve, reject) => {
          const requestId = String(++requestSequence);
          responses.set(requestId, { resolve, reject });
          emit({
            kind: 'agent-request',
            requestId,
            prompt: args.prompt,
            messages: args.messages,
          });
        }),
      },
    };

    console.log = (...values) => process.stderr.write('[workflow] ' + values.map(String).join(' ') + '\n');
    console.info = console.log;
    console.warn = (...values) => process.stderr.write('[workflow:warn] ' + values.map(String).join(' ') + '\n');
    console.error = (...values) => process.stderr.write('[workflow:error] ' + values.map(String).join(' ') + '\n');

    try {
      const moduleUrl = pathToFileURL(payload.sourcePath);
      moduleUrl.searchParams.set('version', payload.versionId);
      const workflowModule = await import(moduleUrl.href);
      const workflow = workflowModule.default;
      if (!workflow || typeof workflow.build !== 'function') {
        throw new Error('Default export is not a Smithers workflow');
      }
      const result = await Effect.runPromise(runWorkflow(workflow, {
        runId: payload.runId,
        input: payload.input,
        workflowPath: payload.sourcePath,
        rootDir: payload.rootDir,
        onProgress: (event) => emit({ kind: 'event', event }),
      }));
      await emitAndFlush({ kind: 'result', result });
      input.close();
      process.exit(0);
    } catch (error) {
      await emitAndFlush({ kind: 'error', error: serializeError(error) });
      input.close();
      process.exit(1);
    }
  `;
}

export function createSmithersControlScript(): string {
  return `
    import { readFileSync } from 'node:fs';
    import { Effect } from 'effect';
    import { approveNode, denyNode, signalRun } from 'smthrs';
    import { openSmithersStore } from 'smthrs/openSmithersStore';

    const payload = JSON.parse(readFileSync(process.env.ELIZA_SMTHRS_PAYLOAD_PATH, 'utf8'));
    const store = await openSmithersStore({ mode: 'write', backend: 'sqlite', dbPath: payload.dbPath });
    try {
      if (payload.kind === 'approve') {
        await Effect.runPromise(approveNode(store.adapter, payload.runId, payload.nodeId, payload.iteration, payload.note, payload.decidedBy, payload.decision));
      } else if (payload.kind === 'deny') {
        await Effect.runPromise(denyNode(store.adapter, payload.runId, payload.nodeId, payload.iteration, payload.note, payload.decidedBy, payload.decision));
      } else if (payload.kind === 'signal') {
        await Effect.runPromise(signalRun(store.adapter, payload.runId, payload.signal, payload.payload, { receivedBy: payload.receivedBy }));
      } else {
        throw new Error('Unknown Smithers control request');
      }
      process.stdout.write(JSON.stringify({ ok: true }));
    } finally {
      await store.cleanup();
    }
  `;
}

export async function controlSmithersRun(
  tenantId: string,
  workflowId: string,
  request: SmithersControlRequest
): Promise<void> {
  const rootDir = resolveSmithersWorkflowDir(tenantId, workflowId);
  await mkdir(rootDir, { recursive: true });
  const payloadPath = join(rootDir, `.control-${randomUUID()}.json`);
  await writeFile(
    payloadPath,
    JSON.stringify({ ...request, dbPath: join(rootDir, 'runs.sqlite') }),
    {
      encoding: 'utf8',
      mode: 0o600,
    }
  );
  const child = spawn(resolveSmithersBunExecutable(), ['--eval', createSmithersControlScript()], {
    cwd: PLUGIN_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ELIZA_SMTHRS_PAYLOAD_PATH: payloadPath,
      MSGPACKR_NATIVE_ACCELERATION_DISABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(async () => {
    await unlink(payloadPath).catch((error: NodeJS.ErrnoException) => {
      // error-policy:J6 the one-shot child already terminated; cleanup failure
      // is observable through the caller only when it is not already absent.
      if (error.code !== 'ENOENT') throw error;
    });
  });
  if (exitCode !== 0) {
    const detail = stripVTControlCharacters(redactSensitiveText(stderr)).trim();
    throw new ElizaError(`Smithers control failed${detail ? `: ${detail}` : ''}`, {
      code: 'SMTHRS_CONTROL_FAILED',
      context: { exitCode, workflowId, runId: request.runId, kind: request.kind },
    });
  }
}

function statusFromSmithers(status: string): WorkflowExecutionStatus {
  const accepted: WorkflowExecutionStatus[] = [
    'cancelled',
    'continued',
    'failed',
    'finished',
    'paused',
    'queued',
    'running',
    'waiting-approval',
    'waiting-event',
    'waiting-quota',
    'waiting-timer',
  ];
  return accepted.includes(status as WorkflowExecutionStatus)
    ? (status as WorkflowExecutionStatus)
    : status === 'canceled'
      ? 'cancelled'
      : 'failed';
}

function errorPayload(error: unknown): { message: string; stack?: string } {
  return error instanceof Error
    ? { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
    : { message: String(error) };
}

export async function runSmithersWorkflow(request: SmithersRunRequest): Promise<SmithersRunResult> {
  validateSmithersSource(request.workflow.source);
  const rootDir = resolveSmithersWorkflowDir(request.tenantId, request.workflow.id);
  const sourcePath = join(
    rootDir,
    `${safePathPart(request.workflow.versionId)}.${request.workflow.language === 'tsx' ? 'tsx' : 'ts'}`
  );
  const payloadPath = join(rootDir, `.run-${randomUUID()}.json`);
  await mkdir(dirname(sourcePath), { recursive: true });
  await Promise.all([
    linkWorkflowDependency(rootDir, 'smthrs'),
    linkWorkflowDependency(rootDir, 'zod'),
  ]);
  await writeFile(sourcePath, request.workflow.source, { encoding: 'utf8', mode: 0o600 });
  await writeFile(
    payloadPath,
    JSON.stringify({
      sourcePath,
      rootDir,
      versionId: request.workflow.versionId,
      runId: request.runId,
      input: request.input,
    }),
    { encoding: 'utf8', mode: 0o600 }
  );

  const timeoutMs = resolveSmithersTimeoutMs(request.timeoutMs);
  const worker = spawn(resolveSmithersBunExecutable(), ['--eval', createSmithersWorkerScript()], {
    cwd: PLUGIN_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: process.env.NODE_ENV,
      ELIZA_SMTHRS_DB_PATH: join(rootDir, 'runs.sqlite'),
      ELIZA_SMTHRS_PAYLOAD_PATH: payloadPath,
      MSGPACKR_NATIVE_ACCELERATION_DISABLED: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const events: WorkflowRunEvent[] = [];
  let sequence = 0;
  let result: WorkerResultMessage['result'] | undefined;
  let workerError: WorkerErrorMessage['error'] | undefined;
  let stderr = '';
  let stdoutBuffer = '';
  let stdoutNoise = '';
  let stdinError: Error | undefined;
  let lineProcessing = Promise.resolve();
  const protocolController = new AbortController();

  const protocolAbortOutcome = new Promise<{ kind: 'aborted' }>((resolve) => {
    if (protocolController.signal.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    protocolController.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), {
      once: true,
    });
  });

  // A worker can close its input before the parent finishes an in-flight model
  // request. Observe that late EPIPE here so it cannot become a process-level
  // uncaught stream error; the worker's terminal result remains authoritative.
  // error-policy:J5 the same failure is reflected in the terminal worker outcome.
  worker.stdin?.on('error', (error) => {
    stdinError = error;
  });

  const writeWorkerResponse = (response: Record<string, unknown>): void => {
    const input = worker.stdin;
    if (!input?.writable || input.destroyed) return;
    try {
      input.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      stdinError = error instanceof Error ? error : new Error(String(error));
    }
  };

  const consumeLine = async (line: string): Promise<void> => {
    if (!line.startsWith(PROTOCOL_PREFIX)) {
      stdoutNoise = `${stdoutNoise}${line}\n`.slice(-MAX_STDERR_CHARS);
      return;
    }
    let message: WorkerMessage;
    try {
      message = JSON.parse(line.slice(PROTOCOL_PREFIX.length)) as WorkerMessage;
    } catch {
      // error-policy:J3 malformed child output is ignored here and becomes a
      // missing-result boundary error if no valid terminal message follows.
      return;
    }
    if (message.kind === 'result') result = message.result;
    if (message.kind === 'error') workerError = message.error;
    if (message.kind === 'agent-request') {
      try {
        const generationOutcome = request
          .generate({
            prompt: message.prompt,
            ...(message.messages !== undefined ? { messages: message.messages } : {}),
            signal: protocolController.signal,
          })
          .then(
            (value) => ({ kind: 'value' as const, value }),
            (error) => ({ kind: 'error' as const, error })
          );
        const generation = await Promise.race([generationOutcome, protocolAbortOutcome]);
        if (generation.kind === 'aborted') return;
        if (generation.kind === 'error') throw generation.error;
        writeWorkerResponse({ requestId: message.requestId, ok: true, value: generation.value });
      } catch (error) {
        // error-policy:J1 model failures cross the worker boundary as a typed
        // rejection for the Smithers AgentLike invocation.
        writeWorkerResponse({
          requestId: message.requestId,
          ok: false,
          error: errorPayload(error),
        });
      }
    }
    if (message.kind === 'event') {
      sequence += 1;
      const raw = message.event;
      const event: WorkflowRunEvent = {
        id: `${request.runId}:${sequence}`,
        sequence,
        runId: request.runId,
        workflowId: request.workflow.id,
        timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
        type: typeof raw.type === 'string' ? raw.type : 'progress',
        ...(typeof raw.nodeId === 'string' ? { nodeId: raw.nodeId } : {}),
        ...(typeof raw.iteration === 'number' ? { iteration: raw.iteration } : {}),
        payload: raw,
      };
      events.push(event);
      await request.onEvent?.(event);
    }
  };

  worker.stdout?.setEncoding('utf8');
  worker.stdout?.on('data', (chunk: string) => {
    const appended = appendSmithersProtocolChunk(stdoutBuffer, chunk);
    if (appended.overflow) {
      terminate('overflow');
      return;
    }
    stdoutBuffer = appended.buffer;
    worker.stdout?.pause();
    lineProcessing = lineProcessing
      .then(async () => {
        for (const line of appended.lines) await consumeLine(line);
      })
      .finally(() => {
        if (!terminationCause && !processExited) worker.stdout?.resume();
      });
  });
  worker.stderr?.setEncoding('utf8');
  worker.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
  });

  let terminationCause: WorkerTerminationCause | undefined;
  let processExited = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const terminate = (cause: WorkerTerminationCause): void => {
    if (terminationCause || processExited) return;
    terminationCause = cause;
    protocolController.abort(cause);
    worker.kill('SIGTERM');
    forceKillTimer = setTimeout(() => worker.kill('SIGKILL'), WORKER_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };
  const abort = (): void => terminate('abort');
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener('abort', abort, { once: true });
  const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);

  const outcome = await new Promise<{
    exitCode: number | null;
    processError?: { error: Error; phase: 'spawn' | 'runtime' };
  }>((resolve) => {
    let settled = false;
    let spawnObserved = false;
    let processError: { error: Error; phase: 'spawn' | 'runtime' } | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      resolve({ exitCode, ...(processError ? { processError } : {}) });
    };
    const armDrainFallback = (exitCode: number | null): void => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => settle(exitCode), WORKER_STDIO_DRAIN_GRACE_MS);
    };
    worker.once('spawn', () => {
      spawnObserved = true;
    });
    worker.once('error', (error) => {
      const phase = spawnObserved ? 'runtime' : 'spawn';
      if (phase === 'spawn') processExited = true;
      protocolController.abort(phase);
      processError = { error, phase };
      armDrainFallback(null);
    });
    worker.once('exit', (code) => {
      processExited = true;
      protocolController.abort('exit');
      armDrainFallback(code);
    });
    worker.once('close', (code) => {
      protocolController.abort('close');
      settle(code);
    });
  }).finally(async () => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    request.signal?.removeEventListener('abort', abort);
    await unlink(payloadPath).catch((error: NodeJS.ErrnoException) => {
      // error-policy:J6 run state is already persisted; teardown reports only
      // unexpected payload cleanup failures through the worker diagnostic path.
      if (error.code !== 'ENOENT') stderr = `${stderr}\n${String(error)}`;
    });
  });
  for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // error-policy:J6 the worker outcome is settled; this only releases a
      // terminal pipe or one whose close event was withheld by inherited child descriptors.
    }
  }
  if (stdoutBuffer && terminationCause !== 'overflow') {
    lineProcessing = lineProcessing.then(() => consumeLine(stdoutBuffer));
  }
  let lineProcessingFailed = false;
  let lineProcessingError: unknown;
  const observedLineProcessing = lineProcessing.catch((error) => {
    // error-policy:J5 this promise is the terminal observer for child protocol
    // work that can outlive a worker which exited before answering its request.
    lineProcessingFailed = true;
    lineProcessingError = error;
  });
  let lineProcessingTimer: NodeJS.Timeout | undefined;
  let releaseLineProcessingTimer: (() => void) | undefined;
  const lineProcessingDeadline = new Promise<void>((resolve) => {
    releaseLineProcessingTimer = resolve;
    lineProcessingTimer = setTimeout(resolve, WORKER_STDIO_DRAIN_GRACE_MS);
  });
  await Promise.race([observedLineProcessing, lineProcessingDeadline]);
  if (lineProcessingTimer) clearTimeout(lineProcessingTimer);
  releaseLineProcessingTimer?.();
  if (lineProcessingFailed) throw lineProcessingError;

  if (outcome.processError) {
    const spawnFailed = outcome.processError.phase === 'spawn';
    throw new ElizaError(
      spawnFailed ? 'Smithers worker could not be started' : 'Smithers worker process failed',
      {
        code: spawnFailed ? 'SMTHRS_WORKER_SPAWN_FAILED' : 'SMTHRS_WORKER_PROCESS_FAILED',
        cause: outcome.processError.error,
        context: {
          workflowId: request.workflow.id,
          ...(terminationCause ? { terminationCause } : {}),
        },
      }
    );
  }
  if (terminationCause === 'abort') {
    return { runId: request.runId, status: 'cancelled', events };
  }
  if (terminationCause === 'timeout') {
    throw new ElizaError(`Smithers workflow timed out after ${timeoutMs}ms`, {
      code: 'SMTHRS_WORKFLOW_TIMEOUT',
      context: { timeoutMs, exitCode: outcome.exitCode, workflowId: request.workflow.id },
      severity: 'ephemeral',
    });
  }
  if (terminationCause === 'overflow') {
    throw new ElizaError('Smithers worker protocol line exceeded the byte budget', {
      code: 'SMTHRS_PROTOCOL_OVERFLOW',
      context: {
        limit: MAX_PROTOCOL_LINE_BYTES,
        exitCode: outcome.exitCode,
        workflowId: request.workflow.id,
      },
    });
  }
  if (workerError) {
    return { runId: request.runId, status: 'failed', error: workerError, events };
  }
  if (!result) {
    const detail = stripVTControlCharacters(
      redactSensitiveText(`${stderr}\n${stdoutNoise}\n${stdinError?.message ?? ''}`)
    ).trim();
    throw new ElizaError(`Smithers worker exited without a result${detail ? `: ${detail}` : ''}`, {
      code: 'SMTHRS_RESULT_MISSING',
      context: { exitCode: outcome.exitCode, workflowId: request.workflow.id },
    });
  }
  return {
    runId: result.runId,
    status: statusFromSmithers(result.status),
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: errorPayload(result.error) } : {}),
    ...(result.nextRunId ? { nextRunId: result.nextRunId } : {}),
    events,
  };
}
