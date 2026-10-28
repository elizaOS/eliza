import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  MISSED_SCHEDULED_OCCURRENCES_SETTING as MISSED_OCCURRENCES_SETTING,
  SCHEDULED_OCCURRENCE_WINDOW_MS,
} from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import {
  EmbeddedWorkflowService,
  isMissedOccurrenceExecution,
  missedOccurrence,
  recordsMissedOccurrences,
} from '../../src/services/embedded-workflow-service';
import { createWorkflowDispatchService } from '../../src/services/workflow-dispatch';

test('only the engine-recorded missed occurrence reads as missed', () => {
  expect(
    isMissedOccurrenceExecution({ finished: true, missedOccurrenceAt: '2026-10-27T09:00:00.000Z' })
  ).toBe(true);
  // Unfinished, or an unparseable instant, is not a recorded missed occurrence.
  expect(
    isMissedOccurrenceExecution({ finished: false, missedOccurrenceAt: '2026-10-27T09:00:00.000Z' })
  ).toBe(false);
  expect(isMissedOccurrenceExecution({ finished: true, missedOccurrenceAt: 'soon' })).toBe(false);
  // A workflow's own output, even one shaped exactly like the recorded
  // occurrence, ran: only the engine-written execution field marks it missed.
  const now = Date.parse('2026-10-27T09:10:00.000Z');
  const forged = { finished: true, output: missedOccurrence(now - 10 * 60_000, now, now - 60_000) };
  expect(isMissedOccurrenceExecution(forged)).toBe(false);
});

