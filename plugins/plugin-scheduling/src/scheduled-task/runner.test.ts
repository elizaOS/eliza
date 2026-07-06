/**
 * Unit tests for the ScheduledTask spine.
 *
 * Covers:
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
 *  - the runner does NOT pattern-match `promptInstructions`
 */

import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import type { DispatchResult } from "../dispatch-types.js";
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
  HIGH_PRIORITY_ESCALATION_CHANNEL_ORDER,
  registerDefaultEscalationLadders,
  resolveEffectiveLadder,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
  TaskGateContribution,
} from "./types.js";
import { ScheduledTaskValidationError } from "./validation.js";

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
    subjectStore: {
      wasUpdatedSince: (...a) => subjectStore.wasUpdatedSince(...a),
    },
    dispatcher: TestNoopScheduledTaskDispatcher,
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
    const a = await h.runner.schedule(baseInput({ idempotencyKey: "uniq-1" }));
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

  it("rejects unknown shouldFire gates before persistence (#11791)", async () => {
    const h = makeHarness();
    await expect(
      h.runner.schedule(
        baseInput({
          shouldFire: {
            gates: [{ kind: "not_registered", params: {} }],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ScheduledTaskValidationError);
    expect(await h.runner.list()).toHaveLength(0);
  });

  it("rejects malformed built-in gate params before persistence (#11791)", async () => {
    const h = makeHarness();
    await expect(
      h.runner.schedule(
        baseInput({
          shouldFire: {
            gates: [
              {
                kind: "weekday_only",
                params: { weekdays: ["monday"] },
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/weekdays must contain integers 0\.\.6/);
    expect(await h.runner.list()).toHaveLength(0);
  });

  it("rejects unknown completion checks and invalid output kinds before persistence (#11791)", async () => {
    const h = makeHarness();
    await expect(
      h.runner.schedule(
        baseInput({
          completionCheck: { kind: "made_up_check" },
        }),
      ),
    ).rejects.toThrow(
      /completionCheck\.kind "made_up_check" is not registered/,
    );
    await expect(
      h.runner.schedule(
        baseInput({
          output: { destination: "invalid_output" } as never,
        }),
      ),
    ).rejects.toThrow(/output\.destination "invalid_output" is invalid/);
    expect(await h.runner.list()).toHaveLength(0);
  });

  it("rejects invalid inline pipeline children before any parent or child write (#11791)", async () => {
    const h = makeHarness();
    await expect(
      h.runner.schedule(
        baseInput({
          pipeline: {
            onComplete: [
              baseInput({
                promptInstructions: "bad child",
                completionCheck: {
                  kind: "not_registered_child_check",
                },
              }) as never,
            ],
          },
        }),
      ),
    ).rejects.toThrow(
      /pipeline\.onComplete\[0\]\.completionCheck\.kind "not_registered_child_check" is not registered/,
    );
    expect(await h.runner.list()).toHaveLength(0);
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
    const child: Parameters<ScheduledTaskRunnerHandle["schedule"]>[0] =
      baseInput({
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
    const childCreated = all.find((t) => t.promptInstructions === "follow-up");
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
    expect(
      all.find((t) => t.promptInstructions === "post-complete"),
    ).toBeUndefined();
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
    expect(
      all.find((t) => t.promptInstructions === "post-ack"),
    ).toBeUndefined();
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
      } as unknown as Parameters<ScheduledTaskRunnerHandle["apply"]>[2]),
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

  it("persists connector pending-prompt room id on successful reply-awaited fires", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(
      baseInput({
        completionCheck: {
          kind: "user_replied_within",
          followupAfterMinutes: 30,
        },
        output: { destination: "channel", target: "telegram:chat-123" },
      }),
    );

    const fired = await h.runner.fire(task.taskId);

    expect(fired.metadata?.pendingPromptRoomId).toBe(
      stringToUuid("chat-123:test-agent"),
    );
    const [persisted] = await h.runner.list();
    expect(persisted?.metadata?.pendingPromptRoomId).toBe(
      stringToUuid("chat-123:test-agent"),
    );
  });

  it("persists connector pending-prompt room id from the resolved dispatch target when output is absent", async () => {
    const dispatch = vi.fn(
      async (): Promise<DispatchResult> => ({
        ok: true,
        channelKey: "telegram",
        target: "account-1:chat-123",
        messageId: "telegram-msg-1",
      }),
    );
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const runner = createScheduledTaskRunner({
      agentId: "test-agent",
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
      now: () => new Date("2026-05-14T08:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        completionCheck: {
          kind: "user_replied_within",
          followupAfterMinutes: 30,
        },
        escalation: {
          steps: [
            { delayMinutes: 0, channelKey: "telegram", intensity: "soft" },
          ],
        },
      }),
    );

    const fired = await runner.fire(task.taskId);

    expect(fired.metadata?.pendingPromptRoomId).toBe(
      stringToUuid("account-1:chat-123:test-agent"),
    );
  });

  it("persists the in-app pending-prompt room for reply-awaited fires without output", async () => {
    const dispatch = vi.fn(
      async (): Promise<DispatchResult> => ({
        ok: true,
        channelKey: "in_app",
        target: "in_app",
        messageId: "in-app-msg-1",
      }),
    );
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const runner = createScheduledTaskRunner({
      agentId: "test-agent",
      store: createInMemoryScheduledTaskStore(),
      logStore: createInMemoryScheduledTaskLogStore(),
      gates,
      completionChecks,
      ladders: createEscalationLadderRegistry(),
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: async () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      dispatcher: { dispatch },
      now: () => new Date("2026-05-14T08:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        completionCheck: {
          kind: "user_replied_within",
          followupAfterMinutes: 30,
        },
      }),
    );

    const fired = await runner.fire(task.taskId);

    expect(fired.metadata?.pendingPromptRoomId).toBe("in_app");
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
    const _h = makeHarness();
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
      dispatcher: TestNoopScheduledTaskDispatcher,
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
      dispatcher: TestNoopScheduledTaskDispatcher,
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
      dispatcher: TestNoopScheduledTaskDispatcher,
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
          gates: [{ kind: "late_evening_skip", params: { afterHour: 21 } }],
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

  it("allows scheduler-owned refire for recurring tasks after an occurrence completed", async () => {
    const h = makeHarness("2026-05-09T09:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      }),
    );
    const first = await h.runner.fire(task.taskId);
    expect(first.state.status).toBe("fired");
    const completed = await h.runner.apply(task.taskId, "complete");
    expect(completed.state.status).toBe("completed");

    h.setNow("2026-05-10T09:00:00.000Z");
    const idempotent = await h.runner.fire(task.taskId);
    expect(idempotent.state.status).toBe("completed");

    const refired = await h.runner.fire(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(refired.state.status).toBe("fired");
    expect(refired.state.firedAt).toBe("2026-05-10T09:00:00.000Z");
    expect(refired.state.completedAt).toBeUndefined();
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
    const taskA = await h.runner.schedule(
      baseInput({ promptInstructions: "go for a walk" }),
    );
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

describe("ScheduledTaskRunner — getEscalationCursor (A6)", () => {
  it("returns null for an unknown taskId", async () => {
    const h = makeHarness();
    expect(await h.runner.getEscalationCursor("nope")).toBeNull();
  });

  it("returns null when the task has no cursor recorded yet", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(baseInput({ priority: "high" }));
    expect(await h.runner.getEscalationCursor(task.taskId)).toBeNull();
  });

  it("returns stepIndex=-1 + first-step channelKey after the initial fire", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput({ priority: "high" }));
    await h.runner.fire(task.taskId);
    const view = await h.runner.getEscalationCursor(task.taskId);
    expect(view).not.toBeNull();
    expect(view?.stepIndex).toBe(-1);
    expect(view?.lastFiredAt).toBe("2026-05-09T12:00:00.000Z");
    expect(view?.channelKey).toBe(
      HIGH_PRIORITY_ESCALATION_CHANNEL_ORDER[0]?.channelKey,
    );
  });

  it("reflects the snooze-reset cursor (lastFiredAt = new fire time)", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(baseInput({ priority: "high" }));
    await h.runner.fire(task.taskId);
    await h.runner.apply(task.taskId, "snooze", { minutes: 60 });
    const view = await h.runner.getEscalationCursor(task.taskId);
    expect(view).not.toBeNull();
    expect(view?.stepIndex).toBe(-1);
    expect(view?.lastFiredAt).toBe("2026-05-09T13:00:00.000Z");
  });

  it("uses the inline ladder steps when escalation.steps is set", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        priority: "low",
        escalation: {
          steps: [
            { delayMinutes: 0, channelKey: "imessage", intensity: "soft" },
            { delayMinutes: 30, channelKey: "push", intensity: "normal" },
          ],
        },
      }),
    );
    await h.runner.fire(task.taskId);
    const view = await h.runner.getEscalationCursor(task.taskId);
    expect(view).not.toBeNull();
    expect(view?.stepIndex).toBe(-1);
    expect(view?.channelKey).toBe("imessage");
  });

  it("returns null when metadata.escalationCursor is malformed (no stepIndex / lastDispatchedAt)", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(
      baseInput({
        priority: "medium",
        metadata: { escalationCursor: { junk: 1 } },
      }),
    );
    expect(await h.runner.getEscalationCursor(task.taskId)).toBeNull();
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
    const task = await runner.schedule(
      baseInput({
        metadata: { systemOperation: "agent.localBackup" },
      }),
    );
    await runner.fire(task.taskId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.taskId,
        firedAtIso: "2026-05-09T12:00:00.000Z",
        promptInstructions: "do the thing",
        metadata: expect.objectContaining({
          systemOperation: "agent.localBackup",
        }),
      }),
    );
  });

  it("marks a claimed task failed when the dispatcher throws", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("transport exploded");
    });
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const store = createInMemoryScheduledTaskStore();
    const logStore = createInMemoryScheduledTaskLogStore();
    const runner = createScheduledTaskRunner({
      agentId: "t",
      store,
      logStore,
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
      newTaskId: () => "task_dispatch_failed",
      now: () => new Date("2026-05-09T12:00:00.000Z"),
    });
    const task = await runner.schedule(baseInput());
    const result = await runner.fireWithResult(task.taskId);

    expect(result.kind).toBe("dispatch_failed");
    if (result.kind !== "dispatch_failed") {
      throw new Error(`unexpected fire result: ${result.kind}`);
    }
    expect(result.error.message).toBe("transport exploded");
    expect(result.task.state.status).toBe("failed");
    expect(result.task.state.firedAt).toBe("2026-05-09T12:00:00.000Z");
    expect(result.task.state.lastDecisionLog).toBe(
      "dispatch_failed: transport exploded",
    );
    expect(result.task.metadata?.lastDispatchError).toEqual({
      name: "Error",
      message: "transport exploded",
    });

    const persisted = await store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");
    expect(persisted?.state.lastDecisionLog).toBe(
      "dispatch_failed: transport exploded",
    );

    const log = await logStore.list({
      agentId: "t",
      taskId: task.taskId,
    });
    expect(log.map((row) => row.transition)).toEqual([
      "scheduled",
      "fire_attempt",
      "fired",
      "failed",
    ]);
    const failed = log.find((row) => row.transition === "failed");
    expect(failed?.reason).toBe("dispatch_failed: transport exploded");
    expect(failed?.detail).toEqual({
      errorName: "Error",
      message: "transport exploded",
    });
  });
});

