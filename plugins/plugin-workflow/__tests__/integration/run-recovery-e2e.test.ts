import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { HOSTED_SPEC } from '../../src/services/hosted-digest';
import { createWorkflowDispatchService } from '../../src/services/workflow-dispatch';
import type { WorkflowExecution, WorkflowRunEvent } from '../../src/types/index';

const SCHEMA = `
CREATE SCHEMA workflow;
CREATE TABLE workflow.embedded_workflows (agent_id text NOT NULL, id text NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT false, workflow jsonb NOT NULL, created_at text NOT NULL, updated_at text NOT NULL, version_id text NOT NULL, PRIMARY KEY (agent_id, id));
CREATE TABLE workflow.workflow_revisions (agent_id text NOT NULL, id text NOT NULL, workflow_id text NOT NULL, version_id text NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT false, workflow jsonb NOT NULL, created_at text NOT NULL, updated_at text NOT NULL, captured_at text NOT NULL, operation text NOT NULL, PRIMARY KEY (agent_id, id), UNIQUE (agent_id, workflow_id, version_id));
CREATE TABLE workflow.embedded_executions (agent_id text NOT NULL, id text NOT NULL, workflow_id text NOT NULL, status text NOT NULL, mode text NOT NULL, finished boolean NOT NULL DEFAULT false, started_at text NOT NULL, stopped_at text, execution jsonb NOT NULL, idempotency_key text, PRIMARY KEY (agent_id, id));
CREATE TABLE workflow.embedded_tags (agent_id text NOT NULL, id text NOT NULL, name text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL, PRIMARY KEY (agent_id, id), UNIQUE (agent_id, name));
CREATE TABLE workflow.lifecycle_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,operation text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
CREATE TABLE workflow.metadata_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,name text NOT NULL,description text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`;

const SOURCE = `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';const {Workflow,Task,smithers,outputs}=createSmithers({answer:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});export default smithers(()=><Workflow name="recovery"><Task id="answer" output={outputs.answer}>{{value:1}}</Task></Workflow>);`;

const AGENT = '00000000-0000-4000-8000-000000000003';

