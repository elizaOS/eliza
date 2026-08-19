/**
 * Dispatch-policy overflow guard tests (#22136).
 *
 * Regression harness for the strand: `applyDispatchPolicy` (retry and
 * advance/surface_degraded branches) and `escalation.nextEscalationStep`
 * project the next-attempt instant with
 * `new Date(Date.parse(fireAtIso) + minutes * 60_000).toISOString()`.
 * `escalation.steps[].delayMinutes` (and connector-supplied
 * `retryAfterMinutes`) are schema-valid but unbounded, so a large value made
 * the ms product exceed the representable `Date` range and `toISOString()`
 * threw `RangeError: Invalid time value` — AFTER the row was atomically
 * claimed to `"fired"` but BEFORE it was parked back / settled, stranding the
 * task as `"fired"` with `next_fire_at` cleared (silently lost, never
 * retried).
 *
 * These tests drive the REAL runner with an in-memory store and assert the
 * claimed row settles terminally (`failed` + `pipeline.onFail`) instead of
 * throwing, and that normal offsets still park back to `dispatch_deferred`
 * with a valid `nextAttemptAtIso`.
 */

import { describe, expect, it } from "vitest";

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
  nextEscalationStep,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "./runner.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import type { ScheduledTask } from "./types.js";

/** Minutes whose ms product (× 60_000) exceeds the JS Date range. */
const OVERFLOW_MINUTES = 1_000_000_000_000;

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
  store: ScheduledTaskStore;
  queueDispatchResults(...results: Array<DispatchResult | undefined>): void;
}

function makeHarness(initialIso = "2026-05-11T12:00:00.000Z"): Harness {
  const queued: Array<DispatchResult | undefined> = [];
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const runner = createScheduledTaskRunner({
    agentId: "agent-overflow",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: {
      async dispatch() {
        return queued.length > 0 ? queued.shift() : { ok: true };
      },
    },
    channelKeys: () => new Set(["in_app", "telegram", "sms", "push"]),
    now: () => new Date(initialIso),
  });

  return {
    runner,
    logStore,
    store,
    queueDispatchResults(...results) {
      queued.push(...results);
    },
  };
}

function reminderInput(
  overrides?: Partial<Omit<ScheduledTask, "taskId" | "state">>,
): Omit<ScheduledTask, "taskId" | "state"> {
  return {
    kind: "reminder",
    promptInstructions: "take your medication",
    trigger: { kind: "once", atIso: "2026-05-11T12:00:00.000Z" },
    priority: "low",
    respectsGlobalPause: false,
    ownerVisible: true,
    source: "user_chat",
    createdBy: "agent-overflow",
    ...overrides,
  };
}

async function transitions(h: Harness, taskId: string): Promise<string[]> {
  const rows = await h.logStore.list({ agentId: "agent-overflow", taskId });
  return rows.map((r) => r.transition);
}