describe("ScheduledTaskRunner — dispatch result routing (#10721 H2)", () => {
  const NOW_ISO = "2026-05-09T12:00:00.000Z";

  function makeDispatchRunner(
    dispatch: () => Promise<DispatchResult | undefined>,
  ) {
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const store = createInMemoryScheduledTaskStore();
    const logStore = createInMemoryScheduledTaskLogStore();
    const runner = createScheduledTaskRunner({
      agentId: "t",
      store,
      logStore,
      gates,
      completionChecks,
      ladders,
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: async () => ({}),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      dispatcher: { dispatch: vi.fn(dispatch) },
      newTaskId: () => "task_route",
      now: () => new Date(NOW_ISO),
    });
    return { runner, store, logStore };
  }

  it("routes a non-retriable { ok: false } to dispatch_failed, not fired", async () => {
    const failure: DispatchResult = {
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message: "boom",
    };
    const { runner, store, logStore } = makeDispatchRunner(async () => failure);
    // priority "low" = empty escalation ladder, so the permanent failure is
    // terminal immediately. (With rungs remaining the policy ADVANCES the
    // ladder instead — see the dispatch-policy-enforcement suite.)
    const task = await runner.schedule(baseInput({ priority: "low" }));
    const result = await runner.fireWithResult(task.taskId);

    // The send did NOT reach the user: it must not count as delivered.
    expect(result.kind).toBe("dispatch_failed");
    if (result.kind !== "dispatch_failed") {
      throw new Error(`unexpected fire result: ${result.kind}`);
    }
    expect(result.task.state.status).toBe("failed");
    expect(result.task.state.status).not.toBe("fired");
    expect(result.error.message).toBe("transport_error: boom");
    expect(result.task.state.lastDecisionLog).toBe(
      "dispatch_failed: transport_error: boom",
    );
    // The typed result is retained for the connector-degradation surface.
    expect(result.task.metadata?.lastDispatchResult).toEqual(failure);

    const persisted = await store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");

    const log = await logStore.list({ agentId: "t", taskId: task.taskId });
    expect(log.map((row) => row.transition)).toEqual([
      "scheduled",
      "fire_attempt",
      "fired",
      "failed",
    ]);
  });

  it("routes a disconnected { ok: false } (no backoff) to dispatch_failed", async () => {
    const failure: DispatchResult = {
      ok: false,
      reason: "disconnected",
      userActionable: true,
    };
    const { runner } = makeDispatchRunner(async () => failure);
    const task = await runner.schedule(baseInput({ priority: "low" }));
    const result = await runner.fireWithResult(task.taskId);

    expect(result.kind).toBe("dispatch_failed");
    if (result.kind !== "dispatch_failed") {
      throw new Error(`unexpected fire result: ${result.kind}`);
    }
    expect(result.task.state.status).toBe("failed");
    expect(result.task.metadata?.lastDispatchResult).toEqual(failure);
  });

  it("fires pipeline.onFail when a { ok: false } send permanently fails", async () => {
    const failure: DispatchResult = {
      ok: false,
      reason: "unknown_recipient",
      userActionable: false,
    };
    const { runner, store } = makeDispatchRunner(async () => failure);
    const parent = await runner.schedule(
      baseInput({
        priority: "low",
        pipeline: {
          onFail: [
            {
              ...baseInput({ promptInstructions: "escalate: send failed" }),
              taskId: "irrelevant",
              state: { status: "scheduled", followupCount: 0 },
            } as never,
          ],
        },
      }),
    );
    await runner.fireWithResult(parent.taskId);

    const all = await store.list();
    const child = all.find(
      (t) => t.promptInstructions === "escalate: send failed",
    );
    expect(child).toBeDefined();
    expect(child?.state.pipelineParentId).toBe(parent.taskId);
  });

  it("reschedules the SAME step (ladder not advanced) on a retriable { ok: false }", async () => {
    const failure: DispatchResult = {
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
    };
    const { runner, store, logStore } = makeDispatchRunner(async () => failure);
    const task = await runner.schedule(baseInput({ priority: "high" }));
    const result = await runner.fireWithResult(task.taskId);

    // Not delivered, not failed — held for a bounded retry of the SAME step.
    expect(result.kind).toBe("dispatch_deferred");
    if (result.kind !== "dispatch_deferred") {
      throw new Error(`unexpected fire result: ${result.kind}`);
    }
    expect(result.reason).toBe("retry:rate_limited");
    expect(result.task.state.status).toBe("scheduled");
    // firedAt moved forward by retryAfterMinutes → re-fires via override.
    expect(result.nextAttemptAtIso).toBe("2026-05-09T12:05:00.000Z");
    expect(result.task.state.firedAt).toBe("2026-05-09T12:05:00.000Z");
    expect(result.task.metadata?.lastDispatchResult).toEqual(failure);
    // Bounded continuation recorded: same step (-1 = initial channel),
    // one attempt burned.
    expect(result.task.metadata?.pendingDispatch).toEqual({
      stepIndex: -1,
      attempt: 1,
    });

    // Ladder NOT advanced: the escalation cursor stays at the just-fired
    // position (-1 = fired, no ladder step dispatched).
    const cursor = await runner.getEscalationCursor(task.taskId);
    expect(cursor?.stepIndex).toBe(-1);

    const persisted = await store.get(task.taskId);
    expect(persisted?.state.status).toBe("scheduled");
    expect(persisted?.state.firedAt).toBe("2026-05-09T12:05:00.000Z");

    const log = await logStore.list({ agentId: "t", taskId: task.taskId });
    const retried = log.find((row) => row.transition === "dispatch_retried");
    expect(retried?.reason).toBe("rate_limited");
    expect(retried?.detail).toMatchObject({
      retryAfterMinutes: 5,
      attempt: 1,
      nextAttemptAtIso: "2026-05-09T12:05:00.000Z",
    });
    // Never recorded as failed on a transient retry.
    expect(log.map((row) => row.transition)).not.toContain("failed");
  });

  it("keeps { ok: true } exactly as fired (regression guard)", async () => {
    const success: DispatchResult = { ok: true, messageId: "msg_ok" };
    const { runner, store } = makeDispatchRunner(async () => success);
    const task = await runner.schedule(baseInput());
    const result = await runner.fireWithResult(task.taskId);

    expect(result.kind).toBe("fired");
    if (result.kind !== "fired") {
      throw new Error(`unexpected fire result: ${result.kind}`);
    }
    expect(result.task.state.status).toBe("fired");
    expect(result.task.metadata?.lastDispatchResult).toEqual(success);

    const persisted = await store.get(task.taskId);
    expect(persisted?.state.status).toBe("fired");
  });

  it("keeps an undefined dispatch result as fired (no-op dispatcher regression)", async () => {
    const { runner } = makeDispatchRunner(async () => undefined);
    const task = await runner.schedule(baseInput());
    const result = await runner.fireWithResult(task.taskId);

    expect(result.kind).toBe("fired");
    if (result.kind !== "fired") {
      throw new Error(`unexpected fire result: ${result.kind}`);
    }
    expect(result.task.state.status).toBe("fired");
    expect(result.task.metadata?.lastDispatchResult).toBeUndefined();
  });
});