type Internals = {
  recordEvent(execution: WorkflowExecution, event: WorkflowRunEvent): Promise<void>;
  saveExecution(execution: WorkflowExecution): Promise<void>;
};

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-run-recovery-'));
  const db = new PGlite(directory);
  await db.exec(SCHEMA);
  const tasks = new Map<string, any>();
  const reported: string[] = [];
  let embedded: EmbeddedWorkflowService | undefined;
  const runtime: any = {
    agentId: AGENT,
    db: drizzle(db, { schema }),
    getSetting: () => undefined,
    getTasks: async () => [...tasks.values()],
    deleteTask: async (id: string) => void tasks.delete(id),
    createTask: async (task: any) => {
      const id = randomUUID();
      tasks.set(id, { ...task, id });
      return id;
    },
    emitEvent: async () => {},
    reportError: (scope: string) => void reported.push(scope),
    getService: (name: string) => (name === 'embedded_workflow_service' ? embedded : null),
  };
  return {
    runtime,
    reported,
    start: async () => {
      embedded = await EmbeddedWorkflowService.start(runtime);
      return embedded;
    },
    cleanup: async () => {
      await embedded?.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function unfinished(workflowId: string, versionId: string): WorkflowExecution {
  return {
    id: randomUUID(),
    workflowId,
    workflowVersionId: versionId,
    workflowName: 'Recovery',
    mode: 'manual',
    status: 'queued',
    finished: false,
    startedAt: new Date().toISOString(),
    input: {},
    events: [],
    approvals: [],
  };
}

async function insertExecution(runtime: any, execution: WorkflowExecution) {
  await runtime.db.insert(schema.embeddedExecutions).values({
    agentId: AGENT,
    id: execution.id,
    workflowId: execution.workflowId,
    status: execution.status,
    mode: execution.mode,
    finished: execution.finished,
    startedAt: execution.startedAt,
    execution,
    idempotencyKey: execution.idempotencyKey ?? null,
  });
}

test('an unreadable reviewed schedule does not stop the service or the resume of other runs', async () => {
  const state = await harness();
  try {
    let service = await state.start();
    const workflow = await service.createWorkflow({
      name: 'Recovery',
      language: 'tsx',
      source: SOURCE,
    } as any);
    const queued = unfinished(workflow.id, workflow.versionId);
    await insertExecution(state.runtime, queued);
    // A digest row whose reviewed specification cannot be parsed.
    const now = new Date().toISOString();
    await state.runtime.db.insert(schema.embeddedWorkflows).values({
      agentId: AGENT,
      id: 'broken-digest',
      name: 'Broken digest',
      active: true,
      workflow: {
        id: 'broken-digest',
        name: 'Broken digest',
        language: 'tsx',
        source: SOURCE,
        active: true,
        metadata: { [HOSTED_SPEC]: '{not json' },
        schedule: { cron: '0 7 * * *', timezone: 'UTC', enabled: true },
      },
      createdAt: now,
      updatedAt: now,
      versionId: randomUUID(),
    });
    await service.stop();
    service = await state.start();
    expect(state.reported).toContain('EmbeddedWorkflowService.recoverHostedSchedules');
    let resumed = await service.getExecution(queued.id);
    for (let tries = 0; !resumed.finished && tries < 600; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      resumed = await service.getExecution(queued.id);
    }
    expect(resumed).toMatchObject({ status: 'finished', finished: true });
  } finally {
    await state.cleanup();
  }
}, 120_000);

test('a replayed fire finds a run admitted under its occurrence key', async () => {
  const state = await harness();
  try {
    const service = await state.start();
    const workflow = await service.createWorkflow({
      name: 'Recovery',
      language: 'tsx',
      source: SOURCE,
    } as any);
    const fired = {
      ...unfinished(workflow.id, workflow.versionId),
      status: 'finished' as const,
      finished: true,
      idempotencyKey: `typed-time:${workflow.id}:${workflow.versionId}:1`,
      dispatchIdempotencyKey: `${workflow.id}:29600000`,
    };
    await insertExecution(state.runtime, fired);
    expect(
      (await service.findExecutionByIdempotencyKey(workflow.id, `${workflow.id}:29600000`))?.id
    ).toBe(fired.id);
    const dispatch = createWorkflowDispatchService(state.runtime);
    expect(
      await dispatch.execute(workflow.id, {}, { idempotencyKey: `${workflow.id}:29600000` })
    ).toEqual({ ok: true, executionId: fired.id, dedup: true });
    expect(await state.runtime.db.select().from(schema.embeddedExecutions)).toHaveLength(1);
  } finally {
    await state.cleanup();
  }
}, 120_000);

test('long progress history stays saveable and keeps timer and approval events', async () => {
  const state = await harness();
  try {
    const service = await state.start();
    const internals = service as unknown as Internals;
    const workflow = await service.createWorkflow({
      name: 'Recovery',
      language: 'tsx',
      source: SOURCE,
    } as any);
    const execution = {
      ...unfinished(workflow.id, workflow.versionId),
      status: 'running' as const,
    };
    await insertExecution(state.runtime, execution);
    const event = (sequence: number, type: string, payload: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      sequence,
      runId: execution.id,
      workflowId: workflow.id,
      timestamp: new Date().toISOString(),
      type,
      payload,
    });
    await internals.recordEvent(
      execution,
      event(1, 'TimerCreated', { timerId: 't', firesAtMs: 1 })
    );
    // 12 KB per event: 200 of them exceed the stored-run ceiling, so the save
    // also has to fall back to its shorter history.
    for (let sequence = 2; sequence <= 1000; sequence += 1)
      await internals.recordEvent(
        execution,
        event(sequence, 'NodeOutput', { text: 'x'.repeat(12_000) })
      );
    const stored = await service.getExecution(execution.id);
    const events = stored.events ?? [];
    expect(events[0]).toMatchObject({ sequence: 1, type: 'TimerCreated' });
    expect(events.at(-1)?.sequence).toBe(1000);
    expect(events.length).toBeLessThanOrEqual(201);
    expect((stored.eventsDropped ?? 0) + events.length).toBe(1000);
  } finally {
    await state.cleanup();
  }
}, 300_000);

test('a stored decision survives a later save of the worker copy', async () => {
  const state = await harness();
  try {
    const service = await state.start();
    const internals = service as unknown as Internals;
    const workflow = await service.createWorkflow({
      name: 'Recovery',
      language: 'tsx',
      source: SOURCE,
    } as any);
    const requestedAt = new Date().toISOString();
    const pending = {
      runId: '',
      workflowId: workflow.id,
      nodeId: 'review',
      iteration: 0,
      status: 'pending' as const,
      requestedAt,
    };
    const worker: WorkflowExecution = {
      ...unfinished(workflow.id, workflow.versionId),
      status: 'waiting-approval',
    };
    worker.approvals = [{ ...pending, runId: worker.id }];
    await insertExecution(state.runtime, worker);
    // The owner's decision is saved while the worker still holds its pending copy.
    await internals.saveExecution({
      ...structuredClone(worker),
      approvals: [
        {
          ...pending,
          runId: worker.id,
          status: 'approved',
          decidedAt: requestedAt,
          decidedBy: 'owner',
        },
      ],
    });
    await internals.saveExecution({ ...worker, status: 'running' });
    const stored = await service.getExecution(worker.id);
    expect(stored.status).toBe('running');
    expect(stored.approvals).toEqual([
      expect.objectContaining({ nodeId: 'review', status: 'approved', decidedBy: 'owner' }),
    ]);
  } finally {
    await state.cleanup();
  }
}, 120_000);
