/**
 * Exercises workflow crash recovery with real PGlite persistence and the real
 * Smithers worker. The first worker is killed after an HTTP side effect is
 * durable; a fresh service instance must finish the same execution without
 * issuing that HTTP request again.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stringToUuid } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import {
  resolveSmithersDbPath,
  runWorkflowWithSmithers,
  type SmithersExecutionPlan,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinition, WorkflowExecution } from '../../src/types/index';

async function waitForFinishedExecution(
  service: EmbeddedWorkflowService,
  executionId: string
): Promise<WorkflowExecution> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const execution = await service.getExecution(executionId);
    if (execution.finished) return execution;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`workflow execution ${executionId} did not recover before the deadline`);
}

test('startup resumes a killed execution without duplicating its persisted side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-crash-recovery-'));
  const client = new PGlite({ dataDir: join(root, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const agentId = stringToUuid(`workflow-crash-recovery-${root}`);
  const runtime = {
    agentId,
    character: { settings: { WORKFLOW_SEED_DEFAULTS: 'false' } },
    db,
    getSetting: (key: string) => (key === 'WORKFLOW_SEED_DEFAULTS' ? 'false' : undefined),
    getService: () => null,
    getTasks: async () => [],
    createTask: async () => '00000000-0000-4000-8000-000000000001',
    deleteTask: async () => {},
    reportError: () => {},
  } as never;
  const server = createServer();
  let sideEffectCalls = 0;
  server.on('request', (_request, response) => {
    sideEffectCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ created: sideEffectCalls }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const workflowId = `crash-recovery-${crypto.randomUUID()}`;
  const executionId = `execution-${crypto.randomUUID()}`;
  const smithersDbPath = resolveSmithersDbPath(agentId, workflowId);
  let firstService: EmbeddedWorkflowService | undefined;
  let recoveredService: EmbeddedWorkflowService | undefined;

  try {
    firstService = await EmbeddedWorkflowService.start(runtime);
    const created = await firstService.createWorkflow({
      id: workflowId,
      name: 'Crash recovery',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'side-effect',
          name: 'Create Once',
          type: 'workflows-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: {
            method: 'POST',
            url: `http://127.0.0.1:${address.port}/side-effect`,
            jsonBody: { value: 'once' },
          },
        },
        {
          id: 'finish',
          name: 'Finish',
          type: 'workflows-nodes-base.set',
          typeVersion: 3.4,
          position: [400, 0],
          parameters: {
            assignments: { assignments: [{ name: 'finished', value: true }] },
          },
        },
      ],
      connections: {
        'Manual Trigger': {
          main: [[{ node: 'Create Once', type: 'main', index: 0 }]],
        },
        'Create Once': {
          main: [[{ node: 'Finish', type: 'main', index: 0 }]],
        },
      },
    });
    const workflow = created as WorkflowDefinition;
    const pending: WorkflowExecution = {
      id: executionId,
      workflowId,
      mode: 'manual',
      status: 'running',
      finished: false,
      startedAt: new Date().toISOString(),
      customData: {
        smithersResumeState: { version: 1, workflow },
      },
    };
    await db.insert(dbSchema.embeddedExecutions).values({
      agentId,
      id: executionId,
      workflowId,
      status: 'running',
      mode: 'manual',
      finished: false,
      startedAt: pending.startedAt,
      stoppedAt: null,
      execution: pending,
      idempotencyKey: null,
    });

    const plan: SmithersExecutionPlan = {
      enabledNodes: workflow.nodes,
      startNodes: ['Manual Trigger'],
      incoming: {
        'Create Once': [
          { source: 'Manual Trigger', sourceOutputIndex: 0, destinationInputIndex: 0 },
        ],
        Finish: [{ source: 'Create Once', sourceOutputIndex: 0, destinationInputIndex: 0 }],
      },
    };
    const controller = new AbortController();
    await expect(
      runWorkflowWithSmithers({
        tenantId: agentId,
        workflow,
        executionId,
        pending,
        mode: 'manual',
        plan,
        signal: controller.signal,
        runNode: async (node, _inputData, signal) => {
          if (node.name === 'Manual Trigger') return [[{ json: { started: true } }]];
          if (node.name === 'Create Once') {
            const response = await fetch(`http://127.0.0.1:${address.port}/side-effect`, {
              method: 'POST',
              signal,
            });
            return [[{ json: (await response.json()) as Record<string, unknown> }]];
          }
          return new Promise((_resolve, reject) => {
            const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
            queueMicrotask(() => controller.abort());
          });
        },
      })
    ).rejects.toMatchObject({ code: 'SMITHERS_WORKFLOW_ABORTED' });
    expect(sideEffectCalls).toBe(1);

    await firstService.stop();
    recoveredService = await EmbeddedWorkflowService.start(runtime);
    const recovered = await waitForFinishedExecution(recoveredService, executionId);

    expect(recovered).toMatchObject({
      id: executionId,
      workflowId,
      status: 'success',
      finished: true,
    });
    expect(sideEffectCalls).toBe(1);
    expect(Object.keys(recovered.data?.resultData?.runData ?? {}).sort()).toEqual([
      'Create Once',
      'Finish',
      'Manual Trigger',
    ]);
    expect(recovered.data?.resultData?.engine).toMatchObject({
      provider: 'smithers',
      nodes: 3,
      started: 3,
      finished: 3,
    });
  } finally {
    await recoveredService?.stop();
    await firstService?.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
    await rm(root, { recursive: true, force: true });
    await Promise.all([
      rm(smithersDbPath, { force: true }),
      rm(`${smithersDbPath}-wal`, { force: true }),
      rm(`${smithersDbPath}-shm`, { force: true }),
    ]);
  }
}, 120_000);