test('missed occurrence policy is explicit and bounded by the scheduled window', () => {
  const now = Date.parse('2026-10-27T09:10:00.000Z');
  // The agent process started a minute ago, after the phone was powered on.
  const bootedAt = now - 60_000;
  expect(missedOccurrence(undefined, now, bootedAt)).toBeUndefined();
  expect(missedOccurrence(now - SCHEDULED_OCCURRENCE_WINDOW_MS, now, bootedAt)).toBeUndefined();
  expect(missedOccurrence(now - SCHEDULED_OCCURRENCE_WINDOW_MS - 1, now, bootedAt)).toMatchObject({
    status: 'missed',
    scheduledAt: new Date(now - SCHEDULED_OCCURRENCE_WINDOW_MS - 1).toISOString(),
  });
  // A delay while the agent was already running (device doze, a busy
  // scheduler) is not a missed occurrence: it still runs.
  expect(missedOccurrence(now - 30 * 60_000, now, now - 60 * 60_000)).toBeUndefined();
  for (const invalid of [now + 5_000, 1.5, Number.NaN])
    expect(() => missedOccurrence(invalid, now, bootedAt)).toThrow('exact scheduled occurrence');
  const previous = process.env[MISSED_OCCURRENCES_SETTING];
  try {
    delete process.env[MISSED_OCCURRENCES_SETTING];
    expect(recordsMissedOccurrences({ getSetting: () => undefined } as never)).toBe(false);
    expect(recordsMissedOccurrences({ getSetting: () => 'record' } as never)).toBe(true);
    expect(recordsMissedOccurrences({ getSetting: () => 'run' } as never)).toBe(false);
    process.env[MISSED_OCCURRENCES_SETTING] = 'record';
    expect(recordsMissedOccurrences({ getSetting: () => undefined } as never)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env[MISSED_OCCURRENCES_SETTING];
    else process.env[MISSED_OCCURRENCES_SETTING] = previous;
  }
});

test('a powered-on resident records a late scheduled occurrence once and runs nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-missed-occurrence-'));
  const db = new PGlite(directory);
  let embedded: EmbeddedWorkflowService | undefined;
  try {
    await db.exec(`
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
    CREATE TABLE workflow.embedded_tags (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, name)
    );

 CREATE TABLE workflow.lifecycle_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,operation text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.metadata_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,name text NOT NULL,description text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
    const tasks = new Map<string, any>();
    const runtime: any = {
      agentId: '00000000-0000-4000-8000-000000000002',
      db: drizzle(db, { schema }),
      getSetting: (key: string) => (key === MISSED_OCCURRENCES_SETTING ? 'record' : undefined),
      getTasks: async () => [...tasks.values()],
      deleteTask: async (id: string) => void tasks.delete(id),
      createTask: async (task: any) => {
        const id = randomUUID();
        tasks.set(id, { ...task, id });
        return id;
      },
      emitEvent: async () => {},
      getService: (name: string) => (name === 'embedded_workflow_service' ? embedded : null),
    };
    embedded = await EmbeddedWorkflowService.start(runtime);
    const workflow = await embedded.createWorkflow({
      name: 'Morning summary',
      description: 'Scheduled fixture',
      language: 'tsx',
      active: true,
      metadata: { elizaOwnerEntityId: 'owner' },
      schedule: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';const {Workflow,Task,smithers,outputs}=createSmithers({answer:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});export default smithers(()=><Workflow name="missed"><Task id="answer" output={outputs.answer}>{{value:1}}</Task></Workflow>);`,
    } as any);
    expect(tasks.size).toBe(1);
    const scheduledAtMs = Date.now() - 4 * 60 * 60 * 1000;
    const first = await embedded.executeWorkflow(workflow.id, {
      mode: 'trigger',
      triggerData: {},
      idempotencyKey: `${workflow.id}:${Math.floor(scheduledAtMs / 60000)}`,
      scheduledAtMs,
    });
    expect(first).toMatchObject({
      status: 'finished',
      finished: true,
      mode: 'trigger',
      output: { status: 'missed', scheduledAt: new Date(scheduledAtMs).toISOString() },
      missedOccurrenceAt: new Date(scheduledAtMs).toISOString(),
    });
    expect(first.events).toEqual([]);
    // A repeated fire of the same occurrence (restart, duplicate scheduler tick)
    // returns the same record; no second record and no execution.
    const repeated = await embedded.executeWorkflow(workflow.id, {
      mode: 'trigger',
      triggerData: {},
      idempotencyKey: `${workflow.id}:${Math.floor(scheduledAtMs / 60000)}`,
      scheduledAtMs,
    });
    expect(repeated.id).toBe(first.id);
    const rows = await runtime.db.select().from(schema.embeddedExecutions);
    expect(rows).toHaveLength(1);
    expect(rows[0].finished).toBe(true);
    // The schedule stays armed for the next occurrence.
    expect(tasks.size).toBe(1);
    // An occurrence claimed for the future is refused before anything is written.
    await expect(
      embedded.executeWorkflow(workflow.id, {
        mode: 'trigger',
        triggerData: {},
        idempotencyKey: 'future',
        scheduledAtMs: Date.now() + 60_000,
      })
    ).rejects.toThrow('exact scheduled occurrence');
    expect(await runtime.db.select().from(schema.embeddedExecutions)).toHaveLength(1);
    // The trigger dispatcher learns that the occurrence was missed, so its run
    // is not reported as completed; a repeated fire stays a deduplicated one.
    const dispatch = createWorkflowDispatchService(runtime);
    const nextMissed = scheduledAtMs + 60 * 60 * 1000;
    const key = `${workflow.id}:${Math.floor(nextMissed / 60000)}`;
    const dispatched = await dispatch.execute(
      workflow.id,
      {},
      { idempotencyKey: key, scheduledAtMs: nextMissed }
    );
    expect(dispatched).toMatchObject({ ok: true, missed: true });
    expect(dispatched.executionId).toBeString();
    expect(
      await dispatch.execute(workflow.id, {}, { idempotencyKey: key, scheduledAtMs: nextMissed })
    ).toEqual({ ok: true, executionId: dispatched.executionId, dedup: true });
    expect(await runtime.db.select().from(schema.embeddedExecutions)).toHaveLength(2);
  } finally {
    await embedded?.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);
