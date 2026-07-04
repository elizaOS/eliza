/**
 * Dispatch-policy enforcement tests (#10721 H2).
 *
 * Before the fix, a typed connector `DispatchResult { ok: false }` was
 * stashed in `metadata.lastDispatchResult` and the fire still reported
 * `"fired"`: the user silently never received the message and
 * `decideDispatchPolicy` (retry / backoff / ladder-advance / fail-loud)
 * was dead code. These tests drive the REAL runner with a scripted
 * dispatcher and assert the policy is enforced end to end:
 *
 *  - retry with backoff on `rate_limited` (same step, bounded attempts)
 *  - ladder advance across channels on permanent failures
 *  - `surface_degraded` records `metadata.connectorDegradation`
 *  - terminal `failed` + `pipeline.onFail` when the ladder is exhausted
 *  - the parked retry row is indexed AND due at the retry time
 *  - success and snooze clear the retry continuation
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
import { isScheduledTaskDue } from "./due.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskDispatchRecord,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
  type ScheduledTaskUpsertOptions,
} from "./runner.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import type { ScheduledTask } from "./types.js";

interface ScriptedDispatch {
  record: ScheduledTaskDispatchRecord;
  result: DispatchResult | undefined;
}

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
  store: ScheduledTaskStore;
  dispatches: ScriptedDispatch[];
  upserts: Array<{ taskId: string; nextFireAtIso: string | null }>;
  /** Queue the result(s) the dispatcher returns, in call order. */
  queueDispatchResults(...results: Array<DispatchResult | undefined>): void;
  setNow(iso: string): void;
  nowIso(): string;
}

function makeHarness(initialIso = "2026-05-11T12:00:00.000Z"): Harness {
  let nowIso = initialIso;
  const queued: Array<DispatchResult | undefined> = [];
  const dispatches: ScriptedDispatch[] = [];
  const upserts: Array<{ taskId: string; nextFireAtIso: string | null }> = [];

  const inner = createInMemoryScheduledTaskStore();
  const store: ScheduledTaskStore = {
    ...inner,
    async upsert(task: ScheduledTask, options?: ScheduledTaskUpsertOptions) {
      upserts.push({
        taskId: task.taskId,
        nextFireAtIso: options?.nextFireAtIso ?? null,
      });
      return inner.upsert(task, options);
    },
  };

  const logStore = createInMemoryScheduledTaskLogStore();
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const runner = createScheduledTaskRunner({
    agentId: "agent-dispatch-policy",
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
      async dispatch(record) {
        const result: DispatchResult | undefined =
          queued.length > 0 ? queued.shift() : { ok: true };
        dispatches.push({ record, result });
        return result;
      },
    },
    channelKeys: () => new Set(["in_app", "push", "imessage"]),
    now: () => new Date(nowIso),
  });

  return {
    runner,
    logStore,
    store,
    dispatches,
    upserts,
    queueDispatchResults(...results) {
      queued.push(...results);
    },
    setNow(iso) {
      nowIso = iso;
    },
    nowIso: () => nowIso,
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
    createdBy: "agent-dispatch-policy",
    ...overrides,
  };
}

async function transitions(h: Harness, taskId: string): Promise<string[]> {
  const rows = await h.logStore.list({
    agentId: "agent-dispatch-policy",
    taskId,
  });
  return rows.map((r) => r.transition);
}

