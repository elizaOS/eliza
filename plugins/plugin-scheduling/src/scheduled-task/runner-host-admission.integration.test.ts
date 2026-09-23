/**
 * Exercises host-owned admission through real runners and shared PGlite stores.
 * A synthetic host policy owns eligibility; the production runner and SQL store
 * own atomic claims and persistence across concurrent callers and reconstruction.
 */
import { PGlite } from "@electric-sql/pglite";
import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import { isScheduledTaskDue } from "./due.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import { migrateSchedulingTables } from "./migration.js";
import {
  createScheduledTaskRunner,
  type ScheduledTaskDispatcher,
  type ScheduledTaskMutationPolicy,
  type ScheduledTaskStore,
} from "./runner.js";
import {
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
} from "./store.js";
import type { ScheduledTask } from "./types.js";

const agentId = "host-admission-agent";
const taskId = "host-admission-task";
const nowIso = "2026-09-22T12:00:00.000Z";
const anchorKey = "test.owner.activity";
const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});

async function read(store: ScheduledTaskStore): Promise<ScheduledTask> {
  const task = await store.get(taskId);
  if (!task) throw new Error("Expected durable host-admission task");
  return task;
}

function expectation(task: ScheduledTask) {
  const { state, metadata, ...definition } = task;
  return {
    expectedState: state,
    expectedMetadata: metadata ?? {},
    expectedDefinition: definition,
    expectedStatus: state.status,
  };
}

