/**
 * Restart coverage for the scheduling-owned SQL store.
 *
 * These tests use a real PGlite database behind the runner service and recreate
 * the service between operations, which exercises the boot/re-init path that
 * previously lost in-memory ScheduledTask rows.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchResult } from "../dispatch-types.js";
import {
  migrateSchedulingTables,
  SchedulingMigrationService,
} from "./migration.js";
import type {
  ScheduledTaskDispatcher,
  ScheduledTaskRunnerHandle,
} from "./runner.js";
import {
  getScheduledTaskRunner,
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./runner-service.js";
import type { ScheduledTaskLogStore } from "./state-log.js";
import {
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
  listDueScheduledTaskRefs,
  listRecoverableScheduledTaskRefs,
} from "./store.js";
import type { ScheduledTask } from "./types.js";

type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

function rawQueryText(query: RawSqlQuery): string {
  return String(query.queryChunks.map((chunk) => chunk.value ?? "").join(""));
}

interface RuntimeHarness {
  runtime: IAgentRuntime;
  pg: PGlite;
  setService(service: ScheduledTaskRunnerService | null): void;
  close(): Promise<void>;
}

async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const pg = new PGlite();
  const db = {
    execute: (query: RawSqlQuery) => pg.query(rawQueryText(query)),
  };
  let service: ScheduledTaskRunnerService | null = null;
  const runtime = {
    agentId: "agent-sql-persist",
    adapter: { db },
    getService: (serviceType: string) =>
      serviceType === ScheduledTaskRunnerService.serviceType ? service : null,
    getServiceLoadPromise: async () => service,
    initPromise: Promise.resolve(),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;

  await migrateSchedulingTables(async (sql) => {
    const result = await pg.query<Record<string, unknown>>(sql);
    return result.rows;
  });
  return {
    runtime,
    pg,
    setService(next) {
      service = next;
    },
    async close() {
      await pg.close();
    },
  };
}

async function startService(
  harness: RuntimeHarness,
): Promise<ScheduledTaskRunnerService> {
  const service = await ScheduledTaskRunnerService.start(harness.runtime);
  harness.setService(service);
  return service;
}

async function startSqlRunner(
  harness: RuntimeHarness,
  logStore: ScheduledTaskLogStore = createSchedulingSqlScheduledTaskLogStore({
    runtime: harness.runtime,
    agentId: harness.runtime.agentId,
  }),
): Promise<{
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
}> {
  registerScheduledTaskRunnerDeps(harness.runtime, (runtime, agentId) => ({
    store: createSchedulingSqlScheduledTaskStore({ runtime, agentId }),
    logStore,
    dispatcher: { async dispatch() {} },
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
  }));
  await startService(harness);
  return {
    runner: getScheduledTaskRunner(harness.runtime, {
      agentId: harness.runtime.agentId,
      now: () => new Date("2026-08-16T03:00:00.000Z"),
    }),
    logStore,
  };
}

function receiptReminderInput(idempotencyKey?: string) {
  return {
    kind: "reminder" as const,
    promptInstructions: "Stretch",
    trigger: { kind: "once" as const, atIso: "2026-08-16T03:05:00.000Z" },
    priority: "medium" as const,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    respectsGlobalPause: true,
    source: "user_chat" as const,
    createdBy: "test",
    ownerVisible: true,
  };
}

const SQL_PERSISTENCE_TEST_TIMEOUT_MS = 15_000;

describe("scheduling SQL persistence", () => {
  const harnesses: RuntimeHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it("keeps no-database startup on the in-memory fallback path", async () => {
    const runtime = { agentId: "no-db" } as IAgentRuntime;
    const service = await SchedulingMigrationService.start(runtime);
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it(
    "reconciles a stable creation receipt after the task commit outlives a log failure",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const durableLogStore = createSchedulingSqlScheduledTaskLogStore({
        runtime: harness.runtime,
        agentId: harness.runtime.agentId,
      });
      let failNextAppend = true;
      const flakyLogStore: ScheduledTaskLogStore = {
        ...durableLogStore,
        async append(entry) {
          if (failNextAppend) {
            failNextAppend = false;
            throw new Error("injected log append failure");
          }
          await durableLogStore.append(entry);
        },
      };
      const { runner } = await startSqlRunner(harness, flakyLogStore);
      const input = receiptReminderInput("receipt-after-log-failure");

      await expect(runner.scheduleWithResult(input)).rejects.toThrow(
        "injected log append failure",
      );
      const replay = await runner.scheduleWithResult(input);

      expect(replay.replayed).toBe(true);
      expect(replay.commit.logId).toMatch(/^stl_create_[a-f0-9]{64}$/);
      expect(replay.task.metadata?.schedulingCreationReceipt).toMatchObject({
        logId: replay.commit.logId,
      });
      const counts = await harness.pg.query<{ tasks: number; logs: number }>(`
        SELECT
          (SELECT COUNT(*)::int FROM app_scheduling.life_scheduled_tasks
            WHERE agent_id = 'agent-sql-persist') AS tasks,
          (SELECT COUNT(*)::int FROM app_scheduling.life_scheduled_task_log
            WHERE agent_id = 'agent-sql-persist' AND transition = 'scheduled') AS logs
      `);
      expect(counts.rows[0]).toEqual({ tasks: 1, logs: 1 });
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "converges concurrent same-key creates on one task and one receipt",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const { runner } = await startSqlRunner(harness);
      const input = receiptReminderInput("concurrent-receipt");

      const results = await Promise.all([
        runner.scheduleWithResult(input),
        runner.scheduleWithResult(input),
      ]);

      expect(new Set(results.map((result) => result.task.taskId)).size).toBe(1);
      expect(new Set(results.map((result) => result.commit.logId)).size).toBe(
        1,
      );
      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      const counts = await harness.pg.query<{ tasks: number; logs: number }>(`
        SELECT
          (SELECT COUNT(*)::int FROM app_scheduling.life_scheduled_tasks
            WHERE agent_id = 'agent-sql-persist') AS tasks,
          (SELECT COUNT(*)::int FROM app_scheduling.life_scheduled_task_log
            WHERE agent_id = 'agent-sql-persist' AND transition = 'scheduled') AS logs
      `);
      expect(counts.rows[0]).toEqual({ tasks: 1, logs: 1 });
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "replays one lifecycle receipt after the atomic commit outlives an observation failure",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const durableLogStore = createSchedulingSqlScheduledTaskLogStore({
        runtime: harness.runtime,
        agentId: harness.runtime.agentId,
      });
      let failNextList = false;
      const flakyLogStore: ScheduledTaskLogStore = {
        ...durableLogStore,
        async list(args) {
          if (failNextList) {
            failNextList = false;
            throw new Error("injected lifecycle receipt observation failure");
          }
          return durableLogStore.list(args);
        },
      };
      const { runner } = await startSqlRunner(harness, flakyLogStore);
      const created = await runner.scheduleWithResult(
        receiptReminderInput("lifecycle-log-recovery-task"),
      );
      const request = {
        taskId: created.task.taskId,
        verb: "snooze" as const,
        payload: { minutes: 7 },
        options: { idempotencyKey: "message-1:snooze" },
      };
      failNextList = true;

      await expect(
        runner.applyWithResult(
          request.taskId,
          request.verb,
          request.payload,
          request.options,
        ),
      ).rejects.toThrow("injected lifecycle receipt observation failure");
      const replay = await runner.applyWithResult(
        request.taskId,
        request.verb,
        request.payload,
        request.options,
      );

      expect(replay.replayed).toBe(true);
      expect(replay.commit.logId).toMatch(/^stl_apply_[a-f0-9]{64}$/);
      expect(replay.task.state.firedAt).toBe("2026-08-16T03:07:00.000Z");
      const counts = await harness.pg.query<{
        logs: number;
        metadata_json: string;
      }>(`
        SELECT
          (SELECT COUNT(*)::int
             FROM app_scheduling.life_scheduled_task_log
            WHERE agent_id = 'agent-sql-persist'
              AND transition = 'snoozed') AS logs,
          (SELECT metadata_json
             FROM app_scheduling.life_scheduled_tasks
            WHERE agent_id = 'agent-sql-persist'
              AND id = '${created.task.taskId}') AS metadata_json
      `);
      expect(counts.rows[0]?.logs).toBe(1);
      const metadata = JSON.parse(counts.rows[0]?.metadata_json ?? "{}") as {
        schedulingApplyReceipts?: Record<string, unknown>;
      };
      expect(Object.keys(metadata.schedulingApplyReceipts ?? {})).toHaveLength(
        1,
      );
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "converges concurrent lifecycle retries before settling the terminal pipeline",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const { runner } = await startSqlRunner(harness);
      const child = receiptReminderInput();
      const created = await runner.scheduleWithResult({
        ...receiptReminderInput("lifecycle-complete-task"),
        pipeline: { onComplete: [child as never] },
      });

      const results = await Promise.all([
        runner.applyWithResult(created.task.taskId, "complete", undefined, {
          idempotencyKey: "message-2:complete",
        }),
        runner.applyWithResult(created.task.taskId, "complete", undefined, {
          idempotencyKey: "message-2:complete",
        }),
      ]);

      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(new Set(results.map((result) => result.commit.logId)).size).toBe(
        1,
      );
      const counts = await harness.pg.query<{
        completed_logs: number;
        tasks: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int
             FROM app_scheduling.life_scheduled_task_log
            WHERE agent_id = 'agent-sql-persist'
              AND transition = 'completed') AS completed_logs,
          (SELECT COUNT(*)::int
             FROM app_scheduling.life_scheduled_tasks
            WHERE agent_id = 'agent-sql-persist') AS tasks
      `);
      expect(counts.rows[0]).toEqual({ completed_logs: 1, tasks: 2 });
      const tasks = await runner.list();
      expect(
        tasks.find((task) => task.taskId !== created.task.taskId)?.state
          .pipelineParentId,
      ).toBe(created.task.taskId);
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "retains distinct concurrent lifecycle receipts and settles each terminal pipeline once",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const { runner } = await startSqlRunner(harness);
      const child = receiptReminderInput();
      const created = await runner.scheduleWithResult({
        ...receiptReminderInput("distinct-lifecycle-complete-task"),
        pipeline: { onComplete: [child as never] },
      });
      const requests = [
        { idempotencyKey: "message-distinct-a:complete" },
        { idempotencyKey: "message-distinct-b:complete" },
      ] as const;

      const applied = await Promise.all(
        requests.map((options) =>
          runner.applyWithResult(
            created.task.taskId,
            "complete",
            undefined,
            options,
          ),
        ),
      );

      expect(applied.map((result) => result.replayed)).toEqual([false, false]);
      expect(new Set(applied.map((result) => result.commit.logId)).size).toBe(
        2,
      );

      const persisted = await harness.pg.query<{
        completed_logs: number;
        metadata_json: string;
      }>(`
        SELECT
          (SELECT COUNT(*)::int
             FROM app_scheduling.life_scheduled_task_log
            WHERE agent_id = 'agent-sql-persist'
              AND task_id = '${created.task.taskId}'
              AND transition = 'completed') AS completed_logs,
          (SELECT metadata_json
             FROM app_scheduling.life_scheduled_tasks
            WHERE agent_id = 'agent-sql-persist'
              AND id = '${created.task.taskId}') AS metadata_json
      `);
      const persistedRow = persisted.rows[0];
      if (!persistedRow) throw new Error("expected persisted lifecycle row");
      expect(persistedRow.completed_logs).toBe(2);
      const metadata = JSON.parse(persistedRow.metadata_json) as {
        schedulingApplyReceipts?: Record<string, unknown>;
      };
      const receiptMarkers = metadata.schedulingApplyReceipts;
      if (!receiptMarkers)
        throw new Error("expected lifecycle receipt markers");
      expect(Object.keys(receiptMarkers)).toHaveLength(2);

      const replayed = await Promise.all(
        requests.map((options) =>
          runner.applyWithResult(
            created.task.taskId,
            "complete",
            { reason: "must not replace the committed receipt" },
            options,
          ),
        ),
      );
      expect(replayed.map((result) => result.replayed)).toEqual([true, true]);
      expect(replayed.map((result) => result.commit.logId).sort()).toEqual(
        applied.map((result) => result.commit.logId).sort(),
      );

      const tasks = await runner.list();
      expect(
        tasks.filter(
          (task) =>
            task.taskId !== created.task.taskId &&
            task.state.pipelineParentId === created.task.taskId,
        ),
      ).toHaveLength(2);
      const finalCounts = await harness.pg.query<{
        completed_logs: number;
        tasks: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int
             FROM app_scheduling.life_scheduled_task_log
            WHERE agent_id = 'agent-sql-persist'
              AND task_id = '${created.task.taskId}'
              AND transition = 'completed') AS completed_logs,
          (SELECT COUNT(*)::int
             FROM app_scheduling.life_scheduled_tasks
            WHERE agent_id = 'agent-sql-persist') AS tasks
      `);
      expect(finalCounts.rows[0]).toEqual({ completed_logs: 2, tasks: 3 });
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "rolls back task state when the atomic lifecycle receipt insert fails",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const { runner } = await startSqlRunner(harness);
      const created = await runner.scheduleWithResult(
        receiptReminderInput("lifecycle-atomic-failure-task"),
      );
      await harness.pg.query(`
        ALTER TABLE app_scheduling.life_scheduled_task_log
          ADD CONSTRAINT reject_injected_snooze_receipt
          CHECK (transition <> 'snoozed')
      `);

      const apply = () =>
        runner.applyWithResult(
          created.task.taskId,
          "snooze",
          { minutes: 7 },
          { idempotencyKey: "message-atomic-failure:snooze" },
        );
      await expect(apply()).rejects.toThrow("reject_injected_snooze_receipt");

      const afterFailure = await runner.list();
      expect(afterFailure[0]?.state).toEqual(created.task.state);
      expect(
        afterFailure[0]?.metadata?.schedulingApplyReceipts,
      ).toBeUndefined();
      const failedLogs = await harness.pg.query<{ apply_logs: number }>(`
        SELECT COUNT(*)::int AS apply_logs
          FROM app_scheduling.life_scheduled_task_log
         WHERE agent_id = 'agent-sql-persist'
           AND transition = 'snoozed'
      `);
      expect(failedLogs.rows[0]).toEqual({ apply_logs: 0 });

      await harness.pg.query(`
        ALTER TABLE app_scheduling.life_scheduled_task_log
          DROP CONSTRAINT reject_injected_snooze_receipt
      `);
      const applied = await apply();
      expect(applied.replayed).toBe(false);
      expect(applied.task.state.firedAt).toBe("2026-08-16T03:07:00.000Z");
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "writes neither task state nor a receipt when lifecycle input is invalid",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const { runner } = await startSqlRunner(harness);
      const created = await runner.scheduleWithResult(
        receiptReminderInput("lifecycle-invalid-task"),
      );

      await expect(
        runner.applyWithResult(
          created.task.taskId,
          "snooze",
          { minutes: 0 },
          { idempotencyKey: "message-3:snooze" },
        ),
      ).rejects.toThrow("snooze: provide minutes or untilIso");

      const persisted = await runner.list();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.state).toEqual(created.task.state);
      expect(persisted[0]?.metadata?.schedulingApplyReceipts).toBeUndefined();
      const logs = await harness.pg.query<{ apply_logs: number }>(`
        SELECT COUNT(*)::int AS apply_logs
          FROM app_scheduling.life_scheduled_task_log
         WHERE agent_id = 'agent-sql-persist'
           AND transition IN ('snoozed', 'completed', 'dismissed')
      `);
      expect(logs.rows[0]).toEqual({ apply_logs: 0 });
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "retains creation and lifecycle receipt identities beyond the log rollup window",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const { runner, logStore } = await startSqlRunner(harness);
      const input = receiptReminderInput("receipt-after-rollup");
      const created = await runner.scheduleWithResult(input);
      const applied = await runner.applyWithResult(
        created.task.taskId,
        "snooze",
        { minutes: 5 },
        { idempotencyKey: "message-after-rollup:snooze" },
      );

      const rollup = await logStore.rollupOlderThan({
        agentId: harness.runtime.agentId,
        olderThanIso: "2026-08-17T00:00:00.000Z",
      });
      const replay = await runner.scheduleWithResult(input);
      const applyReplay = await runner.applyWithResult(
        created.task.taskId,
        "snooze",
        { minutes: 999 },
        { idempotencyKey: "message-after-rollup:snooze" },
      );

      expect(rollup).toEqual({ rolledUp: 0, deletedRaw: 0 });
      expect(replay.replayed).toBe(true);
      expect(replay.commit.logId).toBe(created.commit.logId);
      expect(applyReplay.replayed).toBe(true);
      expect(applyReplay.commit.logId).toBe(applied.commit.logId);
      expect(applyReplay.task.state.firedAt).toBe("2026-08-16T03:05:00.000Z");
      const raw = await logStore.list({
        agentId: harness.runtime.agentId,
        taskId: created.task.taskId,
        excludeRollups: true,
      });
      expect(raw.map((entry) => entry.logId)).toEqual([
        created.commit.logId,
        applied.commit.logId,
      ]);
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "copies legacy app_lifeops scheduled-task rows non-destructively",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      await harness.pg.query("CREATE SCHEMA IF NOT EXISTS app_lifeops");
      await harness.pg.query(
        `CREATE TABLE app_lifeops.life_scheduled_tasks
        (LIKE app_scheduling.life_scheduled_tasks INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
      await harness.pg.query(
        `CREATE TABLE app_lifeops.life_scheduled_task_log
        (LIKE app_scheduling.life_scheduled_task_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
      await harness.pg.query(
        `INSERT INTO app_scheduling.life_scheduled_tasks (
        id, agent_id, kind, prompt_instructions, trigger_json, priority,
        respects_global_pause, state_json, source, created_by, owner_visible,
        metadata_json, created_at, updated_at
      ) VALUES (
        'current-task', 'agent-sql-persist', 'reminder', 'already present',
        '{"kind":"manual"}', 'medium', TRUE,
        '{"status":"scheduled","followupCount":0}', 'plugin', 'current', TRUE,
        '{}', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
      )`,
      );
      await harness.pg.query(
        `INSERT INTO app_lifeops.life_scheduled_tasks (
        id, agent_id, kind, prompt_instructions, trigger_json, priority,
        respects_global_pause, state_json, source, created_by, owner_visible,
        metadata_json, created_at, updated_at
      ) VALUES (
        'legacy-watcher', 'agent-sql-persist', 'watcher', 'watch quietly',
        '{"kind":"event","eventKind":"owner.message"}', 'medium', TRUE,
        '{"status":"scheduled","followupCount":0}', 'plugin', 'legacy', TRUE,
        '{}', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
      )`,
      );
      await harness.pg.query(
        `INSERT INTO app_lifeops.life_scheduled_task_log (
        id, agent_id, task_id, occurred_at, transition, rolled_up
      ) VALUES (
        'legacy-log', 'agent-sql-persist', 'legacy-watcher',
        '2026-07-17T00:00:00.000Z', 'scheduled', FALSE
      )`,
      );

      const results = await migrateSchedulingTables(async (sql) => {
        const result = await harness.pg.query<Record<string, unknown>>(sql);
        return result.rows;
      });

      expect(results.map((result) => result.outcome)).toEqual([
        "copied",
        "copied",
      ]);
      const target = await harness.pg.query(
        "SELECT id, kind FROM app_scheduling.life_scheduled_tasks ORDER BY id",
      );
      expect(target.rows).toEqual([
        { id: "current-task", kind: "reminder" },
        { id: "legacy-watcher", kind: "watcher" },
      ]);
      const source = await harness.pg.query(
        "SELECT id FROM app_lifeops.life_scheduled_tasks",
      );
      expect(source.rows).toEqual([{ id: "legacy-watcher" }]);
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "freezes a claimed source row once a cutover reservation owns it",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const executeSql = async (sql: string) =>
        (await harness.pg.query<Record<string, unknown>>(sql)).rows;
      const store = createSchedulingSqlScheduledTaskStore({
        agentId: "personal:source",
        executeSql,
      });
      const task = {
        taskId: "claim-first",
        kind: "reminder",
        promptInstructions: "original occurrence",
        trigger: { kind: "once", atIso: "2026-07-17T09:00:00.000Z" },
        priority: "medium",
        respectsGlobalPause: true,
        state: { status: "scheduled", followupCount: 0 },
        source: "user_chat",
        createdBy: "owner",
        ownerVisible: true,
      } as ScheduledTask;
      await store.upsert(task, {
        nextFireAtIso: "2026-07-17T09:00:00.000Z",
      });
      const claim = await store.claimForFire({
        taskId: task.taskId,
        firedAtIso: "2026-07-17T09:00:00.000Z",
      });
      expect(claim.kind).toBe("fired");
      await harness.pg.query(`
        UPDATE app_scheduling.life_scheduled_tasks
           SET transfer_status = 'reserved',
               transfer_token = 'cutover-token',
               transfer_target_agent_id = 'dedicated-target'
         WHERE agent_id = 'personal:source' AND id = 'claim-first'
      `);

      await store.upsert({
        ...task,
        promptInstructions: "late dispatch mutation",
        state: {
          status: "fired",
          firedAt: "2026-07-17T09:00:00.000Z",
          followupCount: 1,
        },
      });

      const frozen = await store.get(task.taskId);
      expect(frozen).toMatchObject({
        promptInstructions: "original occurrence",
        state: {
          status: "fired",
          firedAt: "2026-07-17T09:00:00.000Z",
          followupCount: 0,
        },
      });
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "discovers only due reminders across agents in deterministic order",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      await harness.pg.query(`
        INSERT INTO app_scheduling.life_scheduled_tasks (
          id, agent_id, kind, prompt_instructions, trigger_json, priority,
          respects_global_pause, state_json, source, created_by, owner_visible,
          metadata_json, next_fire_at, created_at, updated_at
        ) VALUES
          ('later', 'personal:b', 'reminder', 'later', '{"kind":"once","atIso":"2026-07-17T10:00:00.000Z"}', 'medium', TRUE, '{"status":"scheduled","followupCount":0}', 'user_chat', 'owner', TRUE, '{}', '2026-07-17T10:00:00.000Z', '2026-07-17T08:00:00.000Z', '2026-07-17T08:00:00.000Z'),
          ('due-b', 'personal:b', 'reminder', 'due b', '{"kind":"once","atIso":"2026-07-17T09:00:00.000Z"}', 'medium', TRUE, '{"status":"scheduled","followupCount":0}', 'user_chat', 'owner', TRUE, '{}', '2026-07-17T09:00:00.000Z', '2026-07-17T08:00:00.000Z', '2026-07-17T08:00:00.000Z'),
          ('due-a', 'personal:a', 'reminder', 'due a', '{"kind":"once","atIso":"2026-07-17T09:00:00.000Z"}', 'medium', TRUE, '{"status":"scheduled","followupCount":0}', 'user_chat', 'owner', TRUE, '{}', '2026-07-17T09:00:00.000Z', '2026-07-17T08:00:00.000Z', '2026-07-17T08:00:00.000Z'),
          ('reserved', 'personal:a', 'reminder', 'reserved', '{"kind":"once","atIso":"2026-07-17T09:00:00.000Z"}', 'medium', TRUE, '{"status":"scheduled","followupCount":0}', 'user_chat', 'owner', TRUE, '{}', '2026-07-17T09:00:00.000Z', '2026-07-17T08:00:00.000Z', '2026-07-17T08:00:00.000Z'),
          ('import-reserved', 'dedicated', 'reminder', 'import reserved', '{"kind":"once","atIso":"2026-07-17T09:00:00.000Z"}', 'medium', TRUE, '{"status":"scheduled","followupCount":0}', 'user_chat', 'owner', TRUE, '{"sharedCutoverImport":{"status":"reserved"}}', '2026-07-17T09:00:00.000Z', '2026-07-17T08:00:00.000Z', '2026-07-17T08:00:00.000Z'),
          ('todo', 'personal:a', 'todo', 'not a reminder', '{"kind":"once","atIso":"2026-07-17T09:00:00.000Z"}', 'medium', TRUE, '{"status":"scheduled","followupCount":0}', 'user_chat', 'owner', TRUE, '{}', '2026-07-17T09:00:00.000Z', '2026-07-17T08:00:00.000Z', '2026-07-17T08:00:00.000Z')
      `);
      await harness.pg.query(`
        UPDATE app_scheduling.life_scheduled_tasks
           SET transfer_token = 'cutover',
               transfer_target_agent_id = 'dedicated',
               transfer_status = 'reserved'
         WHERE id = 'reserved'
      `);

      const due = await listDueScheduledTaskRefs(
        async (sql) =>
          (await harness.pg.query<Record<string, unknown>>(sql)).rows,
        { dueAtIso: "2026-07-17T09:00:00.000Z" },
      );

      expect(due).toEqual([
        { agentId: "personal:a", taskId: "due-a" },
        { agentId: "personal:b", taskId: "due-b" },
      ]);
      const sourceStore = createSchedulingSqlScheduledTaskStore({
        agentId: "personal:a",
        executeSql: async (sql) =>
          (await harness.pg.query<Record<string, unknown>>(sql)).rows,
      });
      await expect(
        sourceStore.claimForFire({
          taskId: "reserved",
          firedAtIso: "2026-07-17T09:00:00.000Z",
        }),
      ).resolves.toEqual({ kind: "raced" });
      const dedicatedStore = createSchedulingSqlScheduledTaskStore({
        agentId: "dedicated",
        executeSql: async (sql) =>
          (await harness.pg.query<Record<string, unknown>>(sql)).rows,
      });
      await expect(
        dedicatedStore.claimForFire({
          taskId: "import-reserved",
          firedAtIso: "2026-07-17T09:00:00.000Z",
        }),
      ).resolves.toEqual({ kind: "raced" });
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "leases only stale unsettled reminder claims for canonical recovery",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      await harness.pg.query(`
        INSERT INTO app_scheduling.life_scheduled_tasks (
          id, agent_id, kind, prompt_instructions, trigger_json, priority,
          respects_global_pause, state_json, source, created_by, owner_visible,
          metadata_json, next_fire_at, created_at, updated_at
        ) VALUES
          ('stale', 'agent-sql-persist', 'reminder', 'stale', '{"kind":"once","atIso":"2026-07-17T09:00:00.000Z"}', 'medium', TRUE, '{"status":"fired","firedAt":"2026-07-17T09:00:00.000Z","followupCount":0}', 'user_chat', 'owner', TRUE, '{"dispatchIdempotencyKey":"stable-occurrence"}', NULL, '2026-07-17T08:00:00.000Z', '2026-07-17T09:00:00.000Z'),
          ('fresh', 'agent-sql-persist', 'reminder', 'fresh', '{"kind":"once","atIso":"2026-07-17T09:01:00.000Z"}', 'medium', TRUE, '{"status":"fired","firedAt":"2026-07-17T09:01:00.000Z","followupCount":0}', 'user_chat', 'owner', TRUE, '{"dispatchIdempotencyKey":"fresh-occurrence"}', NULL, '2026-07-17T08:00:00.000Z', '2026-07-17T09:01:30.000Z'),
          ('settled', 'agent-sql-persist', 'reminder', 'settled', '{"kind":"once","atIso":"2026-07-17T08:59:00.000Z"}', 'medium', TRUE, '{"status":"fired","firedAt":"2026-07-17T08:59:00.000Z","followupCount":0}', 'user_chat', 'owner', TRUE, '{"lastDispatchResult":{"ok":true}}', NULL, '2026-07-17T08:00:00.000Z', '2026-07-17T08:59:00.000Z')
      `);
      const recoverable = await listRecoverableScheduledTaskRefs(
        async (sql) =>
          (await harness.pg.query<Record<string, unknown>>(sql)).rows,
        { updatedBeforeIso: "2026-07-17T09:01:00.000Z" },
      );
      expect(recoverable).toEqual([
        {
          agentId: "agent-sql-persist",
          taskId: "stale",
          firedAtIso: "2026-07-17T09:00:00.000Z",
        },
      ]);

      const dispatchKeys: unknown[] = [];
      registerScheduledTaskRunnerDeps(harness.runtime, (runtime, agentId) => ({
        store: createSchedulingSqlScheduledTaskStore({ runtime, agentId }),
        logStore: createSchedulingSqlScheduledTaskLogStore({
          runtime,
          agentId,
        }),
        dispatcher: {
          async dispatch(record): Promise<DispatchResult> {
            dispatchKeys.push(record.metadata?.dispatchIdempotencyKey);
            return { ok: true, messageId: "provider-receipt" };
          },
        },
        ownerFacts: () => ({ timezone: "UTC" }),
        globalPause: { current: async () => ({ active: false }) },
        activity: { hasSignalSince: () => false },
        subjectStore: { wasUpdatedSince: () => false },
      }));
      await startService(harness);
      const runner = getScheduledTaskRunner(harness.runtime, {
        agentId: harness.runtime.agentId,
        now: () => new Date("2026-07-17T09:02:00.000Z"),
      });
      const staleRef = recoverable[0];
      if (!staleRef) throw new Error("expected stale recovery candidate");
      const outcome = await runner.fireWithResult("stale", {
        recoverFiredAtIso: staleRef.firedAtIso,
      });
      expect(outcome.kind).toBe("fired");
      expect(dispatchKeys).toEqual(["stable-occurrence"]);
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps imported task ids tenant-scoped across agents",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      await harness.pg.query(`
        ALTER TABLE app_scheduling.life_scheduled_tasks
          DROP CONSTRAINT life_scheduled_tasks_pkey,
          ADD CONSTRAINT life_scheduled_tasks_pkey PRIMARY KEY (id)
      `);
      await migrateSchedulingTables(async (sql) => {
        const result = await harness.pg.query<Record<string, unknown>>(sql);
        return result.rows;
      });
      const executeSql = async (sql: string) =>
        (await harness.pg.query<Record<string, unknown>>(sql)).rows;
      const sourceStore = createSchedulingSqlScheduledTaskStore({
        agentId: "personal:source",
        executeSql,
      });
      const targetStore = createSchedulingSqlScheduledTaskStore({
        agentId: "personal:target",
        executeSql,
      });
      const task = {
        taskId: "caller-controlled-id",
        kind: "reminder" as const,
        promptInstructions: "source reminder",
        trigger: { kind: "once" as const, atIso: "2026-07-17T09:00:00.000Z" },
        priority: "medium" as const,
        respectsGlobalPause: true,
        state: { status: "scheduled" as const, followupCount: 0 },
        source: "user_chat" as const,
        createdBy: "owner",
        ownerVisible: true,
      };

      await sourceStore.upsert(task);
      await targetStore.upsert({
        ...task,
        promptInstructions: "target reminder",
      });

      await expect(sourceStore.get(task.taskId)).resolves.toMatchObject({
        promptInstructions: "source reminder",
      });
      await expect(targetStore.get(task.taskId)).resolves.toMatchObject({
        promptInstructions: "target reminder",
      });
      const rows = await harness.pg.query(
        `SELECT agent_id, prompt_instructions
           FROM app_scheduling.life_scheduled_tasks
          WHERE id = 'caller-controlled-id'
          ORDER BY agent_id`,
      );
      expect(rows.rows).toEqual([
        {
          agent_id: "personal:source",
          prompt_instructions: "source reminder",
        },
        {
          agent_id: "personal:target",
          prompt_instructions: "target reminder",
        },
      ]);
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "refuses cross-tenant overwrite when an imported id collides with another agent's task",
    async () => {
      // Tenant-integrity authority (#19811 review): task ids are
      // caller-controlled through the shared-cutover import path, and the
      // store's upsert used to resolve conflicts on the GLOBAL id, so an
      // attacker importing a victim's task id overwrote the victim's row
      // while keeping the victim's agent identity - injected work that would
      // execute and deliver as the victim. With (agent_id, id) as primary
      // authority both tenants keep independent rows.
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const executeSql = async (sql: string) =>
        (await harness.pg.query<Record<string, unknown>>(sql)).rows;
      const victimStore = createSchedulingSqlScheduledTaskStore({
        agentId: "personal:victim",
        executeSql,
      });
      const attackerStore = createSchedulingSqlScheduledTaskStore({
        agentId: "personal:attacker",
        executeSql,
      });
      const baseTask = {
        taskId: "shared-task-id",
        kind: "reminder",
        promptInstructions: "victim's reminder",
        trigger: { type: "once", atIso: "2026-07-17T09:00:00.000Z" },
        priority: "medium",
        respectsGlobalPause: true,
        state: { status: "scheduled", firedAt: null },
        source: "user_chat",
        createdBy: "victim-user",
        ownerVisible: true,
        metadata: {},
      } as unknown as ScheduledTask;
      await victimStore.upsert(baseTask, {
        nextFireAtIso: "2026-07-17T09:00:00.000Z",
      });

      // The attacker's agent-scoped lookup cannot see the victim's row - the
      // exact precondition of the import path - and then writes the same id.
      await expect(attackerStore.get("shared-task-id")).resolves.toBeNull();
      const attackerTask = {
        ...baseTask,
        promptInstructions: "attacker payload",
        createdBy: "attacker-user",
      } as unknown as ScheduledTask;
      await attackerStore.upsert(attackerTask, {
        nextFireAtIso: "2026-07-17T09:00:00.000Z",
      });

      // Neither overwrite...
      const rows = await harness.pg.query<{
        agent_id: string;
        prompt_instructions: string;
        created_by: string;
      }>(
        `SELECT agent_id, prompt_instructions, created_by
           FROM app_scheduling.life_scheduled_tasks
          WHERE id = 'shared-task-id'
          ORDER BY agent_id`,
      );
      expect(rows.rows).toEqual([
        {
          agent_id: "personal:attacker",
          prompt_instructions: "attacker payload",
          created_by: "attacker-user",
        },
        {
          agent_id: "personal:victim",
          prompt_instructions: "victim's reminder",
          created_by: "victim-user",
        },
      ]);

      // ...nor cross-agent execution: each agent's store claims only its own
      // row, and the due scan yields one ref per tenant.
      const due = await listDueScheduledTaskRefs(executeSql, {
        dueAtIso: "2026-07-17T09:00:00.000Z",
      });
      expect(due).toEqual([
        { agentId: "personal:attacker", taskId: "shared-task-id" },
        { agentId: "personal:victim", taskId: "shared-task-id" },
      ]);
      const victimClaim = await victimStore.claimForFire({
        taskId: "shared-task-id",
        firedAtIso: "2026-07-17T09:00:00.000Z",
      });
      expect(victimClaim.kind).toBe("fired");
      const victimRow = await victimStore.get("shared-task-id");
      expect(victimRow?.promptInstructions).toBe("victim's reminder");
      const attackerRow = await attackerStore.get("shared-task-id");
      expect(attackerRow?.state.status).toBe("scheduled");
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a due watcher through runner service re-init and fires it",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const dispatches: string[] = [];
      const dispatcher: ScheduledTaskDispatcher = {
        async dispatch(record): Promise<DispatchResult> {
          dispatches.push(record.taskId);
          return { ok: true, messageId: `msg:${record.taskId}` };
        },
      };
      registerScheduledTaskRunnerDeps(harness.runtime, (runtime, agentId) => ({
        store: createSchedulingSqlScheduledTaskStore({ runtime, agentId }),
        logStore: createSchedulingSqlScheduledTaskLogStore({
          runtime,
          agentId,
        }),
        dispatcher,
        ownerFacts: () => ({ timezone: "UTC" }),
        globalPause: { current: async () => ({ active: false }) },
        activity: { hasSignalSince: () => false },
        subjectStore: { wasUpdatedSince: () => false },
      }));
      const firstService = await startService(harness);
      const firstRunner = getScheduledTaskRunner(harness.runtime, {
        agentId: harness.runtime.agentId,
        now: () => new Date("2026-07-17T09:00:00.000Z"),
      });
      const scheduled = await firstRunner.schedule({
        kind: "watcher",
        promptInstructions: "Check the persisted watcher.",
        trigger: { kind: "once", atIso: "2026-07-17T09:00:00.000Z" },
        priority: "medium",
        respectsGlobalPause: true,
        source: "plugin",
        createdBy: "test",
        ownerVisible: true,
        executionProfile: "bg-heavy-fgs",
      });

      await firstService.stop();
      harness.setService(null);
      await startService(harness);
      const restartedRunner = getScheduledTaskRunner(harness.runtime, {
        agentId: harness.runtime.agentId,
        now: () => new Date("2026-07-17T09:01:00.000Z"),
      });

      const restored = await restartedRunner.list({
        kind: "watcher",
        status: "scheduled",
      });
      expect(restored.map((task) => task.taskId)).toEqual([scheduled.taskId]);
      expect(restored[0]?.executionProfile).toBe("bg-heavy-fgs");

      const fired = await restartedRunner.fire(scheduled.taskId);

      expect(fired.state.status).toBe("fired");
      expect(dispatches).toEqual([scheduled.taskId]);
      const rows = await harness.pg.query<{ status: string }>(
        `SELECT state_json::jsonb ->> 'status' AS status
         FROM app_scheduling.life_scheduled_tasks
        WHERE id = '${scheduled.taskId}'`,
      );
      expect(rows.rows[0]?.status).toBe("fired");
    },
    SQL_PERSISTENCE_TEST_TIMEOUT_MS,
  );
});
