import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode } from '../types/index';

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdin: 'pipe';
      stdout: 'pipe';
      stderr: 'pipe';
    }
  ): {
    stdin: { write(chunk: string): void; end(): void };
    stdout: ReadableStream<BufferSource>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};

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
  workflow: WorkflowDefinition;
  executionId: string;
  pending: WorkflowExecution;
  mode: WorkflowExecution['mode'];
  triggerData?: Record<string, unknown>;
  plan: SmithersExecutionPlan;
  runNode: (
    node: WorkflowNode,
    inputData: SmithersNodeExecutionData[][]
  ) => Promise<SmithersNodeExecutionData[][]>;
}

interface SmithersRunMetrics {
  nodes: number;
  levels: number;
  maxConcurrency: number;
  started: number;
  finished: number;
  failed: number;
  skipped: number;
  retries: number;
}

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

function resolveSmithersDbPath(workflowId: string): string {
  const safeId = sanitizeWorkflowName(workflowId || 'anonymous');
  return join(process.cwd(), '.eliza', 'smithers', `${safeId}.sqlite`);
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
  const raw = process.env.SMITHERS_DB_PROVIDER ?? 'sqlite';
  const provider = raw === 'postgres' || raw === 'pglite' ? raw : 'sqlite';
  return {
    provider,
    connectionString: process.env.SMITHERS_DB_URL,
    dataDir: process.env.SMITHERS_DB_DATA_DIR,
  };
}

