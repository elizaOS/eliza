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

  it("copies legacy app_lifeops scheduled-task rows non-destructively", async () => {
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
  }, SQL_PERSISTENCE_TEST_TIMEOUT_MS);

  it("keeps a due watcher through runner service re-init and fires it", async () => {
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
      logStore: createSchedulingSqlScheduledTaskLogStore({ runtime, agentId }),
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
  }, SQL_PERSISTENCE_TEST_TIMEOUT_MS);
});
