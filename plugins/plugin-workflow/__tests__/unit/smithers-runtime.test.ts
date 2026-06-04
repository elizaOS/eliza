import { describe, expect, it } from 'bun:test';
import {
  runWorkflowWithSmithers,
  type SmithersExecutionPlan,
  type SmithersWorkflowRunOptions,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode } from '../../src/types/index';

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
  runNode: RunNode
): Promise<WorkflowExecution> {
  // Unique id per invocation: the Smithers run is keyed by (workflow, runId) in a
  // persistent SQLite file, so a fixed id would short-circuit as "already run" on
  // re-invocation. Production uses a fresh randomUUID executionId per run.
  const uid = `${id}-${Math.random().toString(36).slice(2, 10)}`;
  const workflow: WorkflowDefinition = { id: uid, name: uid, nodes, connections: {} };
  return runWorkflowWithSmithers({
    workflow,
    executionId: `run-${uid}`,
    pending: pendingExecution(uid),
    mode: 'manual',
    triggerData: {},
    plan,
    runNode,
  });
}

describe('runWorkflowWithSmithers (in-process Smithers engine)', () => {
  it('runs independent nodes as a parallel level and routes data through the DAG', async () => {
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
    const runNode: RunNode = async (n, inputData) => {
      calls.push(n.name);
      inputs.set(n.name, inputData);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [[{ json: { node: n.name } }]];
    };

    const result = await run('wf-fanout', nodes, plan, runNode);

    expect(result.status).toBe('success');
    expect(result.finished).toBe(true);
    expect([...calls].sort()).toEqual(['A', 'B', 'C', 'trigger']);
    expect(result.data?.resultData?.lastNodeExecuted).toBe('C');
    // C merges output 0 of A into input 0 and output 0 of B into input 1.
    const cInput = inputs.get('C');
    expect(cInput?.[0]?.[0]?.json).toEqual({ node: 'A' });
    expect(cInput?.[1]?.[0]?.json).toEqual({ node: 'B' });
  }, 60_000);

  it('retries a node according to its n8n retryOnFail / maxTries settings', async () => {
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
    const runNode: RunNode = async (n) => {
      if (n.name === 'R') {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
      }
      return [[{ json: { node: n.name } }]];
    };

    const result = await run('wf-retry', nodes, plan, runNode);

    expect(attempts).toBe(2);
    expect(result.status).toBe('success');
  }, 60_000);

  it('continues and emits an error item when a node sets continueOnFail', async () => {
    const nodes = [node('trigger'), node('F', { continueOnFail: true })];
    const plan: SmithersExecutionPlan = {
      enabledNodes: nodes,
      startNodes: ['trigger'],
      incoming: { F: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }] },
    };
    const runNode: RunNode = async (n) => {
      if (n.name === 'F') throw new Error('boom');
      return [[{ json: { node: n.name } }]];
    };

    const result = await run('wf-continue', nodes, plan, runNode);

    expect(result.status).toBe('success');
    const fRun = result.data?.resultData?.runData?.F as RunDataEntry[] | undefined;
    expect(fRun?.[0]?.data.main[0][0].json.error).toBe('boom');
  }, 60_000);

  it('fails the run when a node throws without retry or continueOnFail', async () => {
    const nodes = [node('trigger'), node('X')];
    const plan: SmithersExecutionPlan = {
      enabledNodes: nodes,
      startNodes: ['trigger'],
      incoming: { X: [{ source: 'trigger', sourceOutputIndex: 0, destinationInputIndex: 0 }] },
    };
    const runNode: RunNode = async (n) => {
      if (n.name === 'X') throw new Error('fatal');
      return [[{ json: { node: n.name } }]];
    };

    await expect(run('wf-fail', nodes, plan, runNode)).rejects.toThrow();
  }, 60_000);
});
