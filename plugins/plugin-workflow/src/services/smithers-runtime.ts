/**
 * Adapter that runs a workflow's node graph through the Smithers orchestrator.
 * Translates the plugin's WorkflowDefinition into the Smithers execution plan,
 * spawns a Bun worker (Smithers needs `bun:sqlite`) to run it, and maps the
 * result back to a WorkflowExecution with engine metrics. Definitions and
 * trigger data cross a dedicated pipe so provider secrets and run payloads do
 * not enter the worker environment; each run has a wall-clock deadline.
 *
 * Consumed by EmbeddedWorkflowService as the node-execution backend. Reads
 * optional `SMITHERS_DB_*`, `ELIZA_SMITHERS_TIMEOUT_MS`, and `BUN_BIN` env vars.
 * Failed delegated nodes are echoed before Smithers' wrapper error so execution
 * diagnostics retain the original node error.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElizaError, logger } from '@elizaos/core';
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowExecutionEngineMetrics,
  WorkflowNode,
} from '../types/index';

interface SmithersNodeExecutionData {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number } | Array<{ item: number }>;
}

interface SmithersIncomingConnection {
  source: string;
  sourceOutputIndex: number;
  destinationInputIndex: number;
}

export interface SmithersExecutionPlan {
  enabledNodes: WorkflowNode[];
  startNodes: string[];
  incoming: Record<string, SmithersIncomingConnection[]>;
}

export interface SmithersWorkflowRunOptions {
  tenantId: string;
  workflow: WorkflowDefinition;
  executionId: string;
  pending: WorkflowExecution;
  mode: WorkflowExecution['mode'];
  triggerData?: Record<string, unknown>;
  plan: SmithersExecutionPlan;
  timeoutMs?: number;
  signal?: AbortSignal;
  runNode: (
    node: WorkflowNode,
    inputData: SmithersNodeExecutionData[][],
    signal: AbortSignal
  ) => Promise<SmithersNodeExecutionData[][]>;
}

const DEFAULT_SMITHERS_TIMEOUT_MS = 300_000;
const SMITHERS_WORKER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
] as const;

type SmithersRunMetrics = Omit<WorkflowExecutionEngineMetrics, 'provider'>;

interface SmithersProtocolRequest {
  type: 'executeNode';
  requestId: string;
  nodeName: string;
  inputData: SmithersNodeExecutionData[][];
}

interface SmithersProtocolResponse {
  requestId: string;
  ok: boolean;
  outputData?: SmithersNodeExecutionData[][];
  error?: { message: string; stack?: string };
}

interface SmithersProtocolResult {
  type: 'workflowResult';
  execution: WorkflowExecution;
  metrics?: SmithersRunMetrics;
}

function sanitizeWorkflowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

export function resolveSmithersDbPath(tenantId: string, workflowId: string): string {
  if (!tenantId.trim()) {
    throw new ElizaError('Smithers database paths require an agent tenant id', {
      code: 'SMITHERS_TENANT_REQUIRED',
      context: { workflowId },
    });
  }
  const safeTenantId = sanitizeWorkflowName(tenantId);
  const safeId = sanitizeWorkflowName(workflowId || 'anonymous');
  return join(process.cwd(), '.eliza', 'smithers', safeTenantId, `${safeId}.sqlite`);
}

function resolveBunBinary(): string {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return process.execPath;
  return process.env.BUN_BIN || 'bun';
}

/**
 * Resolve the Smithers storage backend configuration from environment variables.
 *
 * SMITHERS_DB_PROVIDER: "sqlite" (default) | "postgres" | "pglite"
 * SMITHERS_DB_URL:      PostgreSQL connection string (used when provider = "postgres")
 * SMITHERS_DB_DATA_DIR: PGlite data directory (used when provider = "pglite")
 *
 * The resolved config is threaded through the subprocess payload so the layer
 * selection runs inside the subprocess script string.
 */
