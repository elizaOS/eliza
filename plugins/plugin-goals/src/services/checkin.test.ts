/**
 * Unit tests for the goals check-in engine (`GoalsCheckinService`).
 *
 * Covers, against a REAL spine runner (in-memory store, recording
 * dispatcher — the same primitives the production runner host builds):
 *  - cadence → trigger mapping for every LifeOpsCadence kind (crons carry
 *    the `owner_local` tz sentinel),
 *  - create-on-goal-sync with idempotency keys (no duplicates on re-sync),
 *  - cadence change → old slot dismissed, new slot scheduled,
 *  - goal close / delete → live slots dismissed,
 *  - owner-dismissed slots are never resurrected,
 *  - tick mechanics: the created cron task is due at the OWNER's local hour
 *    (America/Denver), not the UTC hour, and fires through the dispatcher.
 *
 * `recordCheckinResponse` needs the goals DB and is covered by
 * `checkin.harness.test.ts`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  isScheduledTaskDue,
  OWNER_LOCAL_TZ,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTaskRunnerHandle,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import type { LifeOpsGoalDefinition } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  buildCheckinTaskInput,
  checkinIdempotencyKey,
  checkinTriggersForGoal,
  GOAL_CHECKIN_CREATED_BY,
  GoalsCheckinService,
} from "./checkin.ts";

const AGENT_ID = "agent-1";
/** Monday 2026-06-08; Denver is on MDT (UTC-6), so 09:00 local = 15:00Z. */
const CREATED_ISO = "2026-06-08T00:30:00.000Z";
const DENVER_9AM_UTC_ISO = "2026-06-08T15:00:00.000Z";
const UTC_9AM_ISO = "2026-06-08T09:00:00.000Z";

function makeGoal(
  overrides: Partial<LifeOpsGoalDefinition> = {},
): LifeOpsGoalDefinition {
  return {
    id: "goal-1",
    agentId: AGENT_ID,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "owner-entity",
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    title: "Practice guitar",
    description: "Thirty minutes a day",
    cadence: { kind: "daily", windows: ["morning"] },
    supportStrategy: {},
    successCriteria: {},
    status: "active",
    reviewState: "idle",
    metadata: {},
    createdAt: CREATED_ISO,
    updatedAt: CREATED_ISO,
    ...overrides,
  };
}

interface Spine {
  runner: ScheduledTaskRunnerHandle;
  dispatched: string[];
  setNow(iso: string): void;
}

