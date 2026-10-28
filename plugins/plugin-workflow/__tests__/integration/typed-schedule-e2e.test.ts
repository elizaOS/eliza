import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Task } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { executeTriggerTask } from '../../../../packages/agent/src/triggers/runtime.ts';
import * as schema from '../../src/db/schema';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';
import { createWorkflowDispatchService } from '../../src/services/workflow-dispatch';
import { WorkflowService } from '../../src/services/workflow-service';

const AGENT = '00000000-0000-4000-8000-000000000002';

/**
 * Typed phone workflows with a reviewed local-time trigger, on real SQL, the real
 * trigger runtime dispatch and the real Smithers worker: saved paused, armed only
 * for the exact reviewed version, admitted at exact occurrences, never backfilled,
 * never stacked, disarmed by edits and pauses, and re-armed after a restart.
 */
test('typed local-time schedules: reviewed arming, exact occurrences, missed, overlap and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-typed-schedule-'));
  let db = new PGlite(directory);
  let server: http.Server | undefined;
  let embedded: EmbeddedWorkflowService | undefined;
  const owned: string[] = [];
  const tasks = new Map<string, Task>();
  try {
    await db.exec(`
    CREATE SCHEMA workflow;
    CREATE TABLE workflow.typed_mutations(agent_id text NOT NULL,owner_id text NOT NULL,mutation_id text NOT NULL,request_digest text NOT NULL,workflow_id text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,owner_id,mutation_id));
    CREATE TABLE workflow.embedded_workflows (agent_id text NOT NULL,id text NOT NULL,name text NOT NULL,active boolean NOT NULL DEFAULT false,workflow jsonb NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,version_id text NOT NULL,PRIMARY KEY (agent_id, id));
    CREATE TABLE workflow.workflow_revisions (agent_id text NOT NULL,id text NOT NULL,workflow_id text NOT NULL,version_id text NOT NULL,name text NOT NULL,active boolean NOT NULL DEFAULT false,workflow jsonb NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,captured_at text NOT NULL,operation text NOT NULL,PRIMARY KEY (agent_id, id),UNIQUE (agent_id, workflow_id, version_id));
    CREATE TABLE workflow.embedded_executions (agent_id text NOT NULL,id text NOT NULL,workflow_id text NOT NULL,status text NOT NULL,mode text NOT NULL,finished boolean NOT NULL DEFAULT false,started_at text NOT NULL,stopped_at text,execution jsonb NOT NULL,idempotency_key text,PRIMARY KEY (agent_id, id));
    CREATE TABLE workflow.embedded_tags (agent_id text NOT NULL,id text NOT NULL,name text NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,PRIMARY KEY (agent_id, id),UNIQUE (agent_id, name));
    CREATE TABLE workflow.metadata_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,name text NOT NULL,description text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
    CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
    let runtime: any;
    const noop = () => undefined;
    const boot = async () => {
      let dispatch: ReturnType<typeof createWorkflowDispatchService> | undefined;
      runtime = {
        agentId: AGENT,
        db: drizzle(db, { schema }),
        logger: { info: noop, warn: noop, error: noop, debug: noop },
        reportError: noop,
        getSetting: () => undefined,
        getModel: () => undefined,
        emitEvent: async () => {},
        // The durable task store the TaskService schedules from, kept across restarts.
        createTask: async (task: Task) => {
          const id = randomUUID();
          tasks.set(id, structuredClone({ ...task, id }) as Task);
          return id;
        },
        getTasks: async ({ tags }: { tags?: string[] }) =>
          [...tasks.values()]
            .filter((task) => (tags ?? []).every((tag) => task.tags?.includes(tag)))
            .map((task) => structuredClone(task)),
        getTask: async (id: string) => structuredClone(tasks.get(id) ?? null),
        updateTask: async (id: string, patch: Partial<Task>) => {
          const current = tasks.get(id);
          if (current) tasks.set(id, structuredClone({ ...current, ...patch }) as Task);
        },
        deleteTask: async (id: string) => void tasks.delete(id),
        getService: (name: string) =>
          name === 'embedded_workflow_service'
            ? embedded
            : name === 'workflow'
              ? facade
              : name === 'WORKFLOW_DISPATCH'
                ? dispatch
                : undefined,
      };
      embedded = await EmbeddedWorkflowService.start(runtime);
      const facade = new WorkflowService(runtime);
      dispatch = createWorkflowDispatchService(runtime);
      server = http.createServer((req, res) => {
        void handleWorkflowRoutes({
          req,
          res,
          method: req.method!,
          pathname: new URL(req.url!, 'http://localhost').pathname,
          runtime,
          principalId: req.headers['x-fixture-owner'] === 'other' ? 'other' : 'owner',
          json: (response, body, status = 200) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
          },
        });
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server!.address() as any).port}/api/workflow`;
    };
    let origin = await boot();
    const call = async (path: string, body?: unknown, owner = 'owner') => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-owner': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const armed = (workflowId: string) =>
      [...tasks.values()].filter(
        (task) =>
          (task.metadata?.trigger as { workflowId?: string } | undefined)?.workflowId === workflowId
      );
    const settle = async (runId: string) => {
      let execution: any;
      for (let i = 0; i < 480; i++) {
        execution = (await call(`/executions/${runId}`)).body.execution;
        if (execution.finished) return execution;
        await Bun.sleep(250);
      }
      return execution;
    };

    expect((await call('/status')).body.typedScheduleProtocol).toBe(1);
    const catalog = (await call('/phone/catalog')).body;
    expect(catalog.triggers.find((t: any) => t.kind === 'time').available).toBe(true);
    // The current UTC minute is an exact occurrence of an every-day 'HH:MM' UTC trigger.
    const occurrence = Math.floor(Date.now() / 60000) * 60000;
    const trigger = {
      kind: 'time',
      localTime: new Date(occurrence).toISOString().slice(11, 16),
      timeZone: 'UTC',
      days: [0, 1, 2, 3, 4, 5, 6],
    };
    const spec = {
      version: 1,
      name: 'Daily reviewed draft',
      description: 'Scheduled supplied text',
      trigger,
      steps: [
        { id: 'read', kind: 'Read', operation: 'supplied_text', text: 'scheduled agenda' },
        {
          id: 'write',
          kind: 'Write',
          operation: 'compose_draft',
          source: 'read',
          prefix: 'Today: ',
          suffix: '.',
        },
      ],
    };
    const review = {
      spec,
      catalogRevision: catalog.catalogRevision,
      compilerRevision: catalog.compilerRevision,
    };
    expect((await call('/phone/validate', review)).status).toBe(200);
    expect(
      (
        await call('/phone/validate', {
          ...review,
          spec: { ...spec, trigger: { ...trigger, days: [3, 1] } },
        })
      ).status
    ).toBe(400);
    const saved = (await call('/phone/workflows', { ...review, mutationId: randomUUID() })).body
      .receipt;
    const id = saved.workflowId;
    owned.push(id);
    let stored = await embedded!.getWorkflow(id);
    expect(stored.active).toBe(false);
    expect(stored.schedule).toEqual({
      cron: `${Number(trigger.localTime.slice(3))} ${Number(trigger.localTime.slice(0, 2))} * * *`,
      timezone: 'UTC',
      enabled: true,
    });
    expect(armed(id)).toHaveLength(0);

    // Arming needs the exact reviewed version; a version-free activation is refused.
    expect((await call(`/workflows/${id}/activate`, {})).status).toBe(409);
    const stale = await call(`/workflows/${id}/activate`, { expectedVersionId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('WORKFLOW_ACTIVATION_NOT_APPLIED');
    expect(
      (await call(`/workflows/${id}/activate`, { expectedVersionId: saved.versionId }, 'other'))
        .status
    ).toBe(404);
    expect(armed(id)).toHaveLength(0);
    const activated = await call(`/workflows/${id}/activate`, {
      expectedVersionId: saved.versionId,
    });
    expect(activated.status).toBe(200);
    expect(activated.body.active).toBe(true);
    const version = activated.body.versionId;
    expect(version).not.toBe(saved.versionId);
    expect(armed(id)).toHaveLength(1);
    expect(armed(id)[0].metadata?.reviewedVersionId).toBe(version);

    // A manual typed workflow still has nothing to arm.
    const manual = (
      await call('/phone/workflows', {
        ...review,
        spec: { ...spec, name: 'Manual draft', trigger: { kind: 'manual' } },
        mutationId: randomUUID(),
      })
    ).body.receipt;
    owned.push(manual.workflowId);
    expect(
      (
        await call(`/workflows/${manual.workflowId}/activate`, {
          expectedVersionId: manual.versionId,
        })
      ).status
    ).toBe(409);
    await expect(
      embedded!.startWorkflow(manual.workflowId, {
        mode: 'trigger',
        triggerData: { scheduledAtMs: occurrence, workflowVersionId: manual.versionId },
      })
    ).rejects.toThrow('only when the owner starts them');

    // The armed task fires through the real trigger runtime for this exact occurrence.
    const task = armed(id)[0];
    tasks.set(task.id!, {
      ...task,
      metadata: {
        ...task.metadata,
        trigger: { ...(task.metadata?.trigger as object), nextRunAtMs: occurrence },
      },
    } as Task);
    const fired = await executeTriggerTask(runtime, tasks.get(task.id!)!, { source: 'scheduler' });
    expect(fired.status).toBe('success');
    expect(fired.executionId).toBeTruthy();
    const run = await settle(fired.executionId!);
    expect(run.status).toBe('finished');
    expect(run.mode).toBe('trigger');
    expect(run.workflowVersionId).toBe(version);
    expect(run.input.typedSchedule).toEqual({
      scheduledAt: new Date(occurrence).toISOString(),
      trigger,
      status: 'ready',
      text: '',
    });
    expect(run.output[0].text).toBe('Today: scheduled agenda.');
    // The trigger advanced to the next day's occurrence.
    expect(
      (armed(id)[0].metadata?.trigger as { nextRunAtMs?: number } | undefined)?.nextRunAtMs
    ).toBe(occurrence + 86_400_000);
    // The same occurrence is admitted once.
    const repeated = await embedded!.startWorkflow(id, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: occurrence, workflowVersionId: version },
    });
    expect(repeated.id).toBe(run.id);

    // An occurrence from yesterday (the phone was off) is recorded once as missed and never run.
    const yesterday = occurrence - 86_400_000;
    const missed = await embedded!.startWorkflow(id, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: yesterday, workflowVersionId: version },
    });
    expect(missed.finished).toBe(true);
    expect(missed.output).toMatchObject({
      status: 'missed',
      scheduledAt: new Date(yesterday).toISOString(),
    });
    expect(
      (
        await embedded!.startWorkflow(id, {
          mode: 'trigger',
          triggerData: { scheduledAtMs: yesterday, workflowVersionId: version },
        })
      ).id
    ).toBe(missed.id);
    // Not an instant of the reviewed schedule, another version, or the future: refused.
    for (const triggerData of [
      { scheduledAtMs: occurrence - 30_000, workflowVersionId: version },
      { scheduledAtMs: occurrence, workflowVersionId: saved.versionId },
      { scheduledAtMs: occurrence + 86_400_000, workflowVersionId: version },
    ])
      await expect(embedded!.startWorkflow(id, { mode: 'trigger', triggerData })).rejects.toThrow();

    // A reviewed local time that a spring-forward transition skipped (02:30 on
    // 2026-03-08 in America/New_York) never fires; the next occurrence records it
    // once as missed, with the skipped local time, and runs nothing for it.
    const dstTrigger = {
      kind: 'time',
      localTime: '02:30',
      timeZone: 'America/New_York',
      days: [0, 1, 2, 3, 4, 5, 6],
    };
    const dstSaved = (
      await call('/phone/workflows', {
        ...review,
        spec: { ...spec, name: 'Night draft', trigger: dstTrigger },
        mutationId: randomUUID(),
      })
    ).body.receipt;
    owned.push(dstSaved.workflowId);
    const dstVersion = (
      await call(`/workflows/${dstSaved.workflowId}/activate`, {
        expectedVersionId: dstSaved.versionId,
      })
    ).body.versionId;
    // Armed before the transition.
    await (runtime.db as any)
      .update(schema.embeddedWorkflows)
      .set({ updatedAt: '2026-03-01T00:00:00.000Z' })
      .where((await import('drizzle-orm')).eq(schema.embeddedWorkflows.id, dstSaved.workflowId));
    const afterGap = Date.parse('2026-03-09T06:30:00Z');
    const dstRun = await embedded!.startWorkflow(dstSaved.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: afterGap, workflowVersionId: dstVersion },
    });
    expect(dstRun.output).toMatchObject({
      status: 'missed',
      scheduledAt: '2026-03-09T06:30:00.000Z',
    });
    const dstRecords = async () =>
      (
        await (runtime.db as any)
          .select()
          .from(schema.embeddedExecutions)
          .where(
            (
              await import('drizzle-orm')
            ).eq(schema.embeddedExecutions.workflowId, dstSaved.workflowId)
          )
      ).map((row: any) => row.execution);
    const skippedRun = (await dstRecords()).find((e: any) => e.id !== dstRun.id);
    expect(skippedRun).toMatchObject({
      status: 'finished',
      finished: true,
      workflowVersionId: dstVersion,
      output: {
        status: 'missed',
        scheduledAt: '2026-03-08T07:30:00.000Z',
        skippedLocalTime: '2026-03-08T02:30',
      },
      input: {
        typedSchedule: {
          scheduledAt: '2026-03-08T07:30:00.000Z',
          trigger: dstTrigger,
          status: 'missed',
        },
      },
    });
    // Re-delivering either occurrence records nothing more.
    await embedded!.startWorkflow(dstSaved.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: afterGap, workflowVersionId: dstVersion },
    });
    await embedded!.startWorkflow(dstSaved.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: afterGap + 86_400_000, workflowVersionId: dstVersion },
    });
    expect(await dstRecords()).toHaveLength(3);
    await call(`/workflows/${dstSaved.workflowId}/deactivate`, { expectedVersionId: dstVersion });

    // An occurrence never stacks behind a run that is still active.
    const heldId = randomUUID();
    const held = {
      id: heldId,
      workflowId: id,
      workflowVersionId: version,
      workflowName: spec.name,
      mode: 'manual',
      status: 'waiting-approval',
      finished: false,
      startedAt: new Date().toISOString(),
      input: {},
      events: [],
      approvals: [],
    };
    await (runtime.db as any).insert(schema.embeddedExecutions).values({
      agentId: AGENT,
      id: heldId,
      workflowId: id,
      status: held.status,
      mode: held.mode,
      finished: false,
      startedAt: held.startedAt,
      execution: held,
    });
    const twoDaysAgo = occurrence - 2 * 86_400_000;
    const overlapRun = await embedded!.startWorkflow(id, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: twoDaysAgo, workflowVersionId: version },
    });
    // A late occurrence is missed first; an on-time one behind an active run is an overlap.
    expect(overlapRun.output).toMatchObject({ status: 'missed' });
    await (runtime.db as any)
      .delete(schema.embeddedExecutions)
      .where((await import('drizzle-orm')).eq(schema.embeddedExecutions.id, run.id));
    const overlap = await embedded!.startWorkflow(id, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: occurrence, workflowVersionId: version },
    });
    expect(overlap.output).toMatchObject({ status: 'overlap' });
    await (runtime.db as any)
      .update(schema.embeddedExecutions)
      .set({
        finished: true,
        status: 'cancelled',
        execution: { ...held, finished: true, status: 'cancelled' },
      })
      .where((await import('drizzle-orm')).eq(schema.embeddedExecutions.id, heldId));

    // A queued scheduled run whose worker never started is recorded as missed after a restart.
    const queuedId = randomUUID();
    const queued = {
      id: queuedId,
      workflowId: id,
      workflowVersionId: version,
      workflowName: spec.name,
      mode: 'trigger',
      status: 'queued',
      finished: false,
      startedAt: new Date(yesterday).toISOString(),
      input: {
        typedSchedule: {
          scheduledAt: new Date(yesterday - 86_400_000).toISOString(),
          trigger,
          status: 'ready',
          text: '',
        },
      },
      events: [],
      approvals: [],
    };
    await (runtime.db as any).insert(schema.embeddedExecutions).values({
      agentId: AGENT,
      id: queuedId,
      workflowId: id,
      status: 'queued',
      mode: 'trigger',
      finished: false,
      startedAt: queued.startedAt,
      execution: queued,
    });
    await embedded!.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await db.close();
    // The armed task survives in the durable store; a lost task is re-armed at startup.
    for (const lost of armed(id)) tasks.delete(lost.id!);
    db = new PGlite(directory);
    origin = await boot();
    expect(armed(id)).toHaveLength(1);
    expect(armed(id)[0].metadata?.reviewedVersionId).toBe(version);
    const recovered = await settle(queuedId);
    expect(recovered.status).toBe('finished');
    expect(recovered.output).toMatchObject({ status: 'missed' });

    // An edit saves a paused version and disarms the schedule; pausing also disarms it.
    stored = await embedded!.getWorkflow(id);
    const edit = await call(`/workflows/${id}/phone-spec`, {
      ...review,
      spec: { ...spec, name: 'Edited scheduled draft' },
      mutationId: randomUUID(),
      expectedVersionId: stored.versionId,
    });
    expect(edit.status).toBe(200);
    expect((await embedded!.getWorkflow(id)).active).toBe(false);
    expect(armed(id)).toHaveLength(0);
    await expect(
      embedded!.startWorkflow(id, {
        mode: 'trigger',
        triggerData: { scheduledAtMs: occurrence, workflowVersionId: edit.body.receipt.versionId },
      })
    ).rejects.toThrow('paused');
    const reArmed = await call(`/workflows/${id}/activate`, {
      expectedVersionId: edit.body.receipt.versionId,
    });
    expect(armed(id)).toHaveLength(1);
    const paused = await call(`/workflows/${id}/deactivate`, {
      expectedVersionId: reArmed.body.versionId,
    });
    expect(paused.body.active).toBe(false);
    expect(armed(id)).toHaveLength(0);
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
    for (const id of owned)
      await rm(resolveSmithersWorkflowDir(AGENT, id), { recursive: true, force: true });
  }
}, 300000);