function activityAt(task: ScheduledTask): string | null {
  if (task.metadata?.enabled !== true) return null;
  const value = task.metadata.activityAt;
  return typeof value === "string" ? value : null;
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
  const store = () =>
    createSchedulingSqlScheduledTaskStore({ agentId, executeSql });
  const initial: ScheduledTask = {
    taskId,
    kind: "recap",
    promptInstructions: "Generate the owner's admitted daily report.",
    trigger: { kind: "relative_to_anchor", anchorKey, offsetMinutes: 0 },
    priority: "medium",
    respectsGlobalPause: true,
    source: "default_pack",
    createdBy: "owner",
    ownerVisible: true,
    state: { status: "scheduled", followupCount: 0 },
    metadata: { enabled: true, activityAt: null, consumedDay: null },
  };
  await store().upsert(initial);
  let dispatchCount = 0;
  const build = (
    dispatch?: ScheduledTaskDispatcher["dispatch"],
    completion?: () => Promise<boolean>,
    mutation?: ScheduledTaskMutationPolicy,
  ) => {
    const durable = store();
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    if (completion)
      completionChecks.register({
        kind: "test_delayed_completion",
        shouldComplete: completion,
      });
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const anchors = createAnchorRegistry();
    anchors.register({
      anchorKey,
      consumption: "host_claim",
      describe: { label: "Owner activity", provider: "test-host" },
      async resolve() {
        const atIso = activityAt(await read(durable));
        return atIso === null ? null : { atIso };
      },
    });
    const runner = createScheduledTaskRunner({
      agentId,
      store: durable,
      logStore: createSchedulingSqlScheduledTaskLogStore({
        agentId,
        executeSql,
      }),
      gates,
      completionChecks,
      ladders,
      anchors,
      consolidation: createConsolidationRegistry(),
      ownerFacts: () => ({
        timezone: "UTC",
        morningWindow: { start: "07:00", end: "10:00" },
      }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      prepareMutation: mutation ?? (({ proposed }) => proposed),
      automaticAdmission: ({ task }) =>
        activityAt(task) === null
          ? { kind: "denied", reason: "no_owner_activity" }
          : { kind: "admitted" },
      prepareAutomaticFire: ({ task }) => {
        if (activityAt(task) === null)
          throw new Error("Host received an unadmitted automatic claim");
        return {
          ...task.metadata,
          activityAt: null,
          consumedDay: "2026-09-22",
        };
      },
      dispatcher: {
        async dispatch(...args) {
          dispatchCount += 1;
          if (dispatch) return dispatch(...args);
          return { ok: true, channelKey: "in_app" };
        },
      },
      now: () => new Date(nowIso),
    });
    return {
      runner,
      store: durable,
      anchors,
      logStore: createSchedulingSqlScheduledTaskLogStore({
        agentId,
        executeSql,
      }),
    };
  };
  const admit = async () => {
    const durable = store();
    const current = await read(durable);
    return durable.upsertIfStatus(
      { ...current, metadata: { ...current.metadata, activityAt: nowIso } },
      { ...expectation(current), nextFireAtIso: nowIso },
    );
  };
  return { build, store, admit, dispatchCount: () => dispatchCount };
}

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("host admission across SQL-backed runners", () => {
  it("keeps a missing host-claim anchor unresolved without claiming or dispatching", async () => {
    const h = await setup();
    const instance = h.build();
    const before = await read(instance.store);
    expect(
      await isScheduledTaskDue(before, {
        now: new Date(nowIso),
        ownerFacts: {
          timezone: "UTC",
          morningWindow: { start: "07:00", end: "10:00" },
        },
        anchors: instance.anchors,
      }),
    ).toMatchObject({ due: false });
    expect(await instance.runner.resolveNextFireAt(before)).toBeNull();
    expect(
      await instance.runner.fireWithResult(taskId, { cause: "automatic" }),
    ).toMatchObject({ kind: "skipped", reason: "no_owner_activity" });
    expect(await read(instance.store)).toEqual(before);
    expect(h.dispatchCount()).toBe(0);
  }, 15_000);

  it("consumes the first admission once across two runners and a reconstructed runner", async () => {
    const h = await setup();
    expect(await h.admit()).toBe(true);
    const first = h.build();
    const second = h.build();
    const results = await Promise.all(
      [first.runner, second.runner].map((runner) =>
        runner.fireWithResult(taskId, {
          cause: "automatic",
          allowTerminalRefire: true,
        }),
      ),
    );
    expect(results.filter((result) => result.kind === "fired")).toHaveLength(1);
    expect(h.dispatchCount()).toBe(1);
    const reconstructed = h.build();
    expect((await read(reconstructed.store)).metadata).toMatchObject({
      activityAt: null,
      consumedDay: "2026-09-22",
    });
    expect(
      await reconstructed.runner.fireWithResult(taskId, {
        cause: "automatic",
        allowTerminalRefire: true,
      }),
    ).toMatchObject({ kind: "skipped" });
    expect(h.dispatchCount()).toBe(1);
  }, 15_000);

  it("lets manual refresh run before and after automatic admission without spending it", async () => {
    const h = await setup();
    const instance = h.build();
    expect(
      (
        await instance.runner.fireWithResult(taskId, {
          cause: "manual",
          allowTerminalRefire: true,
        })
      ).kind,
    ).toBe("fired");
    expect((await read(instance.store)).metadata).toMatchObject({
      activityAt: null,
      consumedDay: null,
    });
    expect(await h.admit()).toBe(true);
    const admitted = await read(instance.store);
    expect(
      await isScheduledTaskDue(admitted, {
        now: new Date(nowIso),
        ownerFacts: { timezone: "UTC" },
        anchors: instance.anchors,
      }),
    ).toMatchObject({ due: true });
    expect(
      (
        await instance.runner.fireWithResult(taskId, {
          cause: "manual",
          allowTerminalRefire: true,
        })
      ).kind,
    ).toBe("fired");
    expect((await read(instance.store)).metadata).toMatchObject({
      activityAt: nowIso,
      consumedDay: null,
    });
    expect(
      (
        await instance.runner.fireWithResult(taskId, {
          cause: "automatic",
          allowTerminalRefire: true,
        })
      ).kind,
    ).toBe("fired");
    expect(
      (
        await instance.runner.fireWithResult(taskId, {
          cause: "manual",
          allowTerminalRefire: true,
        })
      ).kind,
    ).toBe("fired");
    expect((await read(instance.store)).metadata).toMatchObject({
      activityAt: null,
      consumedDay: "2026-09-22",
    });
    expect(h.dispatchCount()).toBe(4);
  }, 15_000);

  it("applies host control policy to validated edits before durable persistence", async () => {
    const h = await setup();
    const calls: Parameters<ScheduledTaskMutationPolicy>[0][] = [];
    const instance = h.build(undefined, undefined, (input) => {
      calls.push(structuredClone(input));
      return {
        ...input.proposed,
        metadata: {
          ...input.proposed.metadata,
          enabled: false,
          activityAt: null,
        },
      };
    });
    const before = await read(instance.store);
    const result = await instance.runner.apply(taskId, "edit", {
      priority: "high",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      previous: before,
      proposed: { priority: "high", metadata: before.metadata },
      verb: "edit",
      nowIso,
    });
    expect(result).toMatchObject({
      priority: "high",
      metadata: { enabled: false },
    });
    expect(await read(h.store())).toEqual(result);
    expect(
      (await instance.logStore.list({ agentId, taskId })).filter(
        (entry) => entry.transition === "edited",
      ),
    ).toHaveLength(1);
  }, 15_000);

  it.each(["state", "control"] as const)(
    "rejects a host-prepared edit when concurrent %s changes after its snapshot",
    async (change) => {
      const h = await setup();
      const entered = latch();
      const release = latch();
      const instance = h.build(undefined, undefined, async ({ proposed }) => {
        entered.release();
        await release.promise;
        return proposed;
      });
      const editing = instance.runner.apply(taskId, "edit", {
        priority: "high",
      });
      await Promise.race([
        entered.promise,
        editing.then(() => {
          throw new Error(
            "Edit persisted without reaching the host mutation policy",
          );
        }),
      ]);
      const other = h.store();
      let winner: ScheduledTask;
      try {
        const current = await read(other);
        const next: ScheduledTask =
          change === "state"
            ? { ...current, state: { ...current.state, status: "dismissed" } }
            : { ...current, metadata: { ...current.metadata, enabled: false } };
        expect(
          await other.upsertIfStatus(next, {
            ...expectation(current),
            nextFireAtIso: null,
          }),
        ).toBe(true);
        winner = await read(other);
      } finally {
        release.release();
      }
      await expect(editing).rejects.toMatchObject({
        code: "SCHEDULED_TASK_MUTATION_RACED",
      });
      expect(await read(h.store())).toEqual(winner);
      expect(
        (await instance.logStore.list({ agentId, taskId })).filter(
          (entry) => entry.transition === "edited",
        ),
      ).toHaveLength(0);
      expect(h.dispatchCount()).toBe(0);
    },
    15_000,
  );

  it("does not let delayed completion overwrite a concurrent owner disable", async () => {
    const h = await setup();
    const entered = latch();
    const release = latch();
    const instance = h.build(undefined, async () => {
      entered.release();
      await release.promise;
      return true;
    });
    const owner = h.build(undefined, async () => true);
    await owner.runner.apply(taskId, "edit", {
      completionCheck: { kind: "test_delayed_completion" },
    });
    expect(await h.admit()).toBe(true);
    await instance.runner.fireWithResult(taskId, { cause: "automatic" });
    const completing = instance.runner.evaluateCompletion(taskId, {
      acknowledged: true,
    });
    await Promise.race([
      entered.promise,
      completing.then(() => {
        throw new Error(
          "Completion finished before its predicate was suspended",
        );
      }),
    ]);
    let winner: ScheduledTask;
    try {
      const current = await read(owner.store);
      await owner.runner.apply(taskId, "edit", {
        metadata: { ...current.metadata, enabled: false },
      });
      winner = await read(owner.store);
    } finally {
      release.release();
    }
    await expect(completing).rejects.toMatchObject({
      code: "SCHEDULED_TASK_MUTATION_RACED",
    });
    expect(await read(owner.store)).toEqual(winner);
    expect((await read(owner.store)).state.status).toBe("fired");
    expect(
      (await owner.logStore.list({ agentId, taskId })).filter(
        (entry) => entry.transition === "completed",
      ),
    ).toHaveLength(0);
    expect(h.dispatchCount()).toBe(1);
  }, 15_000);

  it.each(["activity", "disable"] as const)(
    "retains a concurrent %s update while dispatch is suspended",
    async (change) => {
      const h = await setup();
      expect(await h.admit()).toBe(true);
      const entered = latch();
      const release = latch();
      const instance = h.build(async () => {
        entered.release();
        await release.promise;
        return { ok: true, channelKey: "in_app" };
      });
      const firing = instance.runner.fireWithResult(taskId, {
        cause: "automatic",
      });
      await entered.promise;
      const other = h.store();
      let winner: ScheduledTask;
      try {
        const current = await read(other);
        expect(
          await other.upsertIfStatus(
            {
              ...current,
              metadata: {
                ...current.metadata,
                ...(change === "disable"
                  ? { enabled: false }
                  : { activityAt: "2026-09-23T12:00:00.000Z" }),
              },
            },
            {
              ...expectation(current),
              nextFireAtIso:
                change === "activity" ? "2026-09-23T12:00:00.000Z" : null,
            },
          ),
        ).toBe(true);
        winner = await read(other);
      } finally {
        release.release();
      }
      await firing;
      expect(await read(other)).toEqual(winner);
      expect(h.dispatchCount()).toBe(1);
    },
    15_000,
  );
});
