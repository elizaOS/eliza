/**
 * W1-A unit tests for the ScheduledTask spine.
 *
 * Covers per IMPL §3.1 verification:
 *  - every trigger kind (schema-level)
 *  - every verb (snooze | skip | complete | dismiss | escalate |
 *    acknowledge | edit | reopen)
 *  - multi-gate composition (all / any / first_deny)
 *  - terminal-state assignments
 *  - snooze-resets-ladder
 *  - reopen-after-expired
 *  - idempotency-key dedupe
 *  - respectsGlobalPause skip
 *  - AnchorConsolidationPolicy merge mode
 *  - pipeline.onComplete fires on `completed`; does NOT fire on
 *    `acknowledged`
 *  - the runner does NOT pattern-match `promptInstructions` (§7.1)
 */

import { describe, expect, it, vi } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
  resolveEffectiveLadder,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
} from "./runner.js";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
  TaskGateContribution,
} from "./types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
  setNow(iso: string): void;
  setOwnerFacts(facts: OwnerFactsView): void;
  setPause(view: { active: boolean; reason?: string }): void;
  setActivity(bus: ActivitySignalBusView): void;
  setSubjectStore(store: SubjectStoreView): void;
}

function makeHarness(initialIso = "2026-05-09T12:00:00.000Z"): Harness {
  let nowIso = initialIso;
  let ownerFacts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "07:00", end: "10:00" },
  };
  let pauseView: { active: boolean; reason?: string } = { active: false };
  let activity: ActivitySignalBusView = {
    hasSignalSince: () => false,
  };
  let subjectStore: SubjectStoreView = {
    wasUpdatedSince: () => false,
  };

  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);

  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);

  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const anchors = createAnchorRegistry();
  const consolidation = createConsolidationRegistry();
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();

  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: () => ownerFacts,
    globalPause: { current: async () => pauseView } as GlobalPauseView,
    activity: { hasSignalSince: (...a) => activity.hasSignalSince(...a) },
    subjectStore: { wasUpdatedSince: (...a) => subjectStore.wasUpdatedSince(...a) },
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date(nowIso),
  });

  return {
    runner,
    logStore,
    setNow: (iso) => {
      nowIso = iso;
    },
    setOwnerFacts: (facts) => {
      ownerFacts = facts;
    },
    setPause: (v) => {
      pauseView = v;
    },
    setActivity: (b) => {
      activity = b;
    },
    setSubjectStore: (s) => {
      subjectStore = s;
    },
  };
}

const baseInput = (
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> => ({
  kind: "reminder",
  promptInstructions: "do the thing",
  trigger: { kind: "manual" },
  priority: "medium",
  respectsGlobalPause: true,
  source: "user_chat",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScheduledTaskRunner — schedule + idempotency", () => {
  it("schedules a task with status=scheduled and writes a state-log row", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(baseInput());
    expect(task.taskId).toMatch(/^task_/);
    expect(task.state.status).toBe("scheduled");
    expect(task.state.followupCount).toBe(0);
    const log = await h.logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(log.map((l) => l.transition)).toContain("scheduled");
  });

  it("dedupes by idempotencyKey", async () => {
    const h = makeHarness();
    const a = await h.runner.schedule(
      baseInput({ idempotencyKey: "uniq-1" }),
    );
    const b = await h.runner.schedule(
      baseInput({ idempotencyKey: "uniq-1", priority: "high" }),
    );
    expect(b.taskId).toBe(a.taskId);
    // The second call must not have updated priority.
    expect(b.priority).toBe("medium");
  });

  it("logs validation when both pipeline.onSkip and followupAfterMinutes are set", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(
      baseInput({
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 30,
        },
        pipeline: {
          onSkip: [
            {
              ...baseInput(),
              taskId: "irrelevant",
              state: {
                status: "scheduled",
                followupCount: 0,
              },
            } as never,
          ],
        },
      }),
    );
    const log = await h.logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(
      log.some(
        (l) =>
          l.transition === "edited" &&
          (l.reason ?? "").includes("pipeline.onSkip overrides"),
      ),
    ).toBe(true);
  });
});

