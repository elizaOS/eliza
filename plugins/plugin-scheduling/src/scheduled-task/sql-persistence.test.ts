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
import type { ScheduledTaskDispatcher } from "./runner.js";
import {
  getScheduledTaskRunner,
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./runner-service.js";
import {
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
  listDueScheduledTaskRefs,
} from "./store.js";

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
    "keeps imported task ids tenant-scoped across agents",
    async () => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
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