async function resolvePluginRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifestPath = join(dir, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name === '@elizaos/plugin-workflow') return dir;
    } catch {
      // Continue walking upward until the plugin package root is found.
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
    import { Smithers } from 'smithers-orchestrator';
    import { Effect, Schema } from 'effect';
    import { createInterface } from 'node:readline/promises';

    const payload = JSON.parse(process.env.ELIZA_SMITHERS_RUN_PAYLOAD ?? '{}');
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Map();
    let requestSeq = 0;
    const metrics = { nodes: 0, levels: 0, maxConcurrency: 0, started: 0, finished: 0, failed: 0, skipped: 0, retries: 0 };

    function emit(message) {
      process.stdout.write(JSON.stringify(message) + '\n');
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
        emit({ type: 'executeNode', requestId, nodeName, inputData });
      });
    }

    function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
    function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    function collectInputData(nodeName, incoming, nodeOutputs) {
      const inputData = [];
      for (const connection of incoming[nodeName] ?? []) {
        const sourceOutputs = nodeOutputs[connection.source] ?? [];
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
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try { return await sendNodeRequest(node.name, inputData); }
        catch (error) { lastError = error; if (attempt < maxAttempts) { metrics.retries += 1; await delay(node.waitBetweenTries ?? 1000); } }
      }
      if (node.continueOnFail) return [[{ json: { error: lastError?.message ?? String(lastError) } }]];
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

      const nodeOutputs = {};
      const runData = {};
      const workflow = Smithers.workflow({ name: payload.workflowName, input: Schema.Unknown });

      const buildStep = (node, index) =>
        workflow.step(makeStepId(index, node), {
          output: Schema.Unknown,
          run: async () => {
            metrics.started += 1;
            const incomingConnections = incoming[node.name] ?? [];
            const isStartNode = startNodes.has(node.name);
            const inputData =
              isStartNode && incomingConnections.length === 0
                ? Object.keys(payload.triggerData ?? {}).length > 0
                  ? [[{ json: payload.triggerData }]]
                  : [[]]
                : collectInputData(node.name, incoming, nodeOutputs);
            const started = Date.now();
            const shouldSkip = !isStartNode && incomingConnections.length > 0 && !hasInputItems(inputData);
            let outputData;
            if (shouldSkip) { outputData = [[]]; metrics.skipped += 1; }
            else {
              try { outputData = await runNodeWithPolicy(node, inputData); }
              catch (error) { metrics.failed += 1; throw error; }
            }
            nodeOutputs[node.name] = outputData;
            runData[node.name] = [{
              startTime: started,
              executionTime: Date.now() - started,
              data: { main: cloneJson(outputData) },
              source: incomingConnections.map((connection) => ({
                previousNode: connection.source,
                previousNodeOutput: connection.sourceOutputIndex,
                previousNodeRun: 0,
              })),
            }];
            metrics.finished += 1;
            return { nodeName: node.name, outputData };
          },
        });

      let stepIndex = 0;
      const levelGraphs = levels.map((level) => {
        const handles = level.map((node) => buildStep(node, stepIndex++));
        return handles.length === 1 ? handles[0] : workflow.parallel(...handles);
      });

      const resultStep = workflow.step('eliza-workflow-result', {
        output: Schema.Unknown,
        run: async () => {
          const stoppedAt = new Date().toISOString();
          return {
            ...payload.pending,
            finished: true,
            status: 'success',
            stoppedAt,
            data: { resultData: { runData, lastNodeExecuted: terminalNodeName } },
          };
        },
      });

      const graph = workflow.sequence(...levelGraphs, resultStep);
      const built = workflow.from(graph);
      // Select the storage backend based on the provider field threaded through
      // the payload. Feature-detect non-sqlite APIs: smithers-orchestrator@0.22.0
      // does not yet expose Smithers.postgres / Smithers.pglite; if the method is
      // absent we degrade to sqlite so old and new builds both work correctly.
      const dbConfig = payload.dbConfig ?? {};
      const provider = dbConfig.provider ?? 'sqlite';
      let smithersLayer;
      if (provider !== 'sqlite' && typeof Smithers[provider] === 'function') {
        if (provider === 'postgres') {
          smithersLayer = Smithers.postgres({ connectionString: dbConfig.connectionString });
        } else if (provider === 'pglite') {
          smithersLayer = Smithers.pglite({ dataDir: dbConfig.dataDir });
        } else {
          smithersLayer = Smithers.sqlite({ filename: payload.dbPath });
        }
      } else {
        smithersLayer = Smithers.sqlite({ filename: payload.dbPath });
      }
      const execution = await Effect.runPromise(
        built
          .execute(payload.input, {
            runId: payload.executionId,
            force: true,
            rootDir: payload.rootDir ?? process.cwd(),
            allowNetwork: true,
          })
          .pipe(Effect.provide(smithersLayer))
      );
      emit({ type: 'workflowResult', execution, metrics });
      process.exit(0);
    } catch (error) {
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exit(1);
    }
  `;
}

export async function runWorkflowWithSmithers({
  workflow,
  executionId,
  pending,
  mode,
  triggerData,
  plan,
  runNode,
}: SmithersWorkflowRunOptions): Promise<WorkflowExecution> {
  const dbPath = resolveSmithersDbPath(workflow.id ?? workflow.name);
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
  const proc = Bun.spawn([process.execPath, '-e', createSmithersScript()], {
    cwd: pluginRoot,
    env: { ...process.env, ELIZA_SMITHERS_RUN_PAYLOAD: payload },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const byName = new Map(plan.enabledNodes.map((node) => [node.name, node]));
  let executionResult: WorkflowExecution | null = null;
  let runMetrics: SmithersRunMetrics | null = null;

  const writeResponse = (response: SmithersProtocolResponse): void => {
    proc.stdin.write(`${JSON.stringify(response)}\n`);
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
      executionResult = message.execution;
      runMetrics = message.metrics ?? null;
      return;
    }
    if (message.type !== 'executeNode') return;
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
          const outputData = await runNode(node, message.inputData);
          writeResponse({ requestId: message.requestId, ok: true, outputData });
        } catch (error) {
          writeResponse({ requestId: message.requestId, ok: false, error: toErrorPayload(error) });
        }
      })()
    );
  };

  const readStdout = async (): Promise<void> => {
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);
  };

  const stderrPromise = new Response(proc.stderr).text();
  const exitPromise = proc.exited;
  await Promise.all([readStdout(), exitPromise]);
  await Promise.all(inflight);
  const stderr = await stderrPromise;
  const exitCode = await exitPromise;

  proc.stdin.end();

  if (exitCode !== 0) {
    throw new Error(`Smithers workflow execution failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  if (!executionResult) {
    throw new Error('Smithers workflow execution completed without returning a workflow result');
  }

  logger.info(
    {
      src: 'plugin:workflow:smithers',
      workflowId: workflow.id ?? '',
      executionId,
      ...(runMetrics ?? {}),
    },
    'workflow executed'
  );

  return executionResult;
}