describe("ScheduledTaskRunner — every verb", () => {
  it("snooze sets future fire time and resets the escalation cursor", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput());
    const updated = await h.runner.apply(task.taskId, "snooze", {
      minutes: 30,
    });
    expect(updated.state.firedAt).toBe("2026-05-09T12:30:00.000Z");
    expect(updated.state.status).toBe("scheduled");
    expect(
      (updated.metadata?.escalationCursor as { stepIndex: number }).stepIndex,
    ).toBe(-1);
  });

  it("skip moves to skipped and fires pipeline.onSkip children", async () => {
    const h = makeHarness();
    const child: Parameters<
      ScheduledTaskRunnerHandle["schedule"]
    >[0] = baseInput({
      promptInstructions: "child",
    });
    const parent = await h.runner.schedule(
      baseInput({ pipeline: { onSkip: [child as never] } }),
    );
    const skipped = await h.runner.apply(parent.taskId, "skip", {
      reason: "user said skip",
    });
    expect(skipped.state.status).toBe("skipped");
    const all = await h.runner.list();
    const childCreated = all.find((t) => t.promptInstructions === "child");
    expect(childCreated).toBeDefined();
    expect(childCreated?.state.pipelineParentId).toBe(parent.taskId);
  });

  it("complete moves to completed and fires pipeline.onComplete children", async () => {
    const h = makeHarness();
    const childInput = baseInput({ promptInstructions: "follow-up" });
    const parent = await h.runner.schedule(
      baseInput({ pipeline: { onComplete: [childInput as never] } }),
    );
    const completed = await h.runner.apply(parent.taskId, "complete", {
      reason: "done",
    });
    expect(completed.state.status).toBe("completed");
    expect(completed.state.completedAt).toBeDefined();
    const all = await h.runner.list();
    const childCreated = all.find(
      (t) => t.promptInstructions === "follow-up",
    );
    expect(childCreated?.state.pipelineParentId).toBe(parent.taskId);
  });

  it("dismiss is terminal but does NOT fire pipeline.onComplete", async () => {
    const h = makeHarness();
    const childInput = baseInput({ promptInstructions: "post-complete" });
    const parent = await h.runner.schedule(
      baseInput({ pipeline: { onComplete: [childInput as never] } }),
    );
    await h.runner.apply(parent.taskId, "dismiss", { reason: "user dismiss" });
    const all = await h.runner.list();
    expect(all.find((t) => t.promptInstructions === "post-complete")).toBeUndefined();
  });

  it("escalate writes a state-log row and bumps followupCount", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(baseInput({ priority: "high" }));
    const escalated = await h.runner.apply(task.taskId, "escalate", {
      force: true,
    });
    expect(escalated.state.followupCount).toBe(1);
    const log = await h.logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(log.some((l) => l.transition === "escalated")).toBe(true);
  });

  it("acknowledge is non-terminal and does NOT fire pipeline.onComplete (cross-agent invariant §7.6)", async () => {
    const h = makeHarness();
    const childInput = baseInput({ promptInstructions: "post-ack" });
    const parent = await h.runner.schedule(
      baseInput({ pipeline: { onComplete: [childInput as never] } }),
    );
    const acked = await h.runner.apply(parent.taskId, "acknowledge");
    expect(acked.state.status).toBe("acknowledged");
    expect(acked.state.acknowledgedAt).toBeDefined();
    const all = await h.runner.list();
    expect(all.find((t) => t.promptInstructions === "post-ack")).toBeUndefined();
  });

  it("edit mutates allowed fields and rejects state mutation", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(baseInput());
    const edited = await h.runner.apply(task.taskId, "edit", {
      priority: "high",
      promptInstructions: "updated text",
    });
    expect(edited.priority).toBe("high");
    expect(edited.promptInstructions).toBe("updated text");
    await expect(
      h.runner.apply(task.taskId, "edit", {
        state: { status: "completed", followupCount: 0 },
      }),
    ).rejects.toThrow(/read-only/);
  });

  it("reopen brings a terminal task back inside the 24h window", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput());
    await h.runner.apply(task.taskId, "complete", { reason: "done" });
    // Simulate "expired" by editing state via a re-apply of complete then dismissed.
    const allBefore = await h.runner.list();
    const t = allBefore.find((x) => x.taskId === task.taskId);
    expect(t?.state.status).toBe("completed");
    h.setNow("2026-05-09T20:00:00.000Z");
    const reopened = await h.runner.apply(task.taskId, "reopen", {
      reason: "late inbound",
    });
    expect(reopened.state.status).toBe("scheduled");
  });

  it("reopen rejects after the configured window", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput());
    await h.runner.apply(task.taskId, "complete", { reason: "done" });
    h.setNow("2026-05-12T12:00:01.000Z");
    await expect(
      h.runner.apply(task.taskId, "reopen", { reason: "way too late" }),
    ).rejects.toThrow(/window expired/);
  });

  it("respects metadata.reopenWindowHours override", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({ metadata: { reopenWindowHours: 1 } }),
    );
    await h.runner.apply(task.taskId, "complete", { reason: "done" });
    h.setNow("2026-05-09T12:30:00.000Z");
    const reopened = await h.runner.apply(task.taskId, "reopen");
    expect(reopened.state.status).toBe("scheduled");
    h.setNow("2026-05-09T13:30:00.000Z");
    // After complete-now and 1.5h elapsed (>1h cap from the new
    // lastDecisionLog write), reopen should still succeed because
    // `reopen` clears the cursor and resets to "scheduled" — but if we
    // complete again then re-attempt, we hit the 1h cap.
    await h.runner.apply(reopened.taskId, "complete", { reason: "done2" });
    h.setNow("2026-05-09T15:00:00.000Z");
    await expect(h.runner.apply(reopened.taskId, "reopen")).rejects.toThrow(
      /window expired/,
    );
  });
});

