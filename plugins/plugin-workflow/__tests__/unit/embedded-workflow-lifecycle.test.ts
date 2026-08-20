/** Exercises native workflow persistence, scheduling, revision restore, and deletion against real SQL. */

import { afterEach, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime, Task, UUID } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WORKFLOW_JSON_UNBOUNDED } from '../../src/services/workflow-json';
import type {
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
} from '../../src/types/index';

const clients: PGlite[] = [];

function definition(name: string): WorkflowDefinition {
  return {
    name,
    description: `${name} description`,
    language: 'tsx',
    source: `import { createSmithers } from 'smthrs/create';
const api = createSmithers({}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
export default api.smithers(() => api.Workflow({ name: '${name}' }));`,
    active: true,
    schedule: { cron: '0 * * * *', timezone: 'UTC', enabled: true },
    steps: [{ id: 'run', label: 'Run', kind: 'task', agent: 'elizaOS' }],
  };
}

async function harness() {
  const client = new PGlite();
  clients.push(client);
  await client.exec(`
    CREATE SCHEMA workflow;
    CREATE TABLE workflow.embedded_workflows (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      version_id text NOT NULL,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.workflow_revisions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      version_id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      captured_at text NOT NULL,
      operation text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, workflow_id, version_id)
    );
    CREATE TABLE workflow.embedded_executions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      status text NOT NULL,
      mode text NOT NULL,
      finished boolean NOT NULL DEFAULT false,
      started_at text NOT NULL,
      stopped_at text,
      execution jsonb NOT NULL,
      idempotency_key text,
      PRIMARY KEY (agent_id, id)
    );
  `);
  const tasks: Task[] = [];
  const runtime = {
    agentId: '00000000-0000-4000-8000-000000000001' as UUID,
    db: drizzle(client, { schema }),
    getTasks: async () => tasks,
    createTask: async (task: Task) => {
      tasks.push({
        ...task,
        id: `00000000-0000-4000-8000-${String(tasks.length + 1).padStart(12, '0')}` as UUID,
      });
      return tasks.at(-1)?.id;
    },
    deleteTask: async (id: UUID) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index >= 0) tasks.splice(index, 1);
    },
    emitEvent: async () => {},
  } as unknown as IAgentRuntime;
  return {
    service: await EmbeddedWorkflowService.start(runtime),
    tasks,
    client,
    runtime,
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('embedded native workflow lifecycle', () => {
  test('snapshots required fields before reads or persistence', async () => {
    const { service } = await harness();
    let sourceReads = 0;
    const unsafe = definition('Unsafe source');
    Object.defineProperty(unsafe, 'source', {
      enumerable: true,
      get() {
        sourceReads += 1;
        return 'must not execute';
      },
    });

    await expect(service.createWorkflow(unsafe)).rejects.toMatchObject({
      statusCode: 400,
      response: { code: WORKFLOW_JSON_UNBOUNDED },
    });
    expect(sourceReads).toBe(0);

    const oversized = definition('Oversized dependencies');
    const dependsOn: string[] = [];
    dependsOn.length = 10_001;
    const baseStep = oversized.steps?.[0];
    if (!baseStep) throw new Error('fixture step is required');
    oversized.steps = [{ ...baseStep, dependsOn }];
    await expect(service.createWorkflow(oversized)).rejects.toMatchObject({
      statusCode: 400,
      response: { code: WORKFLOW_JSON_UNBOUNDED },
    });
    expect((await service.listWorkflows()).data).toHaveLength(0);
  });

  test('validates an update before capturing its current revision', async () => {
    const { service, client } = await harness();
    const created = await service.createWorkflow({ ...definition('Original'), id: 'ordered' });
    const cyclic = definition('Invalid');
    (cyclic as WorkflowDefinition & { cycle?: unknown }).cycle = cyclic;

    await expect(service.updateWorkflow(created.id, cyclic)).rejects.toMatchObject({
      statusCode: 400,
      response: { code: WORKFLOW_JSON_UNBOUNDED },
    });
    expect((await service.getWorkflow(created.id)).name).toBe('Original');
    expect(
      (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow.workflow_revisions WHERE workflow_id = $1',
          [created.id]
        )
      ).rows[0]?.count
    ).toBe(0);

    const updated = await service.updateWorkflow(created.id, definition('Valid next update'));
    expect(updated.name).toBe('Valid next update');
    expect((await service.listWorkflowRevisions(created.id)).data).toHaveLength(1);
  });

  test('rejects unsafe workflow JSON before persistence or accessor execution', async () => {
    const { service } = await harness();
    let calls = 0;
    const inputSchema = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        calls += 1;
        return 'value';
      },
    });

    await expect(
      service.createWorkflow({ ...definition('Unsafe'), inputSchema, id: 'unsafe' })
    ).rejects.toMatchObject({
      statusCode: 400,
      response: { code: WORKFLOW_JSON_UNBOUNDED },
    });
    expect(calls).toBe(0);
    expect((await service.listWorkflows()).data).toHaveLength(0);
  });

  test('creates, schedules, revises, restores, and deletes a Smithers workflow', async () => {
    const { service, tasks } = await harness();
    const created = await service.createWorkflow({ ...definition('Original'), id: 'review' });
    expect((await service.listWorkflows()).data).toHaveLength(1);
    expect(tasks).toHaveLength(1);

    const updated = await service.updateWorkflow('review', {
      ...created,
      name: 'Revised',
      schedule: { cron: '0 * * * *', timezone: 'UTC', enabled: false },
    });
    expect(updated.versionId).not.toBe(created.versionId);
    expect(tasks).toHaveLength(0);
    expect((await service.listWorkflowRevisions('review')).data[0]).toMatchObject({
      versionId: created.versionId,
      operation: 'update',
    });

    const restored = await service.restoreWorkflowRevision('review', created.versionId);
    expect(restored.name).toBe('Original');
    expect(tasks).toHaveLength(1);
    expect((await service.listWorkflowRevisions('review')).data[0]).toMatchObject({
      versionId: updated.versionId,
      operation: 'restore',
    });

    await service.deleteWorkflow('review');
    expect((await service.listWorkflows()).data).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect((await service.listWorkflowRevisions('review')).data[0].operation).toBe('delete');
  }, 15_000);

  test('preserves user-created triggers while synchronizing the owned cron schedule', async () => {
    const { service, tasks, runtime } = await harness();
    const created = await service.createWorkflow({ ...definition('Triggered'), id: 'triggered' });
    const eventTaskId = await runtime.createTask({
      name: 'TRIGGER_DISPATCH',
      description: 'Message trigger',
      tags: ['queue', 'repeat', 'trigger'],
      metadata: {
        updatedAt: Date.now(),
        updateInterval: 31_536_000_000,
        trigger: {
          version: 1,
          triggerId: '00000000-0000-4000-8000-000000000099',
          displayName: 'Message',
          instructions: 'Run workflow Triggered',
          triggerType: 'event',
          enabled: true,
          wakeMode: 'inject_now',
          createdBy: 'workflow.studio',
          eventKind: 'MESSAGE_RECEIVED',
          runCount: 0,
          kind: 'workflow',
          workflowId: created.id,
          workflowName: created.name,
        },
      },
    } as Task);

    await service.activateWorkflow(created.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.some((task) => task.id === eventTaskId)).toBe(true);

    await service.updateWorkflow(created.id, {
      ...created,
      schedule: { cron: '0 * * * *', timezone: 'UTC', enabled: false },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(eventTaskId);

    await service.deleteWorkflow(created.id);
    expect(tasks).toHaveLength(0);
  }, 15_000);

  test('resumes an unfinished persisted run with its exact workflow version', async () => {
    const { service, client, runtime } = await harness();
    const workflow = await service.createWorkflow({
      ...definition('Recovery'),
      id: 'recovery',
      schedule: undefined,
    });
    const execution: WorkflowExecution = {
      id: 'persisted-run',
      workflowId: workflow.id,
      workflowVersionId: workflow.versionId,
      workflowName: workflow.name,
      mode: 'manual',
      status: 'running',
      finished: false,
      startedAt: '2026-08-13T00:00:00.000Z',
      input: { topic: 'resume' },
      events: [],
    };
    await client.query(
      `INSERT INTO workflow.embedded_executions
       (agent_id, id, workflow_id, status, mode, finished, started_at, execution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        runtime.agentId,
        execution.id,
        execution.workflowId,
        execution.status,
        execution.mode,
        execution.finished,
        execution.startedAt,
        JSON.stringify(execution),
      ]
    );

    const resumedVersions: string[] = [];
    const restarted = new EmbeddedWorkflowService(runtime);
    const internals = restarted as unknown as {
      runInBackground: (
        workflow: WorkflowDefinitionResponse,
        pending: WorkflowExecution
      ) => Promise<WorkflowExecution>;
      resumeInterruptedExecutions: () => Promise<void>;
    };
    internals.runInBackground = async (definition, pending) => {
      resumedVersions.push(definition.versionId);
      return { ...pending, status: 'finished', finished: true };
    };
    await internals.resumeInterruptedExecutions();
    await Bun.sleep(0);

    expect(resumedVersions).toEqual([workflow.versionId]);
  }, 15_000);

  test('persists authoritative pending approval details from Smithers events', async () => {
    const { service, client, runtime } = await harness();
    const workflow = await service.createWorkflow({
      ...definition('Approval'),
      id: 'approval',
      schedule: undefined,
    });
    const execution: WorkflowExecution = {
      id: 'approval-run',
      workflowId: workflow.id,
      workflowVersionId: workflow.versionId,
      workflowName: workflow.name,
      mode: 'manual',
      status: 'waiting-approval',
      finished: false,
      startedAt: '2026-08-16T00:00:00.000Z',
      input: {},
      events: [],
      approvals: [],
    };
    await client.query(
      `INSERT INTO workflow.embedded_executions
       (agent_id, id, workflow_id, status, mode, finished, started_at, execution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        runtime.agentId,
        execution.id,
        execution.workflowId,
        execution.status,
        execution.mode,
        execution.finished,
        execution.startedAt,
        JSON.stringify(execution),
      ]
    );

    const internals = service as unknown as {
      recordEvent: (
        execution: WorkflowExecution,
        event: {
          id: string;
          sequence: number;
          runId: string;
          workflowId: string;
          timestamp: string;
          type: string;
          nodeId: string;
          iteration: number;
          payload: Record<string, unknown>;
        }
      ) => Promise<void>;
    };
    await internals.recordEvent(execution, {
      id: 'approval-run:1',
      sequence: 1,
      runId: execution.id,
      workflowId: workflow.id,
      timestamp: '2026-08-16T00:00:01.000Z',
      type: 'ApprovalRequested',
      nodeId: 'publish',
      iteration: 2,
      payload: {
        request: { title: 'Publish', summary: 'Publish the release?' },
      },
    });

    expect((await service.getExecution(execution.id)).approvals).toEqual([
      {
        runId: execution.id,
        workflowId: workflow.id,
        nodeId: 'publish',
        iteration: 2,
        status: 'pending',
        prompt: 'Publish the release?',
        requestedAt: '2026-08-16T00:00:01.000Z',
      },
    ]);
  }, 15_000);
});
