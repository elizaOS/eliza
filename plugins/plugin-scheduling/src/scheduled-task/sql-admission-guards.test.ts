/**
 * Real PGlite coverage for admission snapshots and atomic occurrence consumption.
 * Independent SQL stores race against the same durable rows; no store operations
 * are mocked, and stale mutations must leave both task state and receipts intact.
 */
import { PGlite } from "@electric-sql/pglite";
import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSchedulingTables } from "./migration.js";
import type { ScheduledTaskStore } from "./runner.js";
import { createSchedulingSqlScheduledTaskStore } from "./store.js";
import type { ScheduledTask, ScheduledTaskLogEntry } from "./types.js";

const agentId = "admission-owner";
const fireAt = "2026-09-22T12:00:00.000Z";
const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});

function taskInput(): ScheduledTask {
  return {
    taskId: "owner-daily-task",
    kind: "recap",
    promptInstructions: "Produce the admitted owner report.",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "owner.activity",
      offsetMinutes: 0,
    },
    priority: "medium",
    respectsGlobalPause: true,
    source: "default_pack",
    createdBy: "owner",
    ownerVisible: true,
    state: { status: "scheduled", followupCount: 0 },
    metadata: { admission: { day: "2026-09-22", signalId: "foreground-1" } },
  };
}

async function setup() {
  const pg = new PGlite();
  databases.push(pg);
  const executeSql = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  const db: CarveOutDatabase = {
    execute: executeSql,
    transaction: (operation) =>
      pg.transaction((transaction) =>
        operation(
          async (statement) =>
            (await transaction.query<Record<string, unknown>>(statement)).rows,
        ),
      ),
  };
  await migrateSchedulingTables(db);
  const store = (owner = agentId) =>
    createSchedulingSqlScheduledTaskStore({ agentId: owner, executeSql });
  const first = store();
  await first.upsert(taskInput(), { nextFireAtIso: fireAt });
  return { pg, first, second: store(), store };
}

async function read(store: ScheduledTaskStore): Promise<ScheduledTask> {
  const task = await store.get("owner-daily-task");
  if (!task) throw new Error("Expected persisted admission task");
  return task;
}

function observed(task: ScheduledTask) {
  const { state, metadata, ...definition } = task;
  return {
    expectedState: state,
    expectedMetadata: metadata ?? {},
    expectedDefinition: definition,
  };
}

function commit(task: ScheduledTask, key: string): ScheduledTaskLogEntry {
  return {
    logId: `admission-${key}`,
    taskId: task.taskId,
    agentId,
    occurredAtIso: fireAt,
    transition: "dismissed",
    rolledUp: false,
  };
}

