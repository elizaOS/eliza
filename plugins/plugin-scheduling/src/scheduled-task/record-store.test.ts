/** Exercises actual SQLite-backed scheduling workers, restart recovery and durable lifecycle receipts. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCompletionCheckRegistry } from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import { createEscalationLadderRegistry } from "./escalation.js";
import { createTaskGateRegistry } from "./gate-registry.js";
import { createSchedulingRecordStores } from "./record-store.js";
import { createScheduledTaskRunner } from "./runner.js";
import type { ScheduledTask, ScheduledTaskLogEntry } from "./types.js";

const agentId = randomUUID() as UUID;
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];
async function open() {
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  opened.push(adapter);
  await adapter.initialize();
  return adapter;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scheduling-sqlite-"));
});
afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  await rm(directory, { recursive: true, force: true });
});
function task(): ScheduledTask {
  return {
    taskId: randomUUID(),
    kind: "reminder",
    promptInstructions: "Synthetic stretch reminder",
    trigger: { kind: "once", atIso: "2026-09-22T12:00:00.000Z" },
    priority: "medium",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "user_chat",
    createdBy: "synthetic",
    ownerVisible: true,
  };
}
function receipt(row: ScheduledTask, key: string): ScheduledTaskLogEntry {
  return {
    logId: `receipt-${key}`,
    agentId,
    taskId: row.taskId,
    occurredAtIso: "2026-09-22T12:00:00.000Z",
    transition: "completed",
    rolledUp: false,
    detail: { receiptKey: key, verb: "complete" },
  };
}

it("allows only one durable claim across two workers and never overwrites a later user action", async () => {
  const adapter = await open();
  const first = createSchedulingRecordStores(adapter.recordStore, agentId);
  const second = createSchedulingRecordStores(adapter.recordStore, agentId);
  const row = task();
  await first.store.upsert(row, { nextFireAtIso: "2026-09-22T12:00:00.000Z" });
  const claims = await Promise.all(
    [first, second].map((worker) =>
      worker.store.claimForFire({
        taskId: row.taskId,
        firedAtIso: "2026-09-22T12:00:00.000Z",
      }),
    ),
  );
  expect(claims.map((result) => result.kind).sort()).toEqual([
    "fired",
    "raced",
  ]);
  const completed = {
    ...row,
    state: { ...row.state, status: "completed" as const },
  };
  expect(
    await second.store.upsertIfStatus(completed, {
      expectedStatus: "fired",
      nextFireAtIso: null,
    }),
  ).toBe(true);
  expect(
    await first.store.upsertIfStatus(row, {
      expectedStatus: "fired",
      nextFireAtIso: null,
    }),
  ).toBe(false);
  await adapter.close();
  const reopened = await open();
  expect(
    (
      await createSchedulingRecordStores(
        reopened.recordStore,
        agentId,
      ).store.get(row.taskId)
    )?.state.status,
  ).toBe("completed");
});

it("commits task changes and their receipt once, retains proof through restart and rolls back invalid receipts", async () => {
  const adapter = await open();
  const a = createSchedulingRecordStores(adapter.recordStore, agentId);
  const b = createSchedulingRecordStores(adapter.recordStore, agentId);
  const row = task();
  await a.store.upsert(row);
  const completed = {
    ...row,
    state: { ...row.state, status: "completed" as const },
  };
  const commit = receipt(row, "once");
  const results = await Promise.all(
    [a, b].map((worker) =>
      worker.store.commitApply({
        task: completed,
        receiptKey: "once",
        commit,
        nextFireAtIso: null,
      }),
    ),
  );
  expect(results.map((result) => result.kind).sort()).toEqual([
    "applied",
    "replayed",
  ]);
  await expect(
    a.store.commitApply({
      task: { ...row, state: { ...row.state, status: "dismissed" } },
      receiptKey: "bad",
      commit: { ...receipt(row, "bad"), detail: { receiptKey: "different" } },
      nextFireAtIso: null,
    }),
  ).rejects.toMatchObject({ code: "SCHEDULING_RECORD_STORE_INVALID" });
  expect((await a.store.get(row.taskId))?.state.status).toBe("completed");
  await adapter.close();
  const reopened = await open();
  const restored = createSchedulingRecordStores(reopened.recordStore, agentId);
  expect(
    (
      await restored.store.commitApply({
        task: completed,
        receiptKey: "once",
        commit,
        nextFireAtIso: null,
      })
    ).kind,
  ).toBe("replayed");
  expect(await restored.logStore.list({ agentId, taskId: row.taskId })).toEqual(
    [commit],
  );
  expect(
    await restored.logStore.rollupOlderThan({
      agentId,
      olderThanIso: "2027-01-01T00:00:00.000Z",
    }),
  ).toEqual({ rolledUp: 0, deletedRaw: 0 });
});

it("runs the actual scheduling runner against persistent SQLite and replays lifecycle receipts after restart", async () => {
  const adapter = await open();
  let dispatches = 0;
  const makeRunner = (db: SQLiteDatabaseAdapter) =>
    createScheduledTaskRunner({
      agentId,
      ...createSchedulingRecordStores(db.recordStore, agentId),
      gates: createTaskGateRegistry(),
      completionChecks: createCompletionCheckRegistry(),
      ladders: createEscalationLadderRegistry(),
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: () => ({ timezone: "UTC" }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      dispatcher: {
        dispatch: async () => {
          dispatches++;
        },
      },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
  const runner = makeRunner(adapter);
  const input = task();
  const scheduled = await runner.schedule({
    ...input,
    idempotencyKey: "real-runner",
  });
  const otherRunner = makeRunner(adapter);
  await Promise.all([
    runner.fire(scheduled.taskId),
    otherRunner.fire(scheduled.taskId),
  ]);
  expect(dispatches).toBe(1);
  const result = await runner.applyWithResult(
    scheduled.taskId,
    "complete",
    {},
    { idempotencyKey: "complete-once" },
  );
  expect(result.task.state.status).toBe("completed");
  await adapter.close();
  const reopened = await open();
  const replay = await makeRunner(reopened).applyWithResult(
    scheduled.taskId,
    "complete",
    {},
    { idempotencyKey: "complete-once" },
  );
  expect(replay.replayed).toBe(true);
  expect(replay.commit).toEqual(result.commit);
  const stores = createSchedulingRecordStores(reopened.recordStore, agentId);
  expect(
    (await stores.store.findByIdempotencyKey("real-runner"))?.state.status,
  ).toBe("completed");
  expect(
    (await stores.logStore.list({ agentId, taskId: scheduled.taskId })).some(
      (log) => log.transition === "completed",
    ),
  ).toBe(true);
});

it("rejects stale admission, preserves intent reservations and blocks pending cutover execution", async () => {
  const adapter = await open();
  const { store } = createSchedulingRecordStores(adapter.recordStore, agentId);
  const row = task();
  row.metadata = { policy: "v1" };
  await store.upsert(row);
  const observed = await store.get(row.taskId);
  if (!observed) throw new Error("task missing");
  await store.upsert({
    ...observed,
    metadata: { ...observed.metadata, policy: "v2" },
  });
  expect(
    await store.claimForFire({
      taskId: row.taskId,
      firedAtIso: "2026-09-22T12:00:00.000Z",
      expectedMetadata: observed.metadata,
    }),
  ).toEqual({ kind: "raced" });
  const current = await store.get(row.taskId);
  if (!current) throw new Error("task missing");
  await Promise.all(
    ["a", "b"].map((key) =>
      store.reserveApplyIntent({
        task: {
          ...current,
          metadata: {
            ...current.metadata,
            schedulingApplyIntents: { [key]: { command: key } },
          },
        },
        intentKey: key,
      }),
    ),
  );
  expect(
    (await store.get(row.taskId))?.metadata?.schedulingApplyIntents,
  ).toEqual({ a: { command: "a" }, b: { command: "b" } });
  await store.upsert({
    ...current,
    metadata: {
      ...current.metadata,
      sharedCutoverImport: { status: "reserved" },
    },
  });
  expect(
    await store.claimForFire({
      taskId: row.taskId,
      firedAtIso: "2026-09-22T12:00:00.000Z",
    }),
  ).toEqual({ kind: "raced" });
  await expect(
    store.reserveApplyIntent({ task: current, intentKey: "blocked" }),
  ).rejects.toMatchObject({ code: "SCHEDULING_RECORD_STORE_INVALID" });
});

it("rolls up ordinary history atomically while retaining creation and receipt proof across restart", async () => {
  const adapter = await open();
  const { store, logStore } = createSchedulingRecordStores(
    adapter.recordStore,
    agentId,
  );
  const row = task();
  await store.upsert(row);
  const creation = {
    ...receipt(row, "creation"),
    logId: "created",
    transition: "scheduled" as const,
    detail: undefined,
  };
  const ordinary = {
    ...receipt(row, "ordinary"),
    logId: "ordinary",
    transition: "fire_attempt" as const,
    detail: undefined,
  };
  await logStore.append(creation);
  await logStore.append(ordinary);
  await logStore.append(receipt(row, "retained"));
  expect(
    await logStore.rollupOlderThan({
      agentId,
      olderThanIso: "2027-01-01T00:00:00.000Z",
    }),
  ).toEqual({ rolledUp: 1, deletedRaw: 1 });
  expect(
    await logStore.rollupOlderThan({
      agentId,
      olderThanIso: "2027-01-01T00:00:00.000Z",
    }),
  ).toEqual({ rolledUp: 0, deletedRaw: 0 });
  await adapter.close();
  const reopened = await open();
  const restored = createSchedulingRecordStores(reopened.recordStore, agentId);
  const rows = await restored.logStore.list({ agentId, taskId: row.taskId });
  expect(rows).toHaveLength(3);
  expect(rows.find((log) => log.rolledUp)?.detail?.rollupCount).toBe(1);
  expect(rows.map((log) => log.logId)).toContain("created");
  expect(rows.map((log) => log.logId)).toContain("receipt-retained");
  await restored.store.delete(row.taskId);
  expect(await restored.logStore.list({ agentId, taskId: row.taskId })).toEqual(
    [],
  );
});

it("rejects foreign agent access and duplicate idempotency without partial changes", async () => {
  const adapter = await open();
  const stores = createSchedulingRecordStores(adapter.recordStore, agentId);
  expect(() =>
    createSchedulingRecordStores(adapter.recordStore, randomUUID()),
  ).toThrow();
  const row = task();
  row.idempotencyKey = "unique";
  await stores.store.upsert(row);
  const duplicate = { ...row, taskId: randomUUID() };
  await expect(stores.store.upsert(duplicate)).rejects.toMatchObject({
    code: "SCHEDULING_RECORD_STORE_INVALID",
  });
  expect(await stores.store.get(duplicate.taskId)).toBeNull();
  await expect(
    stores.logStore.append({
      ...receipt(row, "foreign"),
      agentId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "SCHEDULING_RECORD_STORE_INVALID" });
  await expect(
    stores.logStore.list({ agentId: randomUUID(), taskId: row.taskId }),
  ).rejects.toMatchObject({ code: "SCHEDULING_RECORD_STORE_INVALID" });
  expect(await stores.logStore.list({ agentId, taskId: row.taskId })).toEqual(
    [],
  );
});

it("keeps domain records out of core collections and rejects unsupported domain schema versions", async () => {
  const adapter = await open();
  expect(() => adapter.recordStore.set("memories", "unexpected", {})).toThrow(
    expect.objectContaining({ code: "SQLITE_RECORD_NAMESPACE_INVALID" }),
  );
  await adapter.recordStore.set("plugin_scheduling_schema", "version", 2);
  const { store } = createSchedulingRecordStores(adapter.recordStore, agentId);
  await expect(store.list()).rejects.toMatchObject({
    code: "SCHEDULING_RECORD_STORE_INVALID",
  });
  expect(
    await adapter.recordStore.get("plugin_scheduling_schema", "version"),
  ).toBe(2);
});