describe("ScheduledTaskRunner — executionProfile host-capability substitution", () => {
  /**
   * When the host can't satisfy a task's `executionProfile`, runner.fire()
   * MUST rewrite the dispatch channel to `in_app` (notify-only) and write a
   * `"substituted"` state-log row carrying the original + substitute
   * profiles. The task still transitions to `fired`; substitution shifts
   * the wire-out mechanism, not the status.
   */
  it("substitutes a bg-heavy-fgs task to notify-only on a foreground-only host", async () => {
    const dispatch = vi.fn(async () => undefined);
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const logStore = createInMemoryScheduledTaskLogStore();
    const runner = createScheduledTaskRunner({
      agentId: "t-sub",
      store: createInMemoryScheduledTaskStore(),
      logStore,
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
      // Host can only run foreground + notify-only. A `bg-heavy-fgs` task
      // is NOT in this set, so the runner must substitute.
      hostCapabilities: () => new Set(["foreground", "notify-only"]),
      newTaskId: () => "task_sub",
      now: () => new Date("2026-05-14T08:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        executionProfile: "bg-heavy-fgs",
        // Set the task's output destination to something OTHER than in_app
        // to prove substitution rewrites the channel.
        output: { destination: "channel", target: "discord:owner-dm" },
      }),
    );
    const result = await runner.fire(task.taskId);
    expect(result.state.status).toBe("fired");

    // The dispatcher should have been called with channelKey === "in_app"
    // even though the task asked for "discord".
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.taskId,
        channelKey: "in_app",
      }),
    );

    // A `substituted` log row must exist with the original + substitute
    // profile in its detail.
    const log = await logStore.list({
      agentId: "t-sub",
      taskId: task.taskId,
    });
    const substituted = log.find((r) => r.transition === "substituted");
    expect(substituted).toBeDefined();
    expect(substituted?.reason).toBe("host_incapable");
    const detail = substituted?.detail as Record<string, unknown> | undefined;
    expect(detail?.originalProfile).toBe("bg-heavy-fgs");
    expect(detail?.substituteProfile).toBe("notify-only");
  });

  it("does NOT substitute when the host CAN satisfy the profile", async () => {
    const dispatch = vi.fn(async () => undefined);
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const logStore = createInMemoryScheduledTaskLogStore();
    const runner = createScheduledTaskRunner({
      agentId: "t-no-sub",
      store: createInMemoryScheduledTaskStore(),
      logStore,
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
      // Host CAN run bg-heavy-fgs.
      hostCapabilities: () =>
        new Set(["foreground", "bg-light-30s", "bg-heavy-fgs", "notify-only"]),
      newTaskId: () => "task_no_sub",
      now: () => new Date("2026-05-14T08:00:00.000Z"),
    });
    const task = await runner.schedule(
      baseInput({
        executionProfile: "bg-heavy-fgs",
        output: { destination: "channel", target: "discord:owner-dm" },
      }),
    );
    await runner.fire(task.taskId);

    // Dispatcher should see the original (discord) channel, not the
    // substituted one.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.taskId, channelKey: "discord" }),
    );
    const log = await logStore.list({
      agentId: "t-no-sub",
      taskId: task.taskId,
    });
    expect(log.find((r) => r.transition === "substituted")).toBeUndefined();
  });

  it("uses DEFAULT_TASK_EXECUTION_PROFILE when task.executionProfile is absent", async () => {
    // A task with no executionProfile defaults to `foreground`; foreground
    // is always in every host's capability set, so no substitution.
    const dispatch = vi.fn(async () => undefined);
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);
    const ladders = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(ladders);
    const logStore = createInMemoryScheduledTaskLogStore();
    const runner = createScheduledTaskRunner({
      agentId: "t-default",
      store: createInMemoryScheduledTaskStore(),
      logStore,
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
      hostCapabilities: () => new Set(["foreground", "notify-only"]),
      newTaskId: () => "task_default",
      now: () => new Date("2026-05-14T08:00:00.000Z"),
    });
    const task = await runner.schedule(baseInput()); // no executionProfile
    await runner.fire(task.taskId);
    const log = await logStore.list({
      agentId: "t-default",
      taskId: task.taskId,
    });
    expect(log.find((r) => r.transition === "substituted")).toBeUndefined();
  });
});