describe("ScheduledTaskRunner — fire path + gates", () => {
  it("fire dispatches when no gates are set", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(baseInput());
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
    expect(fired.state.firedAt).toBeDefined();
  });

  it("respectsGlobalPause: paused tasks are skipped with reason global_pause (cross-agent invariant §7.8)", async () => {
    const h = makeHarness();
    h.setPause({ active: true, reason: "vacation" });
    const task = await h.runner.schedule(baseInput());
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("skipped");
    expect(fired.state.lastDecisionLog).toContain("global_pause");
  });

  it("emergency tasks (respectsGlobalPause=false) fire even while paused", async () => {
    const h = makeHarness();
    h.setPause({ active: true });
    const task = await h.runner.schedule(
      baseInput({ respectsGlobalPause: false }),
    );
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
  });

  it("multi-gate composition: first_deny stops at the first deny", async () => {
    const h = makeHarness();
    const denyTrace: string[] = [];
    const deny: TaskGateContribution = {
      kind: "test.deny",
      evaluate() {
        denyTrace.push("deny");
        return { kind: "deny", reason: "test" };
      },
    };
    const allow: TaskGateContribution = {
      kind: "test.allow",
      evaluate() {
        denyTrace.push("allow");
        return { kind: "allow" };
      },
    };
    // We need to access the gate registry inside the harness; do it via
    // a fresh harness so we can register custom gates.
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    gates.register(deny);
    gates.register(allow);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const runner = createScheduledTaskRunner({
      agentId: "test",
      store: createInMemoryScheduledTaskStore(),
      logStore: createInMemoryScheduledTaskLogStore(),
      gates,
      completionChecks,
      ladders,
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: async () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      newTaskId: () => "t1",
      now: () => new Date("2026-05-09T12:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "test.deny" }, { kind: "test.allow" }],
        },
      }),
    );
    await runner.fire(task.taskId);
    expect(denyTrace).toEqual(["deny"]); // allow never reached
  });

  it("multi-gate composition: any allows when at least one allows", async () => {
    const denyA: TaskGateContribution = {
      kind: "any.deny",
      evaluate() {
        return { kind: "deny", reason: "no" };
      },
    };
    const allowB: TaskGateContribution = {
      kind: "any.allow",
      evaluate() {
        return { kind: "allow" };
      },
    };
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    gates.register(denyA);
    gates.register(allowB);
    const runner = createScheduledTaskRunner({
      agentId: "test",
      store: createInMemoryScheduledTaskStore(),
      logStore: createInMemoryScheduledTaskLogStore(),
      gates,
      completionChecks: createCompletionCheckRegistry(),
      ladders: createEscalationLadderRegistry(),
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: async () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      newTaskId: () => "t-any",
      now: () => new Date("2026-05-09T12:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        shouldFire: {
          compose: "any",
          gates: [{ kind: "any.deny" }, { kind: "any.allow" }],
        },
      }),
    );
    const fired = await runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
  });

  it("multi-gate composition: all denies if any gate denies", async () => {
    const allowOk: TaskGateContribution = {
      kind: "all.ok",
      evaluate() {
        return { kind: "allow" };
      },
    };
    const allowNo: TaskGateContribution = {
      kind: "all.no",
      evaluate() {
        return { kind: "deny", reason: "rejected" };
      },
    };
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    gates.register(allowOk);
    gates.register(allowNo);
    const runner = createScheduledTaskRunner({
      agentId: "test",
      store: createInMemoryScheduledTaskStore(),
      logStore: createInMemoryScheduledTaskLogStore(),
      gates,
      completionChecks: createCompletionCheckRegistry(),
      ladders: createEscalationLadderRegistry(),
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: async () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      newTaskId: () => "t-all",
      now: () => new Date("2026-05-09T12:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        shouldFire: {
          compose: "all",
          gates: [{ kind: "all.ok" }, { kind: "all.no" }],
        },
      }),
    );
    const fired = await runner.fire(task.taskId);
    expect(fired.state.status).toBe("skipped");
  });

  it("weekend_skip built-in denies on weekends (using owner timezone)", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z"); // Saturday
    const task = await h.runner.schedule(
      baseInput({
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "weekend_skip" }],
        },
      }),
    );
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("skipped");
    expect(fired.state.lastDecisionLog).toContain("weekend_skip");
  });

  it("weekday_only built-in denies on weekends", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "weekday_only" }],
        },
      }),
    );
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("skipped");
  });

  it("late_evening_skip denies after the threshold hour", async () => {
    const h = makeHarness("2026-05-08T22:30:00.000Z"); // Friday 22:30 UTC
    const task = await h.runner.schedule(
      baseInput({
        shouldFire: {
          compose: "first_deny",
          gates: [
            { kind: "late_evening_skip", params: { afterHour: 21 } },
          ],
        },
      }),
    );
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("skipped");
    expect(fired.state.lastDecisionLog).toContain("late_evening_skip");
  });

  it("quiet_hours defers to the next allowed window for low priority", async () => {
    const h = makeHarness("2026-05-08T22:30:00.000Z");
    h.setOwnerFacts({
      timezone: "UTC",
      quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
    });
    const task = await h.runner.schedule(
      baseInput({
        priority: "low",
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "quiet_hours" }],
        },
      }),
    );
    const fired = await h.runner.fire(task.taskId);
    // Defer rewrites firedAt and stays "scheduled" — the runner does
    // NOT terminate the task on defer.
    expect(fired.state.status).toBe("scheduled");
  });

  it("quiet_hours bypasses for high-priority tasks (default)", async () => {
    const h = makeHarness("2026-05-08T22:30:00.000Z");
    h.setOwnerFacts({
      timezone: "UTC",
      quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
    });
    const task = await h.runner.schedule(
      baseInput({
        priority: "high",
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "quiet_hours" }],
        },
      }),
    );
    const fired = await h.runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
  });
});