export function resolveSmithersDbConfig(): {
  provider: 'sqlite' | 'postgres' | 'pglite';
  connectionString?: string;
  dataDir?: string;
} {
  const provider = (process.env.SMITHERS_DB_PROVIDER ?? 'sqlite').trim().toLowerCase();
  if (provider !== 'sqlite' && provider !== 'postgres' && provider !== 'pglite') {
    throw new ElizaError(`Unsupported Smithers database provider: ${provider}`, {
      code: 'SMITHERS_DB_PROVIDER_INVALID',
      context: { provider },
    });
  }
  if (provider === 'postgres') {
    const connectionString = process.env.SMITHERS_DB_URL?.trim();
    if (!connectionString) {
      throw new ElizaError('SMITHERS_DB_URL is required for the postgres backend', {
        code: 'SMITHERS_DB_URL_REQUIRED',
        context: { provider },
      });
    }
    return { provider, connectionString };
  }
  if (provider === 'pglite') {
    const dataDir = process.env.SMITHERS_DB_DATA_DIR?.trim();
    if (!dataDir) {
      throw new ElizaError('SMITHERS_DB_DATA_DIR is required for the pglite backend', {
        code: 'SMITHERS_DB_DATA_DIR_REQUIRED',
        context: { provider },
      });
    }
    return { provider, dataDir };
  }
  return { provider };
}

export function resolveSmithersTimeoutMs(explicitTimeoutMs?: number): number {
  const configured =
    explicitTimeoutMs ??
    (process.env.ELIZA_SMITHERS_TIMEOUT_MS
      ? Number(process.env.ELIZA_SMITHERS_TIMEOUT_MS)
      : DEFAULT_SMITHERS_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new ElizaError('Smithers timeout must be a positive number of milliseconds', {
      code: 'SMITHERS_TIMEOUT_INVALID',
      context: { configured },
    });
  }
  return configured;
}

