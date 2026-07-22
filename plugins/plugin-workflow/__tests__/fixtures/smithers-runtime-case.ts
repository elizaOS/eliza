/**
 * Test fixture run as a child process by the smithers-runtime suite: executes a
 * workflow through `runWorkflowWithSmithers` and prints a prefixed result line the
 * parent parses. Exercises the real Smithers execution adapter.
 */
import { writeFile } from 'node:fs/promises';
import {
  runWorkflowWithSmithers,
  type SmithersExecutionPlan,
  type SmithersWorkflowRunOptions,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode } from '../../src/types/index';

const RESULT_PREFIX = 'SMITHERS_RUNTIME_CASE_RESULT ';

type RunNode = SmithersWorkflowRunOptions['runNode'];
type NodeInput = Parameters<RunNode>[1];

interface RunDataEntry {
  data: { main: Array<Array<{ json: Record<string, unknown> }>> };
}

function node(name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { name, type: 'test.node', typeVersion: 1, position: [0, 0], parameters: {}, ...extra };
}

function pendingExecution(workflowId: string): WorkflowExecution {
  return {
    id: `exec-${workflowId}`,
    finished: false,
    mode: 'manual',
    startedAt: new Date().toISOString(),
    workflowId,
    status: 'running',
  };
}

function run(
  id: string,
  nodes: WorkflowNode[],
  plan: SmithersExecutionPlan,
  runNode: RunNode,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<WorkflowExecution> {
  const uid = `${id}-${Math.random().toString(36).slice(2, 10)}`;
  const workflow: WorkflowDefinition = { id: uid, name: uid, nodes, connections: {} };
  return runWorkflowWithSmithers({
    tenantId: 'smithers-runtime-fixture-agent',
    workflow,
    executionId: `run-${uid}`,
    pending: pendingExecution(uid),
    mode: 'manual',
    triggerData: {},
    plan,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
    runNode,
  });
}

async function fanoutCase(): Promise<Record<string, unknown>> {
  const calls: string[] = [];
  const inputs = new Map<string, NodeInput>();
  const nodes = [node('trigger'), node('A'), node('B'), node('C')];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['trigger'],
    incoming: {
      A: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }],
      B: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }],
      C: [
        { source: 'A', sourceOutputIndex: 0, destinationInputIndex: 0 },
        { source: 'B', sourceOutputIndex: 0, destinationInputIndex: 1 },
      ],
    },
  };
  const result = await run('wf-fanout', nodes, plan, async (n, inputData) => {
    calls.push(n.name);
    inputs.set(n.name, inputData);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [[{ json: { node: n.name } }]];
  });
  const cInput = inputs.get('C');
  return {
    status: result.status,
    finished: result.finished,
    calls: [...calls].sort(),
    lastNodeExecuted: result.data?.resultData?.lastNodeExecuted,
    cInput0: cInput?.[0]?.[0]?.json,
    cInput1: cInput?.[1]?.[0]?.json,
    engine: result.data?.resultData?.engine,
  };
}

async function retryCase(): Promise<Record<string, unknown>> {
  let attempts = 0;
  const nodes = [
    node('trigger'),
    node('R', { retryOnFail: true, maxTries: 3, waitBetweenTries: 1 }),
  ];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['trigger'],
    incoming: { R: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }] },
  };
  const result = await run('wf-retry', nodes, plan, async (n) => {
    if (n.name === 'R') {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
    }
    return [[{ json: { node: n.name } }]];
  });
  return {
    attempts,
    status: result.status,
    retries: result.data?.resultData?.engine?.retries,
  };
}

async function continueCase(): Promise<Record<string, unknown>> {
  const nodes = [node('trigger'), node('F', { continueOnFail: true })];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['trigger'],
    incoming: { F: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }] },
  };
  const result = await run('wf-continue', nodes, plan, async (n) => {
    if (n.name === 'F') throw new Error('boom');
    return [[{ json: { node: n.name } }]];
  });
  const fRun = result.data?.resultData?.runData?.F as RunDataEntry[] | undefined;
  return {
    status: result.status,
    errorItem: fRun?.[0]?.data.main[0][0].json.error,
  };
}

async function failCase(): Promise<Record<string, unknown>> {
  const nodes = [node('trigger'), node('X')];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['trigger'],
    incoming: { X: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }] },
  };
  try {
    await run('wf-fail', nodes, plan, async (n) => {
      if (n.name === 'X') throw new Error('fatal');
      return [[{ json: { node: n.name } }]];
    });
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { threw: false };
}

async function timeoutCase(): Promise<Record<string, unknown>> {
  const nodes = [node('trigger')];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['trigger'],
    incoming: {},
  };
  try {
    await run('wf-timeout', nodes, plan, async () => new Promise<never>(() => {}), 100);
  } catch (error) {
    return {
      threw: true,
      code:
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined,
    };
  }
  return { threw: false };
}