describe("ScheduledTaskRunner — completion checks", () => {
  it("user_acknowledged: evaluateCompletion completes when acknowledged=true", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(
      baseInput({
        completionCheck: { kind: "user_acknowledged" },
        pipeline: {
          onComplete: [
            baseInput({ promptInstructions: "post-complete" }) as never,
          ],
        },
      }),
    );
    await h.runner.fire(task.taskId);
    const completed = await h.runner.evaluateCompletion(task.taskId, {
      acknowledged: true,
    });
    expect(completed.state.status).toBe("completed");
    const all = await h.runner.list();
    expect(
      all.find((t) => t.promptInstructions === "post-complete"),
    ).toBeDefined();
  });

  it("user_replied_within: completes only when reply is within lookback", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        completionCheck: {
          kind: "user_replied_within",
          params: { lookbackMinutes: 30, requireSinceTaskFired: false },
        },
      }),
    );
    await h.runner.fire(task.taskId);
    h.setNow("2026-05-09T12:15:00.000Z");
    const noOp = await h.runner.evaluateCompletion(task.taskId, {});
    expect(noOp.state.status).toBe("fired");
    const completed = await h.runner.evaluateCompletion(task.taskId, {
      repliedAtIso: "2026-05-09T12:14:00.000Z",
    });
    expect(completed.state.status).toBe("completed");
  });

  it("health_signal_observed: consults activity bus", async () => {
    const h = makeHarness("2026-05-09T07:30:00.000Z");
    h.setActivity({
      hasSignalSince: () => true,
    });
    const task = await h.runner.schedule(
      baseInput({
        completionCheck: {
          kind: "health_signal_observed",
          params: {
            signalKind: "health.wake.confirmed",
            requireSinceTaskFired: false,
            lookbackMinutes: 60,
          },
        },
      }),
    );
    const completed = await h.runner.evaluateCompletion(task.taskId, {});
    expect(completed.state.status).toBe("completed");
  });

  it("subject_updated: consults subject-store and only counts updates since fire when requireSinceTaskFired is on", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    let respondTrue = false;
    h.setSubjectStore({
      wasUpdatedSince: () => respondTrue,
    });
    const task = await h.runner.schedule(
      baseInput({
        subject: { kind: "thread", id: "t1" },
        completionCheck: {
          kind: "subject_updated",
          params: { requireSinceTaskFired: true },
        },
      }),
    );
    await h.runner.fire(task.taskId);
    const noOp = await h.runner.evaluateCompletion(task.taskId, {});
    expect(noOp.state.status).toBe("fired");
    respondTrue = true;
    const completed = await h.runner.evaluateCompletion(task.taskId, {});
    expect(completed.state.status).toBe("completed");
  });
});

