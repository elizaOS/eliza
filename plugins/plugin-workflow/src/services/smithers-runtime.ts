import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    stdin: {
      write(chunk: string): void;
      end(): void;
    };
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
  error?: {
    message: string;
    stack?: string;
  };
}

interface SmithersProtocolResult {
  type: 'workflowResult';
  execution: WorkflowExecution;
}

function sanitizeWorkflowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

function resolveSmithersDbPath(workflowId: string): string {
  const safeId = sanitizeWorkflowName(workflowId || 'anonymous');
  return join(process.cwd(), '.eliza', 'smithers', `${safeId}.sqlite`);
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

function createSmithersScript(): string {
  return String.raw`
    import { Smithers } from 'smithers-orchestrator';
    import { Effect, Schema } from 'effect';
    import { createInterface } from 'node:readline/promises';

    const payload = JSON.parse(process.env.ELIZA_SMITHERS_RUN_PAYLOAD ?? '{}');
    const responses = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const responseIterator = responses[Symbol.asyncIterator]();
    let requestSeq = 0;

    function emit(message) {
      process.stdout.write(JSON.stringify(message) + '\n');
    }

    async function readResponse(requestId) {
      while (true) {
        const next = await responseIterator.next();
        if (next.done) throw new Error('Parent process closed Smithers node protocol');
        const response = JSON.parse(next.value);
        if (response.requestId !== requestId) continue;
        if (!response.ok) {
          const error = new Error(response.error?.message ?? 'Node execution failed');
          if (response.error?.stack) error.stack = response.error.stack;
          throw error;
        }
        return response.outputData ?? [[]];
      }
    }

    function cloneJson(value) {
      return JSON.parse(JSON.stringify(value));
    }

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

    function hasInputItems(inputData) {
      return inputData.some((items) => items.length > 0);
    }

    function makeStepId(index, node) {
      const raw = node.id ?? node.name ?? 'node';
      const safe = String(raw).replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
      return String(index).padStart(4, '0') + '-' + safe;
    }

    try {
      const workflow = Smithers.workflow({ name: payload.workflowName, input: Schema.Unknown });
      const nodeOutputs = {};
      const runData = {};
      let lastNodeExecuted;
      const steps = payload.plan.enabledNodes.map((node, index) =>
        workflow.step(makeStepId(index, node), {
          output: Schema.Unknown,
          run: async () => {
            const incomingConnections = payload.plan.incoming[node.name] ?? [];
            const isStartNode = payload.plan.startNodes.includes(node.name);
            const inputData =
              isStartNode && incomingConnections.length === 0
                ? Object.keys(payload.triggerData ?? {}).length > 0
                  ? [[{ json: payload.triggerData }]]
                  : [[]]
                : collectInputData(node.name, payload.plan.incoming, nodeOutputs);
            const started = Date.now();
            const outputData =
              !isStartNode && incomingConnections.length > 0 && !hasInputItems(inputData)
                ? [[]]
                : await (async () => {
                    const requestId = String(++requestSeq);
                    emit({ type: 'executeNode', requestId, nodeName: node.name, inputData });
                    return readResponse(requestId);
                  })();

            nodeOutputs[node.name] = outputData;
            runData[node.name] = [
              {
                startTime: started,
                executionTime: Date.now() - started,
                data: { main: cloneJson(outputData) },
                source: incomingConnections.map((connection) => ({
                  previousNode: connection.source,
                  previousNodeOutput: connection.sourceOutputIndex,
                  previousNodeRun: 0,
                })),
              },
            ];
            lastNodeExecuted = node.name;
            return { nodeName: node.name, outputData };
          },
        })
      );
      const resultStep = workflow.step('eliza-workflow-result', {
        output: Schema.Unknown,
        run: async () => {
          const stoppedAt = new Date().toISOString();
          return {
            ...payload.pending,
            finished: true,
            status: 'success',
            stoppedAt,
            data: {
              resultData: {
                runData,
                lastNodeExecuted,
              },
            },
          };
        },
      });
      const graph = workflow.sequence(...steps, resultStep);
      const built = workflow.from(graph);
      const execution = await Effect.runPromise(
        built
          .execute(payload.input, {
            runId: payload.executionId,
            force: true,
            rootDir: payload.rootDir ?? process.cwd(),
            allowNetwork: true,
          })
          .pipe(Effect.provide(Smithers.sqlite({ filename: payload.dbPath })))
      );
      emit({ type: 'workflowResult', execution });
      process.exit(0);
    } catch (error) {
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exit(1);
    }
  `;
}

async function handleProtocolLine(
  line: string,
  byName: Map<string, WorkflowNode>,
  runNode: SmithersWorkflowRunOptions['runNode'],
  writeResponse: (response: SmithersProtocolResponse) => void,
  onResult: (execution: WorkflowExecution) => void
): Promise<void> {
  const message = JSON.parse(line) as SmithersProtocolRequest | SmithersProtocolResult;
  if (message.type === 'workflowResult') {
    onResult(message.execution);
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

  try {
    const outputData = await runNode(node, message.inputData);
    writeResponse({ requestId: message.requestId, ok: true, outputData });
  } catch (error) {
    writeResponse({ requestId: message.requestId, ok: false, error: toErrorPayload(error) });
  }
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

  const payload = JSON.stringify({
    dbPath,
    executionId,
    workflowName: sanitizeWorkflowName(workflow.name),
    input: {
      mode,
      triggerData: triggerData ?? {},
      workflowId: workflow.id ?? '',
    },
    pending,
    plan,
    triggerData: triggerData ?? {},
    rootDir: process.cwd(),
  });
  const pluginRoot = await resolvePluginRoot();
  const proc = Bun.spawn([process.execPath, '-e', createSmithersScript()], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      ELIZA_SMITHERS_RUN_PAYLOAD: payload,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const byName = new Map(plan.enabledNodes.map((node) => [node.name, node]));
  let executionResult: WorkflowExecution | null = null;

  const writeResponse = (response: SmithersProtocolResponse): void => {
    proc.stdin.write(`${JSON.stringify(response)}\n`);
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
      for (const line of lines) {
        if (!line.trim()) continue;
        await handleProtocolLine(line, byName, runNode, writeResponse, (execution) => {
          executionResult = execution;
        });
      }
    }
    if (buffer.trim()) {
      await handleProtocolLine(buffer, byName, runNode, writeResponse, (execution) => {
        executionResult = execution;
      });
    }
  };

  const stderrPromise = new Response(proc.stderr).text();
  const exitPromise = proc.exited;
  await Promise.all([readStdout(), exitPromise]);
  const stderr = await stderrPromise;
  const exitCode = await exitPromise;

  proc.stdin.end();

  if (exitCode !== 0) {
    throw new Error(`Smithers workflow execution failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  if (!executionResult) {
    throw new Error('Smithers workflow execution completed without returning a workflow result');
  }
  return executionResult;
}