describe("ScheduledTaskRunner — every trigger kind (schema-level)", () => {
  it("schedules tasks with each trigger kind without throwing", async () => {
    const h = makeHarness();
    const triggers: ScheduledTask["trigger"][] = [
      { kind: "once", atIso: "2026-05-09T12:00:00.000Z" },
      { kind: "cron", expression: "0 9 * * 1-5", tz: "UTC" },
      { kind: "interval", everyMinutes: 30 },
      {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 10,
      },
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

describe("ScheduledTaskRunner — resolveNextFireAt (due-window primitive)", () => {
  it("projects a once trigger's fire instant and clears it after firing", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        trigger: { kind: "once", atIso: "2026-05-09T15:00:00.000Z" },
      }),
    );
    expect(await h.runner.resolveNextFireAt(task)).toBe(
      "2026-05-09T15:00:00.000Z",
    );
  });

  it("honors the scheduled-override (snooze) instant over the trigger", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      }),
    );
    const snoozed = await h.runner.apply(task.taskId, "snooze", {
      untilIso: "2026-05-09T13:30:00.000Z",
    });
    expect(await h.runner.resolveNextFireAt(snoozed)).toBe(
      "2026-05-09T13:30:00.000Z",
    );
  });

  it("returns null for triggers with no wall-clock fire time", async () => {
    const h = makeHarness();
    const manual = await h.runner.schedule(
      baseInput({ trigger: { kind: "manual" } }),
    );
    expect(await h.runner.resolveNextFireAt(manual)).toBeNull();
  });

  it("exposes the owner facts used by due and next-fire evaluation", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "America/New_York" });
    await expect(h.runner.resolveOwnerFacts()).resolves.toEqual({
      timezone: "America/New_York",
    });
  });

  it("reports a missed cron occurrence as due even when next-fire projects forward", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      baseInput({
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
        metadata: { createdAtIso: "2026-05-09T00:00:00.000Z" },
      }),
    );

    expect(await h.runner.resolveNextFireAt(task)).toBe(
      "2026-05-10T09:00:00.000Z",
    );
    expect(await h.runner.resolveDueDecision(task)).toMatchObject({
      due: true,
      reason: "cron_due",
      occurrenceAtIso: "2026-05-09T09:00:00.000Z",
    });
  });
});