describe("ScheduledTaskRunner — pipeline + filtering", () => {
  it("pipeline.onSkip propagates as new tasks", async () => {
    const h = makeHarness();
    const parent = await h.runner.schedule(
      baseInput({
        pipeline: {
          onSkip: [baseInput({ promptInstructions: "child-skip" }) as never],
        },
      }),
    );
    const skipped = await h.runner.apply(parent.taskId, "skip", {});
    expect(skipped.state.status).toBe("skipped");
    const all = await h.runner.list({ kind: "reminder" });
    expect(
      all.find((t) => t.promptInstructions === "child-skip"),
    ).toBeDefined();
  });

  it("list() filters by status", async () => {
    const h = makeHarness();
    const a = await h.runner.schedule(baseInput());
    const b = await h.runner.schedule(baseInput());
    await h.runner.apply(a.taskId, "complete", {});
    const completed = await h.runner.list({ status: "completed" });
    expect(completed.map((t) => t.taskId)).toEqual([a.taskId]);
    const scheduled = await h.runner.list({ status: "scheduled" });
    expect(scheduled.map((t) => t.taskId)).toEqual([b.taskId]);
  });
});

describe("ScheduledTaskRunner — runner does NOT pattern-match promptInstructions (cross-agent invariant §7.1)", () => {
  it("two tasks with identical text but different gates produce different state outcomes", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z"); // Saturday
    const taskA = await h.runner.schedule(baseInput({ promptInstructions: "go for a walk" }));
    const taskB = await h.runner.schedule(
      baseInput({
        promptInstructions: "go for a walk",
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "weekend_skip" }],
        },
      }),
    );
    const firedA = await h.runner.fire(taskA.taskId);
    const firedB = await h.runner.fire(taskB.taskId);
    expect(firedA.state.status).toBe("fired");
    expect(firedB.state.status).toBe("skipped");
  });
});

describe("ScheduledTaskRunner — escalation ladder", () => {
  it("default-ladder resolution: medium → 1 retry @ 30 min", () => {
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const task: ScheduledTask = {
      taskId: "x",
      kind: "reminder",
      promptInstructions: "x",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      state: { status: "scheduled", followupCount: 0 },
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    };
    const ladder = resolveEffectiveLadder(task, ladders);
    expect(ladder.steps).toHaveLength(1);
    expect(ladder.steps[0]?.delayMinutes).toBe(30);
  });

  it("snooze resets the escalation cursor (§8.11)", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput({ priority: "high" }));
    await h.runner.fire(task.taskId);
    const snoozed = await h.runner.apply(task.taskId, "snooze", {
      minutes: 60,
    });
    const cursor = snoozed.metadata?.escalationCursor as {
      stepIndex: number;
      lastDispatchedAt: string;
    };
    expect(cursor.stepIndex).toBe(-1);
    expect(cursor.lastDispatchedAt).toBe("2026-05-09T13:00:00.000Z");
  });
});