describe("dispatch-policy overflow guard (#22136)", () => {
  it("advance branch: overflowing delayMinutes settles failed + onFail instead of stranding fired", async () => {
    const h = makeHarness();
    const onFailChild: ScheduledTask = {
      taskId: "st_overflow_onfail",
      state: { status: "scheduled", followupCount: 0 },
      ...reminderInput({
        promptInstructions: "notify owner the reminder could not be delivered",
        trigger: { kind: "manual" },
      }),
    };
    const task = await h.runner.schedule(
      reminderInput({
        escalation: {
          steps: [
            { delayMinutes: OVERFLOW_MINUTES, channelKey: "telegram" },
            { delayMinutes: 5, channelKey: "sms" },
          ],
        },
        pipeline: { onFail: [onFailChild] },
      }),
    );
    // Permanent, non-actionable, non-last-step failure → ladder-advance branch,
    // which projects the next attempt at the overflowing telegram delay.
    h.queueDispatchResults({
      ok: false,
      reason: "transport_error",
      userActionable: false,
    });

    // The claim persisted the row as "fired" before the policy runs; the fix
    // must NOT let the park-back throw and strand it there.
    let threw: unknown;
    const result = await h.runner
      .fireWithResult(task.taskId)
      .catch((error: unknown) => {
        threw = error;
        return undefined;
      });
    expect(threw).toBeUndefined();
    expect(result?.kind).toBe("dispatch_failed");

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");
    expect(persisted?.state.status).not.toBe("fired");
    expect(persisted?.metadata?.pendingDispatch).toBeUndefined();
    expect(await transitions(h, task.taskId)).toContain("failed");

    const children = (await h.store.list()).filter(
      (t) => t.state.pipelineParentId === task.taskId,
    );
    expect(children).toHaveLength(1);
  });

  it("retry branch: overflowing connector retryAfterMinutes settles failed instead of throwing", async () => {
    const h = makeHarness();
    const onFailChild: ScheduledTask = {
      taskId: "st_overflow_retry_onfail",
      state: { status: "scheduled", followupCount: 0 },
      ...reminderInput({ trigger: { kind: "manual" } }),
    };
    const task = await h.runner.schedule(
      reminderInput({ pipeline: { onFail: [onFailChild] } }),
    );
    h.queueDispatchResults({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: OVERFLOW_MINUTES,
      userActionable: false,
    });

    let threw: unknown;
    const result = await h.runner
      .fireWithResult(task.taskId)
      .catch((error: unknown) => {
        threw = error;
        return undefined;
      });
    expect(threw).toBeUndefined();
    expect(result?.kind).toBe("dispatch_failed");

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");
    expect(persisted?.metadata?.pendingDispatch).toBeUndefined();
    expect(await transitions(h, task.taskId)).toContain("failed");
    const children = (await h.store.list()).filter(
      (t) => t.state.pipelineParentId === task.taskId,
    );
    expect(children).toHaveLength(1);
  });

  it("regression: a normal delayMinutes still parks back to dispatch_deferred with a valid nextAttemptAtIso", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(
      reminderInput({
        escalation: {
          steps: [{ delayMinutes: 15, channelKey: "telegram" }],
        },
      }),
    );
    h.queueDispatchResults({
      ok: false,
      reason: "transport_error",
      userActionable: false,
    });

    const result = await h.runner.fireWithResult(task.taskId);
    expect(result.kind).toBe("dispatch_deferred");
    if (result.kind !== "dispatch_deferred") throw new Error("unreachable");
    expect(result.nextAttemptAtIso).toBe("2026-05-11T12:15:00.000Z");
    expect(() => new Date(result.nextAttemptAtIso).toISOString()).not.toThrow();

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("scheduled");
    expect(persisted?.state.firedAt).toBe("2026-05-11T12:15:00.000Z");
  });

  it("nextEscalationStep returns null when the projected fire instant overflows the Date range", () => {
    const ladder = {
      ladderKey: "overflow",
      steps: [{ delayMinutes: OVERFLOW_MINUTES, channelKey: "telegram" }],
    };
    const step = nextEscalationStep(ladder, {
      stepIndex: -1,
      lastDispatchedAt: "2026-05-11T12:00:00.000Z",
    });
    expect(step).toBeNull();

    // A representable delay still resolves normally.
    const ok = nextEscalationStep(
      { ladderKey: "ok", steps: [{ delayMinutes: 30, channelKey: "in_app" }] },
      { stepIndex: -1, lastDispatchedAt: "2026-05-11T12:00:00.000Z" },
    );
    expect(ok?.fireAtIso).toBe("2026-05-11T12:30:00.000Z");
  });

  it("rejects invalid registered-ladder delays instead of parking in the past", () => {
    const cursor = {
      stepIndex: -1,
      lastDispatchedAt: "2026-05-11T12:00:00.000Z",
    };
    for (const delayMinutes of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        nextEscalationStep(
          {
            ladderKey: "invalid-contributor-ladder",
            steps: [{ delayMinutes, channelKey: "in_app" }],
          },
          cursor,
        ),
      ).toBeNull();
    }
  });

  it("settles an overflowing concurrent claim once and spawns onFail once", async () => {
    const h = makeHarness();
    const onFailChild: ScheduledTask = {
      taskId: "st_overflow_concurrent_onfail",
      state: { status: "scheduled", followupCount: 0 },
      ...reminderInput({ trigger: { kind: "manual" } }),
    };
    const task = await h.runner.schedule(
      reminderInput({ pipeline: { onFail: [onFailChild] } }),
    );
    h.queueDispatchResults({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: OVERFLOW_MINUTES,
      userActionable: false,
    });

    const results = await Promise.all([
      h.runner.fireWithResult(task.taskId),
      h.runner.fireWithResult(task.taskId),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "dispatch_failed",
      "raced",
    ]);
    const children = (await h.store.list()).filter(
      (candidate) => candidate.state.pipelineParentId === task.taskId,
    );
    expect(children).toHaveLength(1);
  });
});
