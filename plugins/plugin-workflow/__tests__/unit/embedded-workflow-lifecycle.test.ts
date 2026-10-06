/** Exercises native workflow persistence, scheduling, revision restore, and deletion against real SQL. */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime, Task, UUID } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';
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
    CREATE TABLE workflow.lifecycle_mutations (
      agent_id text NOT NULL, workflow_id text NOT NULL, mutation_id text NOT NULL,
      owner_id text NOT NULL, expected_version_id text NOT NULL, operation text NOT NULL,
      receipt jsonb NOT NULL, PRIMARY KEY (agent_id, workflow_id, mutation_id)
    );
    CREATE TABLE workflow.embedded_tags (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, name)
    );
  `);
  const tasks: Task[] = [];
  const emittedEvents: Array<{ type: string; payload: unknown }> = [];
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
    emitEvent: async (type: string, payload: unknown) => {
      emittedEvents.push({ type, payload });
    },
  } as unknown as IAgentRuntime;
  return {
    service: await EmbeddedWorkflowService.start(runtime),
    tasks,
    client,
    runtime,
    emittedEvents,
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('embedded native workflow lifecycle', () => {
  test('gets or creates one durable tenant tag across duplicates and restart', async () => {
    const { service, runtime } = await harness();

    await expect(service.getOrCreateTag('   ')).rejects.toMatchObject({ statusCode: 400 });

    const [first, duplicate] = await Promise.all([
      service.getOrCreateTag(' scenario-owner '),
      service.getOrCreateTag('scenario-owner'),
    ]);
    expect(duplicate).toEqual(first);
    expect((await service.listTags()).data).toEqual([first]);

    const restarted = new EmbeddedWorkflowService(runtime);
    expect(await restarted.getOrCreateTag('scenario-owner')).toEqual(first);

    const workflow = await service.createWorkflow({ ...definition('Tagged'), id: 'tagged' });
    await expect(service.updateWorkflowTags(workflow.id, ['missing-tag'])).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await service.updateWorkflowTags(workflow.id, [first.id])).toEqual([first]);
    expect((await service.getWorkflow(workflow.id)).tags).toEqual([first]);
  });

  test('snapshots required fields before reads or persistence', async () => {
    const { service } = await harness();
    await expect(
      service.createWorkflow(null as unknown as WorkflowDefinition)
    ).rejects.toMatchObject({ statusCode: 400 });

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
    let metadataReads = 0;
    const unsafeMetadata = definition('Unsafe metadata');
    Object.defineProperty(unsafeMetadata, 'metadata', {
      enumerable: true,
      get() {
        metadataReads++;
        return {};
      },
    });
    await expect(service.createWorkflow(unsafeMetadata)).rejects.toMatchObject({
      statusCode: 400,
      response: { code: WORKFLOW_JSON_UNBOUNDED },
    });
    expect(metadataReads).toBe(0);
    await expect(
      service.createWorkflow({
        ...definition('Invalid metadata'),
        metadata: 'bad',
      } as unknown as WorkflowDefinition)
    ).rejects.toMatchObject({ statusCode: 400 });

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

  test('treats an explicit workflow or execution limit of 0 as an empty page', async () => {
    const { service, client, runtime } = await harness();
    await service.createWorkflow({ ...definition('First'), id: 'first', schedule: undefined });
    await service.createWorkflow({ ...definition('Second'), id: 'second', schedule: undefined });

    expect((await service.listWorkflows({ limit: 0 })).data).toEqual([]);
    expect((await service.listWorkflows({ limit: 1 })).data).toHaveLength(1);
    expect((await service.listWorkflows()).data).toHaveLength(2);

    for (const id of ['run-a', 'run-b']) {
      const execution: WorkflowExecution = {
        id,
        workflowId: 'first',
        workflowVersionId: 'version',
        workflowName: 'First',
        mode: 'manual',
        status: 'finished',
        finished: true,
        startedAt: '2026-08-13T00:00:00.000Z',
        input: {},
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
    }

    expect((await service.listExecutions({ limit: 0 })).data).toEqual([]);
    expect((await service.listExecutions({ limit: 1 })).data).toHaveLength(1);
    expect((await service.listExecutions()).data).toHaveLength(2);
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

  test('rolls back revision capture when the workflow update fails', async () => {
    const { service, client } = await harness();
    const created = await service.createWorkflow({ ...definition('Original'), id: 'atomic' });
    await client.exec(`
      ALTER TABLE workflow.embedded_workflows
      ADD CONSTRAINT reject_failed_update CHECK (name <> 'Rejected update');
    `);

    await expect(
      service.updateWorkflow(created.id, definition('Rejected update'))
    ).rejects.toThrow();
    expect((await service.getWorkflow(created.id)).name).toBe('Original');
    expect(
      (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow.workflow_revisions WHERE workflow_id = $1',
          [created.id]
        )
      ).rows[0]?.count
    ).toBe(0);

    const updated = await service.updateWorkflow(created.id, definition('Valid after rollback'));
    expect(updated.name).toBe('Valid after rollback');
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

  test('creates, schedules, revises, restores, and removes a Smithers workflow with retained receipts', async () => {
    const { service, tasks, client } = await harness();
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

    await expect(service.deleteWorkflow('review')).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.getWorkflow('review')).toEqual(restored);
    const mutationId = randomUUID();
    const authorize = (workflow: WorkflowDefinitionResponse) => {
      expect(workflow.id).toBe('review');
    };
    const receipt = await service.changeLifecycle(
      'review',
      mutationId,
      restored.versionId,
      'remove',
      'fixture-owner',
      authorize
    );
    expect(receipt.operation).toBe('remove');
    expect((await service.listWorkflows()).data).toHaveLength(1);
    expect((await service.getWorkflow('review')).active).toBe(false);
    expect((await service.getWorkflow('review')).metadata?.elizaPhoneRemovedAt).toBeString();
    expect(tasks).toHaveLength(0);
    expect((await service.listWorkflowRevisions('review')).data[0].operation).toBe('delete');
    expect(
      await service.changeLifecycle(
        'review',
        mutationId,
        restored.versionId,
        'remove',
        'fixture-owner',
        authorize
      )
    ).toEqual(receipt);
    await expect(service.deleteWorkflow('review')).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.lifecycleReceipt('review', mutationId, 'fixture-owner')).toEqual(receipt);
    expect(
      (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow.lifecycle_mutations WHERE workflow_id=$1',
          ['review']
        )
      ).rows[0]?.count
    ).toBe(1);
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

    await expect(service.deleteWorkflow(created.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(tasks).toHaveLength(1);
    const current = await service.getWorkflow(created.id);
    await service.changeLifecycle(
      created.id,
      randomUUID(),
      current.versionId,
      'remove',
      'fixture-owner',
      (workflow) => {
        expect(workflow.id).toBe(created.id);
      }
    );
    expect(tasks).toHaveLength(0);
    expect((await service.getWorkflow(created.id)).metadata?.elizaPhoneRemovedAt).toBeString();
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
    const { service, client, runtime, emittedEvents } = await harness();
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
      triggerChainDepth: 3,
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
    expect(emittedEvents.at(-1)).toMatchObject({
      type: 'workflow_run_event',
      payload: { triggerChainDepth: 3 },
    });
  }, 15_000);
});

describe('durable cancellation of native Smithers waits', () => {
  test.each(['approval', 'signal'] as const)(
    'cancels parked %s without generation or stale resume',
    async (kind) => {
      const context = await harness();
      let service = context.service;
      const { runtime } = context;
      let calls = 0;
      runtime.useModel = (async () => {
        calls++;
        return '{"message":"must not run"}';
      }) as IAgentRuntime['useModel'];
      const workflow = await service.createWorkflow({
        name: `Cancel parked ${kind}`,
        active: false,
        language: 'tsx',
        source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { approvalDecisionSchema } from "smthrs";
import { z } from "zod";
const { Workflow, Sequence, Approval, Signal, Task, smithers, outputs } = createSmithers({decision:approvalDecisionSchema, signal:z.object({message:z.string()}), output:z.object({message:z.string()})}, {dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(() => <Workflow name="cancel-wait">${kind === 'approval' ? '<Sequence><Approval id="gate" output={outputs.decision} request={{title:"Do not approve"}} /><Task id="work" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>Must not run</Task></Sequence>' : '<Signal id="gate" schema={outputs.signal}>{data => <Task id="work" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>{data.message}</Task>}</Signal>'}</Workflow>);`,
        steps: [],
        widgets: [],
      });
      const dir = resolveSmithersWorkflowDir(runtime.agentId, workflow.id);
      try {
        const parked = await service.executeWorkflow(workflow.id, { mode: 'manual' });
        expect(parked.status).toBe(kind === 'approval' ? 'waiting-approval' : 'waiting-event');
        expect(calls).toBe(0);
        if (kind === 'approval') {
          const previousEvents = structuredClone(parked.events ?? []);
          const previousApprovals = structuredClone(parked.approvals);
          await service.stop();
          service = await EmbeddedWorkflowService.start(runtime);
          let resumed = await service.getExecution(parked.id);
          for (
            let attempt = 0;
            attempt < 500 &&
            (resumed.status !== 'waiting-approval' ||
              (resumed.events?.length ?? 0) <= previousEvents.length);
            attempt++
          ) {
            await Bun.sleep(10);
            resumed = await service.getExecution(parked.id);
          }
          expect(resumed.status).toBe('waiting-approval');
          expect(resumed.events?.slice(0, previousEvents.length)).toEqual(previousEvents);
          expect(resumed.events!.length).toBeGreaterThan(previousEvents.length);
          expect(new Set(resumed.events!.map((event) => event.id)).size).toBe(
            resumed.events!.length
          );
          expect(resumed.approvals).toEqual(previousApprovals);
          expect(calls).toBe(0);
        }
        const cancelled = await service.cancelExecution(parked.id);
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.finished).toBe(true);
        expect(cancelled.stoppedAt).toBeTruthy();
        expect(await service.cancelExecution(parked.id)).toEqual(cancelled);
        const db = new Database(join(dir, 'runs.sqlite'), { readonly: true });
        try {
          expect(
            db.query('SELECT status FROM _smithers_runs WHERE run_id = ?').get(parked.id)
          ).toMatchObject({ status: 'cancelled' });
        } finally {
          db.close();
        }
        await expect(service.decideApproval(parked.id, 'gate', 0, true)).rejects.toMatchObject({
          statusCode: 409,
        });
        await expect(
          service.signalExecution(parked.id, 'gate', { message: 'late' })
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await service.getExecution(parked.id)).status).toBe('cancelled');
        // An in-flight control/event may still hold a pre-cancellation snapshot.
        const internals = service as unknown as {
          saveExecution(run: WorkflowExecution): Promise<void>;
        };
        await internals.saveExecution(parked);
        expect((await service.getExecution(parked.id)).status).toBe('cancelled');
        const read = service.getExecution.bind(service);
        let reads = 0;
        service.getExecution = async (id) => (reads++ === 0 ? parked : read(id));
        try {
          if (kind === 'approval') {
            await expect(service.decideApproval(parked.id, 'gate', 0, true)).rejects.toBeDefined();
          } else {
            expect(
              (await service.signalExecution(parked.id, 'gate', { message: 'stale in-flight' }))
                .status
            ).toBe('cancelled');
          }
        } finally {
          service.getExecution = read;
        }
        expect((await service.getExecution(parked.id)).status).toBe('cancelled');
        expect(calls).toBe(0);
      } finally {
        await service.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000
  );
});