function makeSpine(initialIso = CREATED_ISO): Spine {
  let nowIso = initialIso;
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const dispatched: string[] = [];
  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: AGENT_ID,
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "America/Denver" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: {
      async dispatch(record) {
        dispatched.push(record.taskId);
        return { ok: true, messageId: `test:${record.taskId}` };
      },
    },
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date(nowIso),
  });
  return {
    runner,
    dispatched,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

function makeService(
  spine: Spine,
  clockIso = CREATED_ISO,
): GoalsCheckinService {
  const runtime = {
    agentId: AGENT_ID,
    hasService: (type: string) =>
      type === ScheduledTaskRunnerService.serviceType,
    getService: (type: string) =>
      type === ScheduledTaskRunnerService.serviceType
        ? { getRunner: () => spine.runner }
        : null,
  } as unknown as IAgentRuntime;
  return new GoalsCheckinService(runtime, () => new Date(clockIso));
}

describe("checkinTriggersForGoal — cadence → trigger mapping", () => {
  it("maps a daily cadence to one owner_local cron over its window hours", () => {
    const plans = checkinTriggersForGoal(
      makeGoal({ cadence: { kind: "daily", windows: ["morning", "evening"] } }),
    );
    expect(plans).toEqual([
      {
        slotKey: "daily",
        trigger: {
          kind: "cron",
          expression: "0 9,18 * * *",
          tz: OWNER_LOCAL_TZ,
        },
      },
    ]);
  });

  it("maps a weekly cadence to an owner_local cron over weekdays", () => {
    const plans = checkinTriggersForGoal(
      makeGoal({
        cadence: { kind: "weekly", weekdays: [3, 1], windows: ["morning"] },
      }),
    );
    expect(plans).toEqual([
      {
        slotKey: "weekly",
        trigger: {
          kind: "cron",
          expression: "0 9 * * 1,3",
          tz: OWNER_LOCAL_TZ,
        },
      },
    ]);
  });

  it("maps an interval cadence to an interval trigger", () => {
    const plans = checkinTriggersForGoal(
      makeGoal({
        cadence: { kind: "interval", everyMinutes: 120, windows: ["morning"] },
      }),
    );
    expect(plans).toEqual([
      { slotKey: "interval", trigger: { kind: "interval", everyMinutes: 120 } },
    ]);
  });

  it("maps a once cadence to a once trigger at dueAt", () => {
    const plans = checkinTriggersForGoal(
      makeGoal({ cadence: { kind: "once", dueAt: DENVER_9AM_UTC_ISO } }),
    );
    expect(plans).toEqual([
      { slotKey: "once", trigger: { kind: "once", atIso: DENVER_9AM_UTC_ISO } },
    ]);
  });

  it("maps times_per_day slots to one owner_local cron per slot", () => {
    const plans = checkinTriggersForGoal(
      makeGoal({
        cadence: {
          kind: "times_per_day",
          slots: [
            {
              key: "noon",
              label: "Noon",
              minuteOfDay: 750,
              durationMinutes: 15,
            },
            { key: "pm", label: "PM", minuteOfDay: 1200, durationMinutes: 15 },
          ],
        },
      }),
    );
    expect(plans).toEqual([
      {
        slotKey: "slot-noon",
        trigger: {
          kind: "cron",
          expression: "30 12 * * *",
          tz: OWNER_LOCAL_TZ,
        },
      },
      {
        slotKey: "slot-pm",
        trigger: { kind: "cron", expression: "0 20 * * *", tz: OWNER_LOCAL_TZ },
      },
    ]);
  });

  it("schedules nothing for a cadence-less goal", () => {
    expect(checkinTriggersForGoal(makeGoal({ cadence: null }))).toEqual([]);
  });

  it("schedules nothing for an unknown cadence kind or empty windows", () => {
    expect(
      checkinTriggersForGoal(makeGoal({ cadence: { kind: "lunar" } })),
    ).toEqual([]);
    expect(
      checkinTriggersForGoal(
        makeGoal({ cadence: { kind: "daily", windows: [] } }),
      ),
    ).toEqual([]);
  });
});

describe("GoalsCheckinService.syncGoalCheckins", () => {
  it("creates a check-in ScheduledTask on the spine when a cadenced goal is synced", async () => {
    const spine = makeSpine();
    const service = makeService(spine);
    const goal = makeGoal();

    const result = await service.syncGoalCheckins(goal);

    expect(result.scheduled).toHaveLength(1);
    const [task] = await spine.runner.list({ kind: "checkin" });
    expect(task.idempotencyKey).toBe(checkinIdempotencyKey(goal.id, "daily"));
    expect(task.createdBy).toBe(GOAL_CHECKIN_CREATED_BY);
    expect(task.metadata?.goalId).toBe(goal.id);
    expect(task.trigger).toEqual({
      kind: "cron",
      expression: "0 9 * * *",
      tz: OWNER_LOCAL_TZ,
    });
    expect(task.state.status).toBe("scheduled");
  });

  it("is idempotent: re-syncing the same goal creates no duplicate task", async () => {
    const spine = makeSpine();
    const service = makeService(spine);
    const goal = makeGoal();

    await service.syncGoalCheckins(goal);
    const second = await service.syncGoalCheckins(goal);

    expect(second.scheduled).toHaveLength(0);
    expect(second.dismissedTaskIds).toHaveLength(0);
    expect(await spine.runner.list({ kind: "checkin" })).toHaveLength(1);
  });

  it("dismisses the old slot and schedules the new one on cadence change", async () => {
    const spine = makeSpine();
    const service = makeService(spine);
    const goal = makeGoal();

    await service.syncGoalCheckins(goal);
    const changed = await service.syncGoalCheckins(
      makeGoal({
        cadence: { kind: "weekly", weekdays: [1], windows: ["evening"] },
      }),
    );

    expect(changed.dismissedTaskIds).toHaveLength(1);
    expect(changed.scheduled).toHaveLength(1);
    const tasks = await spine.runner.list({ kind: "checkin" });
    const byKey = new Map(tasks.map((t) => [t.idempotencyKey, t]));
    expect(
      byKey.get(checkinIdempotencyKey(goal.id, "daily"))?.state.status,
    ).toBe("dismissed");
    expect(
      byKey.get(checkinIdempotencyKey(goal.id, "weekly"))?.state.status,
    ).toBe("scheduled");
  });

  it("edits the trigger in place when the cadence hours change within a slot", async () => {
    const spine = makeSpine();
    const service = makeService(spine);

    await service.syncGoalCheckins(makeGoal());
    const changed = await service.syncGoalCheckins(
      makeGoal({ cadence: { kind: "daily", windows: ["evening"] } }),
    );

    expect(changed.edited).toHaveLength(1);
    expect(changed.scheduled).toHaveLength(0);
    expect(changed.dismissedTaskIds).toHaveLength(0);
    const [task] = await spine.runner.list({ kind: "checkin" });
    expect(task.trigger).toEqual({
      kind: "cron",
      expression: "0 18 * * *",
      tz: OWNER_LOCAL_TZ,
    });
  });

  it("dismisses live slots when the goal leaves active status", async () => {
    const spine = makeSpine();
    const service = makeService(spine);

    await service.syncGoalCheckins(makeGoal());
    const closed = await service.syncGoalCheckins(
      makeGoal({ status: "archived" }),
    );

    expect(closed.dismissedTaskIds).toHaveLength(1);
    const [task] = await spine.runner.list({ kind: "checkin" });
    expect(task.state.status).toBe("dismissed");
  });

  it("never resurrects a slot the owner dismissed", async () => {
    const spine = makeSpine();
    const service = makeService(spine);
    const goal = makeGoal();

    const first = await service.syncGoalCheckins(goal);
    await spine.runner.apply(first.scheduled[0].taskId, "dismiss", {
      reason: "owner said stop",
    });
    const resync = await service.syncGoalCheckins(goal);

    expect(resync.scheduled).toHaveLength(0);
    expect(resync.edited).toHaveLength(0);
    const [task] = await spine.runner.list({ kind: "checkin" });
    expect(task.state.status).toBe("dismissed");
  });
});

describe("GoalsCheckinService.removeGoalCheckins", () => {
  it("dismisses all live check-in tasks for a deleted goal", async () => {
    const spine = makeSpine();
    const service = makeService(spine);
    const goal = makeGoal();

    await service.syncGoalCheckins(goal);
    const removed = await service.removeGoalCheckins(goal.id);

    expect(removed.dismissedTaskIds).toHaveLength(1);
    const [task] = await spine.runner.list({ kind: "checkin" });
    expect(task.state.status).toBe("dismissed");
  });
});

describe("goal check-in tick mechanics", () => {
  it("is due at the owner's local hour (Denver 09:00 = 15:00Z), not the UTC hour, and fires through the dispatcher", async () => {
    const spine = makeSpine();
    const service = makeService(spine);
    const goal = makeGoal();

    const { scheduled } = await service.syncGoalCheckins(goal);
    const task = scheduled[0];
    const ownerFacts = { timezone: "America/Denver" };

    const atUtc9 = await isScheduledTaskDue(task, {
      now: new Date(UTC_9AM_ISO),
      ownerFacts,
    });
    expect(atUtc9.due).toBe(false);

    const atDenver9 = await isScheduledTaskDue(task, {
      now: new Date(DENVER_9AM_UTC_ISO),
      ownerFacts,
    });
    expect(atDenver9.due).toBe(true);
    expect(atDenver9.occurrenceAtIso).toBe(DENVER_9AM_UTC_ISO);

    spine.setNow(DENVER_9AM_UTC_ISO);
    const fired = await spine.runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
    expect(spine.dispatched).toEqual([task.taskId]);
  });

  it("buildCheckinTaskInput anchors the cron base to slot creation via metadata.createdAtIso", () => {
    const goal = makeGoal();
    const [plan] = checkinTriggersForGoal(goal);
    const input = buildCheckinTaskInput(goal, plan, CREATED_ISO);
    expect(input.metadata?.createdAtIso).toBe(CREATED_ISO);
    expect(input.kind).toBe("checkin");
    expect(input.respectsGlobalPause).toBe(true);
    expect(input.source).toBe("plugin");
  });
});