async function timeoutCancellationCase(): Promise<Record<string, unknown>> {
  const nodes = [node('delayed-side-effect')];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['delayed-side-effect'],
    incoming: {},
  };
  let sideEffectHappened = false;
  let nodeWorkStarted = false;
  let observedAbort = false;
  let code: string | undefined;
  const cancellation = new AbortController();
  try {
    await run(
      'wf-timeout-cancellation',
      nodes,
      plan,
      async (_node, _inputData, signal) => {
        nodeWorkStarted = true;
        return new Promise((resolve, reject) => {
          const cancellationTimer = setTimeout(
            () => cancellation.abort(new Error('cancel requested')),
            25
          );
          const timer = setTimeout(() => {
            sideEffectHappened = true;
            resolve([[{ json: { late: true } }]]);
          }, 5_000);
          const onAbort = (): void => {
            observedAbort = true;
            clearTimeout(cancellationTimer);
            clearTimeout(timer);
            reject(signal.reason ?? new Error('aborted'));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      },
      undefined,
      cancellation.signal
    );
  } catch (error) {
    code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  return { code, nodeWorkStarted, observedAbort, sideEffectHappened };
}

async function largeResultCase(): Promise<Record<string, unknown>> {
  const nodes = [node('large')];
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['large'],
    incoming: {},
  };
  const suffix = 'smithers-large-result';
  const payload = `${'x'.repeat(1024 * 1024 - suffix.length)}${suffix}`;
  const result = await run('wf-large-result', nodes, plan, async () => [[{ json: { payload } }]]);
  const runData = result.data?.resultData?.runData?.large as RunDataEntry[] | undefined;
  const returnedPayload = runData?.[0]?.data.main[0][0].json.payload;
  return {
    status: result.status,
    payloadLength: typeof returnedPayload === 'string' ? returnedPayload.length : -1,
    payloadSuffix: typeof returnedPayload === 'string' ? returnedPayload.slice(-suffix.length) : '',
  };
}

async function crashResumeCase(): Promise<Record<string, unknown>> {
  const uid = `wf-crash-resume-${Math.random().toString(36).slice(2, 10)}`;
  const nodes = [node('side-effect'), node('consumer')];
  const workflow: WorkflowDefinition = { id: uid, name: uid, nodes, connections: {} };
  const plan: SmithersExecutionPlan = {
    enabledNodes: nodes,
    startNodes: ['side-effect'],
    incoming: {
      consumer: [{ source: 'side-effect', sourceOutputIndex: 0, destinationInputIndex: 0 }],
    },
  };
  const executionId = `run-${uid}`;
  const pending = pendingExecution(uid);
  const controller = new AbortController();
  let sideEffectCalls = 0;
  const firstCalls: string[] = [];

  try {
    await runWorkflowWithSmithers({
      tenantId: 'smithers-runtime-fixture-agent',
      workflow,
      executionId,
      pending,
      mode: 'manual',
      triggerData: {},
      plan,
      signal: controller.signal,
      runNode: async (currentNode, _inputData, signal) => {
        firstCalls.push(currentNode.name);
        if (currentNode.name === 'side-effect') {
          sideEffectCalls += 1;
          return [[{ json: { durableToken: 'created-once' } }]];
        }
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
          queueMicrotask(() => controller.abort());
        });
      },
    });
  } catch {
    // The first worker is intentionally killed after the durable side effect.
  }

  const resumedCalls: string[] = [];
  let resumedInput: Record<string, unknown> | undefined;
  const result = await runWorkflowWithSmithers({
    tenantId: 'smithers-runtime-fixture-agent',
    workflow,
    executionId,
    pending,
    mode: 'manual',
    triggerData: {},
    plan,
    runNode: async (currentNode, inputData) => {
      resumedCalls.push(currentNode.name);
      if (currentNode.name === 'side-effect') {
        sideEffectCalls += 1;
        return [[{ json: { durableToken: 'duplicated' } }]];
      }
      resumedInput = inputData[0]?.[0]?.json;
      return [[{ json: { consumed: resumedInput?.durableToken } }]];
    },
  });
  const runData = result.data?.resultData?.runData;

  return {
    status: result.status,
    sideEffectCalls,
    firstCalls,
    resumedCalls,
    resumedInput,
    persistedNodes: Object.keys(runData ?? {}).sort(),
    engine: result.data?.resultData?.engine,
  };
}

const cases: Record<string, () => Promise<Record<string, unknown>>> = {
  fanout: fanoutCase,
  retry: retryCase,
  continue: continueCase,
  fail: failCase,
  timeout: timeoutCase,
  'timeout-cancellation': timeoutCancellationCase,
  'large-result': largeResultCase,
  'crash-resume': crashResumeCase,
};

const caseName = process.argv[2];
const selected = caseName ? cases[caseName] : undefined;

async function writeResult(result: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(result);
  const outputPath = process.env.SMITHERS_RUNTIME_CASE_OUTPUT;
  if (outputPath) await writeFile(outputPath, serialized, 'utf8');
  process.stdout.write(`${RESULT_PREFIX}${serialized}\n`);
}

if (!selected) {
  process.stderr.write(`Unknown Smithers runtime case: ${caseName ?? '<missing>'}\n`);
  process.exitCode = 2;
} else {
  try {
    const result = await selected();
    await writeResult(result);
  } catch (error) {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.stderr.write('\n');
    process.exitCode = 1;
  }
}
