/**
 * Executes elizaOS durable controls through the real one-shot Bun child and
 * verifies the public smthrs API mutates the shared SQLite store.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { Effect } from 'effect';
import { openSmithersStore } from 'smthrs';
import {
  controlSmithersRun,
  resolveSmithersWorkflowDir,
  type SmithersControlRequest,
} from '../../src/services/smithers-runtime';

const tenantId = `smithers-controls-test-${process.pid}`;
const workflowId = 'durable-controls';
const rootDir = resolveSmithersWorkflowDir(tenantId, workflowId);
const dbPath = `${rootDir}/runs.sqlite`;

function runRow(runId: string, status: string): Record<string, unknown> {
  const now = Date.now();
  return {
    runId,
    parentRunId: null,
    workflowName: 'controls-test',
    workflowPath: null,
    workflowHash: null,
    status,
    createdAtMs: now,
    startedAtMs: now,
    finishedAtMs: null,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    cancelRequestedAtMs: null,
    hijackRequestedAtMs: null,
    hijackTarget: null,
    vcsType: null,
    vcsRoot: null,
    vcsRevision: null,
    errorJson: null,
    configJson: null,
  };
}

async function withStore<T>(
  mode: 'read' | 'write',
  fn: (adapter: Awaited<ReturnType<typeof openSmithersStore>>['adapter']) => Promise<T>
): Promise<T> {
  if (mode === 'write') await mkdir(rootDir, { recursive: true });
  const store = await openSmithersStore({ mode, backend: 'sqlite', dbPath });
  try {
    return await fn(store.adapter);
  } finally {
    await store.cleanup();
  }
}

async function seedApproval(runId: string, nodeId: string): Promise<void> {
  await withStore('write', async (adapter) => {
    await Effect.runPromise(adapter.insertRun(runRow(runId, 'waiting-approval')));
    await Effect.runPromise(
      adapter.insertNode({
        runId,
        nodeId,
        iteration: 0,
        state: 'waiting-approval',
        lastAttempt: 0,
        updatedAtMs: Date.now(),
        outputTable: '',
        label: nodeId,
      })
    );
    await Effect.runPromise(
      adapter.insertOrUpdateApproval({
        runId,
        nodeId,
        iteration: 0,
        status: 'requested',
        requestedAtMs: Date.now(),
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        requestJson: null,
        decisionJson: null,
        autoApproved: false,
      })
    );
  });
}

async function apply(request: SmithersControlRequest): Promise<void> {
  await controlSmithersRun(tenantId, workflowId, request);
}

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('real Smithers durable controls', () => {
  test('approve executes and persists through the public smthrs API', async () => {
    const runId = 'approve-run';
    const nodeId = 'approval';
    await seedApproval(runId, nodeId);

    await apply({
      kind: 'approve',
      runId,
      nodeId,
      iteration: 0,
      note: 'ship it',
      decidedBy: 'reviewer',
      decision: { accepted: true },
    });

    await withStore('read', async (adapter) => {
      const approval = await Effect.runPromise(adapter.getApproval(runId, nodeId, 0));
      const node = await Effect.runPromise(adapter.getNode(runId, nodeId, 0));
      expect(approval).toMatchObject({
        status: 'approved',
        note: 'ship it',
        decidedBy: 'reviewer',
        decisionJson: JSON.stringify({ accepted: true }),
      });
      expect(node?.state).toBe('pending');
    });
  });

  test('deny executes and persists through the public smthrs API', async () => {
    const runId = 'deny-run';
    const nodeId = 'approval';
    await seedApproval(runId, nodeId);

    await apply({
      kind: 'deny',
      runId,
      nodeId,
      iteration: 0,
      note: 'not safe',
      decidedBy: 'reviewer',
    });

    await withStore('read', async (adapter) => {
      const approval = await Effect.runPromise(adapter.getApproval(runId, nodeId, 0));
      const node = await Effect.runPromise(adapter.getNode(runId, nodeId, 0));
      expect(approval).toMatchObject({
        status: 'denied',
        note: 'not safe',
        decidedBy: 'reviewer',
      });
      expect(node?.state).toBe('failed');
    });
  });

  test('signal executes and persists payload and attribution', async () => {
    const runId = 'signal-run';
    await withStore('write', async (adapter) => {
      await Effect.runPromise(adapter.insertRun(runRow(runId, 'waiting-event')));
    });

    await apply({
      kind: 'signal',
      runId,
      signal: 'customer-replied',
      payload: { ticket: 42 },
      receivedBy: 'webhook',
    });

    await withStore('read', async (adapter) => {
      const signals = await Effect.runPromise(adapter.listSignals(runId));
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        signalName: 'customer-replied',
        payloadJson: JSON.stringify({ ticket: 42 }),
        receivedBy: 'webhook',
      });
    });
  });
});