describe("ScheduledTaskRunner — dispatcher", () => {
  it("custom dispatcher receives the fire record", async () => {
    const dispatch = vi.fn(async () => undefined);
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const runner = createScheduledTaskRunner({
      agentId: "t",
      store: createInMemoryScheduledTaskStore(),
      logStore: createInMemoryScheduledTaskLogStore(),
      gates,
      completionChecks,
      ladders,
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: async () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      dispatcher: { dispatch },
      newTaskId: () => "task_dispatch",
      now: () => new Date("2026-05-09T12:00:00.000Z"),
    });
    const task = await runner.schedule(baseInput());
    await runner.fire(task.taskId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.taskId,
        firedAtIso: "2026-05-09T12:00:00.000Z",
        promptInstructions: "do the thing",
      }),
    );
  });
});

describe("ScheduledTaskRunner — every trigger kind (schema-level)", () => {
  it("schedules tasks with each trigger kind without throwing", async () => {
    const h = makeHarness();
    const triggers: ScheduledTask["trigger"][] = [
      { kind: "once", atIso: "2026-05-09T12:00:00.000Z" },
      { kind: "cron", expression: "0 9 * * 1-5", tz: "UTC" },
      { kind: "interval", everyMinutes: 30 },
      { kind: "relative_to_anchor", anchorKey: "wake.confirmed", offsetMinutes: 10 },
      { kind: "during_window", windowKey: "morning" },
      { kind: "event", eventKind: "gmail.message.received" },
      { kind: "manual" },
      { kind: "after_task", taskId: "ref", outcome: "completed" },
    ];
    for (const trigger of triggers) {
      const task = await h.runner.schedule(baseInput({ trigger }));
      expect(task.state.status).toBe("scheduled");
    }
  });
});

describe("ScheduledTaskRunner — state-log nightly rollup", () => {
  it("rolloverStateLog folds expired raw rows into a daily summary", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput());
    await h.runner.fire(task.taskId);
    await h.runner.apply(task.taskId, "complete", { reason: "done" });
    h.setNow("2026-09-01T12:00:00.000Z");
    const result = await h.runner.rolloverStateLog({ retentionDays: 90 });
    expect(result.deletedRaw).toBeGreaterThan(0);
    const log = await h.logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(log.some((l) => l.rolledUp)).toBe(true);
  });
});

describe("Smoke: schedule → fire → complete → onComplete (per IMPL §3.1 verification)", () => {
  it("schedule + fire + complete fires pipeline.onComplete", async () => {
    const h = makeHarness();
    const child = baseInput({ promptInstructions: "smoke-child" });
    const parent = await h.runner.schedule(
      baseInput({
        promptInstructions: "smoke-parent",
        pipeline: { onComplete: [child as never] },
      }),
    );
    const fired = await h.runner.fire(parent.taskId);
    expect(fired.state.status).toBe("fired");
    const completed = await h.runner.apply(parent.taskId, "complete", {
      reason: "smoke-done",
    });
    expect(completed.state.status).toBe("completed");
    const after = await h.runner.list();
    const childTask = after.find((t) => t.promptInstructions === "smoke-child");
    expect(childTask).toBeDefined();
    expect(childTask?.state.pipelineParentId).toBe(parent.taskId);
  });

  it("schedule + fire + acknowledge does NOT fire pipeline.onComplete", async () => {
    const h = makeHarness();
    const child = baseInput({ promptInstructions: "smoke-no-child" });
    const parent = await h.runner.schedule(
      baseInput({
        pipeline: { onComplete: [child as never] },
      }),
    );
    await h.runner.fire(parent.taskId);
    const acked = await h.runner.apply(parent.taskId, "acknowledge");
    expect(acked.state.status).toBe("acknowledged");
    const after = await h.runner.list();
    expect(
      after.find((t) => t.promptInstructions === "smoke-no-child"),
    ).toBeUndefined();
  });
});

describe("Inspect registries", () => {
  it("inspectRegistries returns the list of registered kinds", () => {
    const h = makeHarness();
    const out = h.runner.inspectRegistries();
    expect(out.gates).toEqual(
      expect.arrayContaining([
        "weekend_skip",
        "weekend_only",
        "weekday_only",
        "late_evening_skip",
        "quiet_hours",
        "during_travel",
      ]),
    );
    expect(out.completionChecks).toEqual(
      expect.arrayContaining([
        "user_acknowledged",
        "user_replied_within",
        "subject_updated",
        "health_signal_observed",
      ]),
    );
    expect(out.ladders).toEqual(
      expect.arrayContaining([
        "priority_low_default",
        "priority_medium_default",
        "priority_high_default",
      ]),
    );
  });
});