describe("dispatch-policy enforcement (typed DispatchResult failures)", () => {
  it("terminal fail: ok:false with no ladder marks failed and fires pipeline.onFail", async () => {
    const h = makeHarness();
    // A fully-shaped ScheduledTask ref; `runPipeline` strips the
    // server-managed fields and re-runs `schedule()` to mint the child.
    const onFailChild: ScheduledTask = {
      taskId: "st_onfail_template",
      state: { status: "scheduled", followupCount: 0 },
      ...reminderInput({
        promptInstructions: "notify owner the reminder could not be delivered",
        trigger: { kind: "manual" },
      }),
    };
    const task = await h.runner.schedule(
      reminderInput({
        pipeline: { onFail: [onFailChild] },
      }),
    );
    h.queueDispatchResults({
      ok: false,
      reason: "unknown_recipient",
      userActionable: false,
    });

    const result = await h.runner.fireWithResult(task.taskId);
    expect(result.kind).toBe("dispatch_failed");

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");
    expect(persisted?.metadata?.pendingDispatch).toBeUndefined();
    expect(await transitions(h, task.taskId)).toContain("failed");

    // pipeline.onFail spawned the child
    const children = (await h.store.list()).filter(
      (t) => t.state.pipelineParentId === task.taskId,
    );
    expect(children).toHaveLength(1);
  });

  it("rate_limited retries the same step with backoff and stays out of 'fired'", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(reminderInput());
    h.queueDispatchResults({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 10,
      userActionable: false,
    });

    const result = await h.runner.fireWithResult(task.taskId);
    expect(result.kind).toBe("dispatch_deferred");
    if (result.kind !== "dispatch_deferred") throw new Error("unreachable");
    expect(result.nextAttemptAtIso).toBe("2026-05-11T12:10:00.000Z");

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("scheduled");
    expect(persisted?.state.firedAt).toBe("2026-05-11T12:10:00.000Z");
    expect(persisted?.metadata?.pendingDispatch).toEqual({
      stepIndex: -1,
      attempt: 1,
    });
    expect(await transitions(h, task.taskId)).toContain("dispatch_retried");

    // The parked row is INDEXED at the retry time (scheduled-override)…
    const lastUpsert = h.upserts[h.upserts.length - 1];
    expect(lastUpsert?.nextFireAtIso).toBe("2026-05-11T12:10:00.000Z");

    // …and the due evaluation agrees: not due before, due at the retry time.
    if (!persisted) throw new Error("task missing");
    const before = await isScheduledTaskDue(persisted, {
      now: new Date("2026-05-11T12:05:00.000Z"),
    });
    expect(before.due).toBe(false);
    const at = await isScheduledTaskDue(persisted, {
      now: new Date("2026-05-11T12:10:00.000Z"),
    });
    expect(at.due).toBe(true);
    expect(at.reason).toBe("scheduled_override_due");
  });

  it("retry then success delivers and clears the continuation", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(reminderInput());
    h.queueDispatchResults(
      {
        ok: false,
        reason: "rate_limited",
        retryAfterMinutes: 5,
        userActionable: false,
      },
      { ok: true, messageId: "msg-42" },
    );

    const first = await h.runner.fireWithResult(task.taskId);
    expect(first.kind).toBe("dispatch_deferred");

    h.setNow("2026-05-11T12:05:00.000Z");
    const second = await h.runner.fireWithResult(task.taskId);
    expect(second.kind).toBe("fired");

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.metadata?.pendingDispatch).toBeUndefined();
    expect(persisted?.metadata?.lastDispatchResult).toEqual({
      ok: true,
      messageId: "msg-42",
    });
    expect(h.dispatches).toHaveLength(2);
  });

  it("retry budget is bounded: rate_limited forever fails after max retries on a ladderless task", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(reminderInput());
    const rateLimited: DispatchResult = {
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 1,
      userActionable: false,
    };
    // initial + 3 retries all rate-limited
    h.queueDispatchResults(rateLimited, rateLimited, rateLimited, rateLimited);

    let result = await h.runner.fireWithResult(task.taskId);
    for (let i = 0; i < 3; i++) {
      expect(result.kind).toBe("dispatch_deferred");
      const parked = await h.store.get(task.taskId);
      h.setNow(parked?.state.firedAt ?? h.nowIso());
      result = await h.runner.fireWithResult(task.taskId);
    }
    // 4th attempt: budget exhausted, no ladder step to advance to → failed.
    expect(result.kind).toBe("dispatch_failed");
    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");
    expect(h.dispatches).toHaveLength(4);
  });

  it("permanent failure walks the high-priority ladder across channels then fails", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(
      reminderInput({
        priority: "high", // 3-step default ladder: in_app → push → imessage
      }),
    );
    const transportError: DispatchResult = {
      ok: false,
      reason: "transport_error",
      userActionable: false,
    };
    h.queueDispatchResults(
      transportError, // initial attempt (default channel)
      transportError, // ladder step 0: in_app (+0m)
      transportError, // ladder step 1: push (+15m)
      transportError, // ladder step 2: imessage (+45m)
    );

    let result = await h.runner.fireWithResult(task.taskId);
    const attempts: string[] = [h.dispatches[0]?.record.channelKey ?? ""];
    while (result.kind === "dispatch_deferred") {
      const parked = await h.store.get(task.taskId);
      h.setNow(parked?.state.firedAt ?? h.nowIso());
      result = await h.runner.fireWithResult(task.taskId);
      attempts.push(
        h.dispatches[h.dispatches.length - 1]?.record.channelKey ?? "",
      );
    }

    expect(attempts).toEqual(["in_app", "in_app", "push", "imessage"]);
    expect(result.kind).toBe("dispatch_failed");
    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("failed");

    // Ladder delays honored: step 1 at +15m, step 2 at +45m after its
    // predecessor's attempt instant.
    const escalatedRows = (
      await h.logStore.list({
        agentId: "agent-dispatch-policy",
        taskId: task.taskId,
      })
    ).filter((r) => r.transition === "escalated");
    expect(escalatedRows).toHaveLength(3);
  });

  it("user-actionable failure surfaces connector degradation while advancing", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(reminderInput({ priority: "high" }));
    h.queueDispatchResults({
      ok: false,
      reason: "auth_expired",
      userActionable: true,
      message: "Google token expired",
    });

    const result = await h.runner.fireWithResult(task.taskId);
    expect(result.kind).toBe("dispatch_deferred");
    if (result.kind !== "dispatch_deferred") throw new Error("unreachable");
    expect(result.reason).toBe("surface_degraded:auth_expired");

    const persisted = await h.store.get(task.taskId);
    expect(persisted?.metadata?.connectorDegradation).toMatchObject({
      reason: "auth_expired",
      message: "Google token expired",
    });
    expect(persisted?.state.status).toBe("scheduled");
  });

  it("snooze resets the pending dispatch continuation with the ladder", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(reminderInput({ priority: "high" }));
    h.queueDispatchResults({
      ok: false,
      reason: "transport_error",
      userActionable: false,
    });
    const result = await h.runner.fireWithResult(task.taskId);
    expect(result.kind).toBe("dispatch_deferred");

    const snoozed = await h.runner.apply(task.taskId, "snooze", {
      minutes: 30,
    });
    expect(snoozed.metadata?.pendingDispatch).toBeUndefined();
  });

  it("void dispatcher results (notify-only emitters) still count as delivery", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(reminderInput());
    h.queueDispatchResults(undefined);
    const result = await h.runner.fireWithResult(task.taskId);
    expect(result.kind).toBe("fired");
    const persisted = await h.store.get(task.taskId);
    expect(persisted?.state.status).toBe("fired");
  });
});