test('cancellation still aborts an active native worker and durably fences its run', async () => {
  const { service, runtime } = await harness();
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  runtime.useModel = (async (_type: unknown, options: { signal?: AbortSignal }) => {
    calls++;
    started();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('Synthetic generation cancelled'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }) as IAgentRuntime['useModel'];
  const workflow = await service.createWorkflow({
    name: 'Cancel active worker',
    active: false,
    language: 'tsx',
    steps: [],
    widgets: [],
    source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({message:z.string()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="active"><Task id="work" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>Controlled local test</Task></Workflow>);`,
  });
  const dir = resolveSmithersWorkflowDir(runtime.agentId, workflow.id);
  try {
    const queued = await service.startWorkflow(workflow.id);
    await admitted;
    const cancelled = await service.cancelExecution(queued.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', finished: true });
    expect(calls).toBe(1);
    const db = new Database(join(dir, 'runs.sqlite'), { readonly: true });
    try {
      expect(
        db.query('SELECT status FROM _smithers_runs WHERE run_id = ?').get(queued.id)
      ).toMatchObject({ status: 'cancelled' });
    } finally {
      db.close();
    }
    expect(await service.cancelExecution(queued.id)).toEqual(cancelled);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test('fails closed when native completion won but its terminal payload was not received', async () => {
  const { service, runtime, client } = await harness();
  let calls = 0;
  runtime.useModel = (async () => {
    calls++;
    return '{"message":"Durably finished"}';
  }) as IAgentRuntime['useModel'];
  const workflow = await service.createWorkflow({
    name: 'Finish wins',
    active: false,
    language: 'tsx',
    steps: [],
    widgets: [],
    source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({message:z.string()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="finished"><Task id="work" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>Controlled local test</Task></Workflow>);`,
  });
  const dir = resolveSmithersWorkflowDir(runtime.agentId, workflow.id);
  try {
    const finished = await service.executeWorkflow(workflow.id);
    expect(finished.status).toBe('finished');
    expect(await service.cancelExecution(finished.id)).toEqual(finished);
    // Model a delayed host projection after Smithers committed the finish winner.
    await client.query(
      `UPDATE workflow.embedded_executions SET status='cancelled', finished=true,
      execution=(execution - 'output' - 'error' - 'nextRunId') || '{"status":"cancelled","finished":true}'::jsonb WHERE id=$1`,
      [finished.id]
    );
    await expect(service.cancelExecution(finished.id)).rejects.toMatchObject({
      statusCode: 409,
      response: { code: 'WORKFLOW_TERMINAL_RESULT_UNAVAILABLE', nativeStatus: 'finished' },
    });
    const reconciled = await service.getExecution(finished.id);
    expect(reconciled).toMatchObject({ status: 'failed', finished: true });
    expect(reconciled.output).toBeUndefined();
    expect(reconciled.error?.message).toContain('terminal result was not captured');
    expect(calls).toBe(1);
    const db = new Database(join(dir, 'runs.sqlite'), { readonly: true });
    try {
      expect(
        db.query('SELECT status FROM _smithers_runs WHERE run_id = ?').get(finished.id)
      ).toMatchObject({ status: 'finished' });
    } finally {
      db.close();
    }
    expect(await service.cancelExecution(finished.id)).toEqual(reconciled);
    await expect(service.decideApproval(finished.id, 'gate', 0, true)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.signalExecution(finished.id, 'gate', {})).rejects.toMatchObject({
      statusCode: 409,
    });
    await service.stop();
    const restarted = await EmbeddedWorkflowService.start(runtime);
    try {
      expect((await restarted.getExecution(finished.id)).status).toBe('failed');
      expect(calls).toBe(1);
    } finally {
      await restarted.stop();
    }
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test('immediate cancellation before a native run row exists stays idempotent', async () => {
  const { service, runtime } = await harness();
  let calls = 0;
  runtime.useModel = (async () => {
    calls++;
    throw new Error('Early cancelled workflow must not generate');
  }) as IAgentRuntime['useModel'];
  const workflow = await service.createWorkflow({
    name: 'Cancel before worker admission',
    active: false,
    language: 'tsx',
    steps: [],
    widgets: [],
    source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({message:z.string()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="immediate"><Task id="work" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>Must not generate</Task></Workflow>);`,
  });
  const dir = resolveSmithersWorkflowDir(runtime.agentId, workflow.id);
  try {
    const queued = await service.startWorkflow(workflow.id);
    const cancelled = await service.cancelExecution(queued.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', finished: true });
    const db = new Database(join(dir, 'runs.sqlite'), { readonly: true });
    try {
      expect(
        db.query('SELECT status FROM _smithers_runs WHERE run_id = ?').get(queued.id)
      ).toBeNull();
    } finally {
      db.close();
    }
    expect(await service.cancelExecution(queued.id)).toEqual(cancelled);
    expect(calls).toBe(0);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