describe("SQL admission snapshot guards", () => {
  it("commits one concurrent activity proposal and retains it after store reconstruction", async () => {
    const h = await setup();
    const left = await read(h.first);
    const right = await read(h.second);
    const results = await Promise.all(
      [left, right].map((task, index) =>
        (index === 0 ? h.first : h.second).upsertIfStatus(
          {
            ...task,
            metadata: {
              ...task.metadata,
              admission: { day: "2026-09-23", signalId: `device-${index}` },
            },
          },
          {
            ...observed(task),
            expectedStatus: task.state.status,
            nextFireAtIso: fireAt,
          },
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect((await read(h.store())).metadata?.admission).toEqual({
      day: "2026-09-23",
      signalId: `device-${winner}`,
    });
  }, 15_000);

  it("consumes activity in exactly one claim and leaves other agents untouched", async () => {
    const h = await setup();
    const other = h.store("another-owner");
    await other.upsert(taskInput());
    const snapshots = await Promise.all([read(h.first), read(h.second)]);
    const results = await Promise.all(
      snapshots.map((task, index) =>
        (index === 0 ? h.first : h.second).claimForFire({
          taskId: task.taskId,
          firedAtIso: fireAt,
          ...observed(task),
          claimedMetadata: {
            ...task.metadata,
            admission: null,
            consumedDay: "2026-09-22",
          },
        }),
      ),
    );
    expect(results.map((result) => result.kind).sort()).toEqual([
      "fired",
      "raced",
    ]);
    const persisted = await read(h.store());
    expect(persisted.state).toMatchObject({ status: "fired", firedAt: fireAt });
    expect(persisted.metadata).toMatchObject({
      admission: null,
      consumedDay: "2026-09-22",
    });
    const index = await h.pg.query<{ next_fire_at: string | null }>(
      "SELECT next_fire_at FROM app_scheduling.life_scheduled_tasks WHERE agent_id = 'admission-owner'",
    );
    expect(index.rows[0]?.next_fire_at).toBeNull();
    expect((await read(other)).state.status).toBe("scheduled");
    expect((await read(other)).metadata?.admission).toEqual(
      taskInput().metadata?.admission,
    );
    expect(
      (
        await h
          .store()
          .claimForFire({
            taskId: persisted.taskId,
            firedAtIso: fireAt,
            ...observed(snapshots[0]),
            claimedMetadata: {},
          })
      ).kind,
    ).toBe("raced");
  }, 15_000);

  it.each(["state", "metadata", "definition"] as const)(
    "rejects stale %s for admission, claim, and owner mutation without a receipt",
    async (field) => {
      const h = await setup();
      const stale = await read(h.first);
      const changed = structuredClone(stale);
      if (field === "state") changed.state.followupCount = 1;
      if (field === "metadata")
        changed.metadata = { ...changed.metadata, enabled: false };
      if (field === "definition") changed.trigger = { kind: "manual" };
      await h.second.upsert(changed);
      const expected = await read(h.second);
      expect(
        await h.first.upsertIfStatus(stale, {
          expectedStatus: stale.state.status,
          ...observed(stale),
        }),
      ).toBe(false);
      expect(
        await h.first.claimForFire({
          taskId: stale.taskId,
          firedAtIso: fireAt,
          ...observed(stale),
          claimedMetadata: {},
        }),
      ).toEqual({ kind: "raced" });
      await expect(
        h.first.commitApply({
          task: { ...stale, state: { ...stale.state, status: "dismissed" } },
          receiptKey: "stale",
          commit: commit(stale, "stale"),
          nextFireAtIso: null,
          ...observed(stale),
        }),
      ).rejects.toMatchObject({ code: "SCHEDULED_TASK_MUTATION_RACED" });
      expect(await read(h.first)).toEqual(expected);
      const logs = await h.pg.query(
        "SELECT id FROM app_scheduling.life_scheduled_task_log",
      );
      expect(logs.rows).toHaveLength(0);
    },
    15_000,
  );

  it("does not let final persistence erase activity admitted during dispatch", async () => {
    const h = await setup();
    const task = await read(h.first);
    const claim = await h.first.claimForFire({
      taskId: task.taskId,
      firedAtIso: fireAt,
      ...observed(task),
      claimedMetadata: { ...task.metadata, admission: null },
    });
    if (claim.kind !== "fired")
      throw new Error("Expected first claim to succeed");
    const newer = await read(h.second);
    expect(
      await h.second.upsertIfStatus(
        {
          ...newer,
          metadata: {
            ...newer.metadata,
            admission: { day: "2026-09-23", signalId: "next-day" },
          },
        },
        { expectedStatus: "fired", ...observed(newer) },
      ),
    ).toBe(true);
    expect(
      await h.first.upsertIfStatus(
        { ...claim.task, state: { ...claim.task.state, status: "completed" } },
        { expectedStatus: "fired", ...observed(claim.task) },
      ),
    ).toBe(false);
    expect((await read(h.first)).metadata?.admission).toEqual({
      day: "2026-09-23",
      signalId: "next-day",
    });
  }, 15_000);

  it("does not resurrect a deleted task through a guarded write or claim", async () => {
    const h = await setup();
    const stale = await read(h.first);
    await h.second.delete(stale.taskId);
    expect(
      await h.first.upsertIfStatus(stale, {
        expectedStatus: "scheduled",
        ...observed(stale),
      }),
    ).toBe(false);
    expect(
      await h.first.claimForFire({
        taskId: stale.taskId,
        firedAtIso: fireAt,
        ...observed(stale),
        claimedMetadata: {},
      }),
    ).toEqual({ kind: "raced" });
    expect(await h.first.get(stale.taskId)).toBeNull();
  }, 15_000);

  it.each(["expectedState", "expectedMetadata", "expectedDefinition"] as const)(
    "rejects metadata replacement without %s",
    async (missing) => {
      const h = await setup();
      const task = await read(h.first);
      const guards = { ...observed(task), [missing]: undefined };
      await expect(
        h.first.claimForFire({
          taskId: task.taskId,
          firedAtIso: fireAt,
          ...guards,
          claimedMetadata: {},
        }),
      ).rejects.toMatchObject({
        code: "SCHEDULED_TASK_CLAIM_EXPECTATION_REQUIRED",
      });
      expect(await read(h.first)).toEqual(task);
    },
    15_000,
  );

  it("replays a committed guarded receipt even though its original snapshot is stale", async () => {
    const h = await setup();
    const task = await read(h.first);
    const proposal = {
      task: { ...task, state: { ...task.state, status: "dismissed" as const } },
      receiptKey: "disable",
      commit: commit(task, "disable"),
      nextFireAtIso: null,
      ...observed(task),
    };
    const results = await Promise.all([
      h.first.commitApply(proposal),
      h.second.commitApply(proposal),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "applied",
      "replayed",
    ]);
    expect((await read(h.store())).state.status).toBe("dismissed");
    const logs = await h.pg.query(
      "SELECT id FROM app_scheduling.life_scheduled_task_log",
    );
    expect(logs.rows).toHaveLength(1);
  }, 15_000);
});