async function resolvePluginRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifestPath = join(dir, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name === '@elizaos/plugin-workflow') return dir;
    } catch {
      // error-policy:J3 each missing or unreadable manifest is the explicit
      // "not the package root" probe result, so continue walking upward.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function toErrorPayload(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

export function buildSmithersWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SMITHERS_WORKER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Source for the per-run Smithers subprocess. Each workflow run executes in a
 * fresh Bun process so the global Smithers singleton + SQLite state stay isolated
 * (a long-lived singleton degrades across runs) and so Bun's `bun:sqlite` is
 * available (Smithers requires it).
 *
 * The node graph is built with native Smithers control flow: dependency-depth
 * levels become `parallel` groups joined in `sequence`, so independent nodes run
 * concurrently instead of strictly serially. Node execution is delegated back to
 * the parent over a line-delimited stdin/stdout protocol; a map-based response
 * reader lets concurrent in-flight requests from a parallel level resolve without
 * racing. Per-node n8n retry / continue-on-fail is honoured, and per-run metrics
 * are reported back.
 */
function createSmithersScript(): string {
  return String.raw`
    import { Smithers } from '@smithers-orchestrator/engine';
    import { Effect, Schema } from 'effect';
    import { readFileSync } from 'node:fs';
    import { createInterface } from 'node:readline/promises';

    const payload = JSON.parse(readFileSync(3, 'utf8'));
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Map();
    let requestSeq = 0;
    const metrics = { nodes: 0, levels: 0, maxConcurrency: 0, started: 0, finished: 0, failed: 0, skipped: 0, retries: 0 };
    let lastNodeError = null;

    function emit(message) {
      return new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify(message) + '\n', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    (async () => {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        const entry = pending.get(response.requestId);
        if (!entry) continue;
        pending.delete(response.requestId);
        if (!response.ok) {
          const error = new Error(response.error?.message ?? 'Node execution failed');
          if (response.error?.stack) error.stack = response.error.stack;
          entry.reject(error);
        } else {
          entry.resolve(response.outputData ?? [[]]);
        }
      }
    })();

    function sendNodeRequest(nodeName, inputData) {
      const requestId = String(++requestSeq);
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        emit({ type: 'executeNode', requestId, nodeName, inputData }).catch((error) => {
          // error-policy:J1 translate a failed worker-protocol write into the
          // pending node promise observed by the workflow execution boundary.
          pending.delete(requestId);
          reject(error);
        });
      });
    }

    function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
    function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    function collectInputData(nodeName, incoming, dependencyResults) {
      const inputData = [];
      for (const connection of incoming[nodeName] ?? []) {
        const sourceOutputs = dependencyResults[connection.source]?.outputData ?? [];
        const sourceItems = sourceOutputs[connection.sourceOutputIndex] ?? [];
        inputData[connection.destinationInputIndex] = [
          ...(inputData[connection.destinationInputIndex] ?? []),
          ...sourceItems,
        ];
      }
      return inputData.length > 0 ? inputData : [[]];
    }

    function hasInputItems(inputData) { return inputData.some((items) => items.length > 0); }

    function makeStepId(index, node) {
      const raw = node.id ?? node.name ?? 'node';
      const safe = String(raw).replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
      return String(index).padStart(4, '0') + '-' + safe;
    }

    // Group topologically-ordered nodes into dependency-depth levels; nodes in a
    // level have no data dependency on each other and run concurrently.
    function computeLevels(enabledNodes, incoming, startNodes, nodeByName) {
      const depth = new Map();
      for (const node of enabledNodes) {
        const connections = (incoming[node.name] ?? []).filter((c) => nodeByName.has(c.source));
        if (startNodes.has(node.name) || connections.length === 0) { depth.set(node.name, 0); continue; }
        let nodeDepth = 0;
        for (const connection of connections) nodeDepth = Math.max(nodeDepth, (depth.get(connection.source) ?? 0) + 1);
        depth.set(node.name, nodeDepth);
      }
      const levels = [];
      for (const node of enabledNodes) {
        const nodeDepth = depth.get(node.name) ?? 0;
        (levels[nodeDepth] ??= []).push(node);
      }
      return levels.filter((level) => level && level.length > 0);
    }

    // Honour the node's own n8n retry / continue-on-fail settings.
    async function runNodeWithPolicy(node, inputData) {
      const maxAttempts = node.retryOnFail ? Math.max(1, node.maxTries ?? 3) : 1;
      let lastError;
      let retries = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try { return { outputData: await sendNodeRequest(node.name, inputData), retries }; }
        catch (error) {
          lastError = error;
          lastNodeError = { nodeName: node.name, message: error?.message ?? String(error) };
          if (attempt < maxAttempts) {
            retries += 1;
            metrics.retries += 1;
            await delay(node.waitBetweenTries ?? 1000);
          }
        }
      }
      if (node.continueOnFail) {
        return {
          outputData: [[{ json: { error: lastError?.message ?? String(lastError) } }]],
          retries,
        };
      }
      throw lastError;
    }

    try {
      const enabledNodes = payload.plan.enabledNodes;
      const incoming = payload.plan.incoming;
      const startNodes = new Set(payload.plan.startNodes);
      const nodeByName = new Map(enabledNodes.map((node) => [node.name, node]));
      const levels = computeLevels(enabledNodes, incoming, startNodes, nodeByName);
      const terminalNodeName = enabledNodes[enabledNodes.length - 1]?.name;
      metrics.nodes = enabledNodes.length;
      metrics.levels = levels.length;
      metrics.maxConcurrency = levels.reduce((max, level) => Math.max(max, level.length), 0);

      const workflow = Smithers.workflow({ name: payload.workflowName, input: Schema.Unknown });

      const handlesByNode = new Map();
      const buildStep = (node, index) => {
        const incomingConnections = incoming[node.name] ?? [];
        const dependencyKeys = new Map();
        const needs = {};
        for (const connection of incomingConnections) {
          if (!nodeByName.has(connection.source)) continue;
          if (dependencyKeys.has(connection.source)) continue;
          const sourceHandle = handlesByNode.get(connection.source);
          if (!sourceHandle) {
            throw new Error('Workflow dependency was not built before node: ' + connection.source + ' -> ' + node.name);
          }
          const key = 'dependency' + dependencyKeys.size;
          dependencyKeys.set(connection.source, key);
          needs[key] = sourceHandle;
        }
        const handle = workflow.step(makeStepId(index, node), {
          output: Schema.Unknown,
          ...(Object.keys(needs).length > 0 ? { needs } : {}),
          run: async (ctx) => {
            metrics.started += 1;
            const dependencyResults = {};
            for (const [source, key] of dependencyKeys) dependencyResults[source] = ctx[key];
            const isStartNode = startNodes.has(node.name);
            const inputData =
              isStartNode && incomingConnections.length === 0
                ? Object.keys(payload.triggerData ?? {}).length > 0
                  ? [[{ json: payload.triggerData }]]
                  : [[]]
                : collectInputData(node.name, incoming, dependencyResults);
            const started = Date.now();
            const shouldSkip = !isStartNode && incomingConnections.length > 0 && !hasInputItems(inputData);
            let outputData;
            let retries = 0;
            if (shouldSkip) { outputData = [[]]; metrics.skipped += 1; }
            else {
              try {
                const result = await runNodeWithPolicy(node, inputData);
                outputData = result.outputData;
                retries = result.retries;
              }
              catch (error) { metrics.failed += 1; throw error; }
            }
            const runEntry = {
              startTime: started,
              executionTime: Date.now() - started,
              data: { main: cloneJson(outputData) },
              source: incomingConnections.map((connection) => ({
                previousNode: connection.source,
                previousNodeOutput: connection.sourceOutputIndex,
                previousNodeRun: 0,
              })),
            };
            metrics.finished += 1;
            return {
              nodeName: node.name,
              outputData,
              runEntry,
              skipped: shouldSkip,
              retries,
            };
          },
        });
        handlesByNode.set(node.name, handle);
        return handle;
      };

      let stepIndex = 0;
      const levelGraphs = levels.map((level) => {
        const handles = level.map((node) => buildStep(node, stepIndex++));
        return handles.length === 1 ? handles[0] : workflow.parallel(...handles);
      });

      const resultNeeds = {};
      enabledNodes.forEach((node, index) => {
        resultNeeds['node' + index] = handlesByNode.get(node.name);
      });
      const resultStep = workflow.step('eliza-workflow-result', {
        output: Schema.Unknown,
        needs: resultNeeds,
        run: async (ctx) => {
          const runData = {};
          let durableSkipped = 0;
          let durableRetries = 0;
          let durableFinished = 0;
          enabledNodes.forEach((node, index) => {
            const result = ctx['node' + index];
            if (!result || result.nodeName !== node.name || !result.runEntry) {
              throw new Error('Missing durable output for workflow node: ' + node.name);
            }
            runData[node.name] = [result.runEntry];
            durableFinished += 1;
            if (result.skipped === true) durableSkipped += 1;
            if (Number.isInteger(result.retries) && result.retries > 0) durableRetries += result.retries;
          });
          const stoppedAt = new Date().toISOString();
          return {
            ...payload.pending,
            finished: true,
            status: 'success',
            stoppedAt,
            data: {
              resultData: {
                runData,
                lastNodeExecuted: terminalNodeName,
                engine: {
                  provider: 'smithers',
                  nodes: enabledNodes.length,
                  levels: levels.length,
                  maxConcurrency: levels.reduce((max, level) => Math.max(max, level.length), 0),
                  started: durableFinished,
                  finished: durableFinished,
                  failed: 0,
                  skipped: durableSkipped,
                  retries: durableRetries,
                },
              },
            },
          };
        },
      });

      const graph = workflow.sequence(...levelGraphs, resultStep);
      const built = workflow.from(graph);
      // The configured backend is an operational contract. Falling back to a
      // local database would make a shared deployment look healthy while losing
      // durability and cross-instance visibility.
      const dbConfig = payload.dbConfig ?? {};
      const provider = dbConfig.provider ?? 'sqlite';
      let smithersLayer;
      if (provider === 'sqlite') {
        smithersLayer = Smithers.sqlite({ filename: payload.dbPath });
      } else if (provider === 'postgres' && typeof Smithers.postgres === 'function') {
        smithersLayer = Smithers.postgres({ connectionString: dbConfig.connectionString });
      } else if (provider === 'pglite' && typeof Smithers.pglite === 'function') {
        smithersLayer = Smithers.pglite({ dataDir: dbConfig.dataDir });
      } else {
        throw new Error('Configured Smithers backend is unavailable: ' + provider);
      }
      const execution = await Effect.runPromise(
        built
          .execute(payload.input, {
            runId: payload.executionId,
            force: false,
            rootDir: payload.rootDir ?? process.cwd(),
            allowNetwork: true,
          })
          .pipe(Effect.provide(smithersLayer))
      );
      // process.exit() does not drain stdout. Await the write callback so a
      // result larger than the pipe's kernel buffer reaches the parent intact.
      await emit({ type: 'workflowResult', execution, metrics });
      process.exit(0);
    } catch (error) {
      if (lastNodeError) {
        console.error('Node "' + lastNodeError.nodeName + '" failed: ' + lastNodeError.message);
      }
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exit(1);
    }
  `;
}

export async function runWorkflowWithSmithers({
  tenantId,
  workflow,
  executionId,
  pending,
  mode,
  triggerData,
  plan,
  timeoutMs: explicitTimeoutMs,
  signal: externalSignal,
  runNode,
}: SmithersWorkflowRunOptions): Promise<WorkflowExecution> {
  const dbPath = resolveSmithersDbPath(tenantId, workflow.id ?? workflow.name);
  await mkdir(dirname(dbPath), { recursive: true });
  const dbConfig = resolveSmithersDbConfig();

  const payload = JSON.stringify({
    dbPath,
    dbConfig,
    executionId,
    workflowName: sanitizeWorkflowName(workflow.name),
    input: { mode, triggerData: triggerData ?? {}, workflowId: workflow.id ?? '' },
    pending,
    plan,
    triggerData: triggerData ?? {},
    rootDir: process.cwd(),
  });
  const pluginRoot = await resolvePluginRoot();
  const timeoutMs = resolveSmithersTimeoutMs(explicitTimeoutMs);
  const proc = spawn(resolveBunBinary(), ['-e', createSmithersScript()], {
    cwd: pluginRoot,
    env: buildSmithersWorkerEnv(),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const payloadInput = proc.stdio[3];
  if (!payloadInput || typeof (payloadInput as { end?: unknown }).end !== 'function') {
    proc.kill('SIGKILL');
    throw new ElizaError('Smithers worker payload pipe was not created', {
      code: 'SMITHERS_PAYLOAD_PIPE_MISSING',
      context: { workflowId: workflow.id ?? '', executionId },
    });
  }
  (payloadInput as NodeJS.WritableStream).end(payload);
  const byName = new Map(plan.enabledNodes.map((node) => [node.name, node]));
  let executionResult: WorkflowExecution | null = null;
  let runMetrics: SmithersRunMetrics | null = null;
  let protocolError: ElizaError | null = null;
  let stdinEnded = false;
  let externallyAborted = externalSignal?.aborted === true;
  const executionAbort = new AbortController();

  const killWorker = (reason: unknown): void => {
    if (!executionAbort.signal.aborted) executionAbort.abort(reason);
    try {
      proc.kill('SIGKILL');
    } catch {
      // error-policy:J6 best-effort worker teardown; close/error remains the
      // authoritative observation for the subprocess lifecycle.
    }
  };

  const onExternalAbort = (): void => {
    externallyAborted = true;
    killWorker(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const endStdin = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    proc.stdin.end();
  };

  const writeResponse = (response: SmithersProtocolResponse): void => {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(response)}\n`);
  };

  // Node executions are dispatched concurrently so a parallel level's nodes
  // actually run in parallel; their promises are drained before completion.
  const inflight: Promise<void>[] = [];
  const handleLine = (line: string): void => {
    // The subprocess shares stdout with Smithers' own logging; only our protocol
    // JSON is relevant, so ignore anything that isn't an object line.
    const trimmed = line.trim();
    if (trimmed?.[0] !== '{') return;
    let message: SmithersProtocolRequest | SmithersProtocolResult;
    try {
      message = JSON.parse(trimmed) as SmithersProtocolRequest | SmithersProtocolResult;
    } catch {
      return;
    }
    if (message.type === 'workflowResult') {
      if (!message.execution || typeof message.execution !== 'object') {
        protocolError = new ElizaError('Smithers returned an invalid workflow result', {
          code: 'SMITHERS_PROTOCOL_INVALID',
          context: { workflowId: workflow.id ?? '', executionId },
        });
        killWorker(protocolError);
        return;
      }
      executionResult = message.execution;
      runMetrics = message.metrics ?? null;
      endStdin();
      return;
    }
    if (message.type !== 'executeNode') return;
    if (
      typeof message.requestId !== 'string' ||
      typeof message.nodeName !== 'string' ||
      !Array.isArray(message.inputData)
    ) {
      protocolError = new ElizaError('Smithers returned an invalid node execution request', {
        code: 'SMITHERS_PROTOCOL_INVALID',
        context: { workflowId: workflow.id ?? '', executionId },
      });
      killWorker(protocolError);
      return;
    }
    const node = byName.get(message.nodeName);
    if (!node) {
      writeResponse({
        requestId: message.requestId,
        ok: false,
        error: { message: `Smithers requested unknown workflow node "${message.nodeName}"` },
      });
      return;
    }
    inflight.push(
      (async () => {
        try {
          const outputData = await runNode(node, message.inputData, executionAbort.signal);
          writeResponse({ requestId: message.requestId, ok: true, outputData });
        } catch (error) {
          writeResponse({ requestId: message.requestId, ok: false, error: toErrorPayload(error) });
        }
      })()
    );
  };

  let stdoutBuffer = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      killWorker(new Error(`Smithers workflow deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once('error', (error) => {
      clearTimeout(timeout);
      if (!executionAbort.signal.aborted) executionAbort.abort(error);
      reject(error);
    });
    proc.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
  externalSignal?.removeEventListener('abort', onExternalAbort);
  if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
  if (exitCode === 0) {
    await Promise.all(inflight);
  } else {
    if (!executionAbort.signal.aborted) {
      executionAbort.abort(new Error(`Smithers workflow worker exited with code ${exitCode}`));
    }
    // Cooperative node work should settle promptly after cancellation, while a
    // third-party node that ignores AbortSignal must not hold the API forever.
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  endStdin();

  if (protocolError) throw protocolError;
  if (externallyAborted) {
    throw new ElizaError('Smithers workflow execution was aborted', {
      code: 'SMITHERS_WORKFLOW_ABORTED',
      context: { workflowId: workflow.id ?? '', executionId },
      severity: 'ephemeral',
    });
  }
  if (timedOut) {
    throw new ElizaError(`Smithers workflow execution timed out after ${timeoutMs}ms`, {
      code: 'SMITHERS_WORKFLOW_TIMEOUT',
      context: { workflowId: workflow.id ?? '', executionId, timeoutMs },
      severity: 'ephemeral',
    });
  }

  if (exitCode !== 0) {
    throw new ElizaError(
      `Smithers workflow execution failed: ${stderr.trim() || `exit ${exitCode}`}`,
      {
        code: 'SMITHERS_WORKFLOW_FAILED',
        context: { workflowId: workflow.id ?? '', executionId, exitCode },
        severity: 'ephemeral',
      }
    );
  }
  if (!executionResult) {
    throw new ElizaError(
      'Smithers workflow execution completed without returning a workflow result',
      {
        code: 'SMITHERS_WORKFLOW_RESULT_MISSING',
        context: { workflowId: workflow.id ?? '', executionId },
      }
    );
  }
  const completedExecution = executionResult as WorkflowExecution;
  const completedMetrics = runMetrics as SmithersRunMetrics | null;
  const executionWithMetrics: WorkflowExecution = completedExecution.data?.resultData?.engine
    ? completedExecution
    : completedMetrics
      ? {
          ...completedExecution,
          data: {
            ...completedExecution.data,
            resultData: {
              ...completedExecution.data?.resultData,
              engine: {
                provider: 'smithers',
                nodes: completedMetrics.nodes,
                levels: completedMetrics.levels,
                maxConcurrency: completedMetrics.maxConcurrency,
                started: completedMetrics.started,
                finished: completedMetrics.finished,
                failed: completedMetrics.failed,
                skipped: completedMetrics.skipped,
                retries: completedMetrics.retries,
              },
            },
          },
        }
      : completedExecution;

  logger.info(
    {
      src: 'plugin:workflow:smithers',
      workflowId: workflow.id ?? '',
      executionId,
      ...(runMetrics ?? {}),
    },
    'workflow executed'
  );

  return executionWithMetrics;
}
