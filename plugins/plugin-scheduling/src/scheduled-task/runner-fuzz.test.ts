/**
 * Runner state-machine fuzz (#10723 #10721).
 *
 * Drives the REAL runner (in-memory store, scripted dispatcher — same shape
 * as dispatch-policy-enforcement.test.ts) through randomized sequences of
 * schedule / snooze / skip / complete / dismiss / acknowledge / reopen /
 * escalate / edit / fire verbs with randomized dispatch outcomes (success,
 * void, every typed failure reason, and a throwing dispatcher) and a
 * monotonically advancing clock.
 *
 * Invariants checked on every run:
 *  - every persisted task's `state.status` is a valid enum member;
 *  - no dispatch ever happens without a successful atomic fire-claim
 *    (dispatch records ⊆ claim records, matched on taskId + firedAtIso);
 *  - `metadata.pendingDispatch` never survives a snooze or a successful
 *    dispatch;
 *  - the state log is consistent: first row is "scheduled", running count of
 *    "fired" rows never exceeds "fire_attempt" rows, and the current status
 *    always has a matching transition row;
 *  - verbs never throw except the documented legality guards (reopen on a
 *    non-terminal task / expired reopen window), and fire results are always
 *    a member of the ScheduledTaskFireResult union with the documented
 *    post-conditions per kind.
 *
 * Seeds are pinned so failures reproduce; fast-check prints the failing
 * counterexample (the exact op sequence) on assertion failure.
 */

import fc from "fast-check";
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
} from "./runner.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import type {
  ScheduledTask,
  ScheduledTaskLogTransition,
  ScheduledTaskStatus,
  ScheduledTaskVerb,
} from "./types.js";

const AGENT_ID = "agent-runner-fuzz";
const SEED = 20260702;

const VALID_STATUSES: ReadonlySet<ScheduledTaskStatus> = new Set([
  "scheduled",
  "fired",
  "acknowledged",
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

/** Every persisted status must have a matching state-log transition row. */
const STATUS_TO_TRANSITION: Record<
  ScheduledTaskStatus,
  ScheduledTaskLogTransition
> = {
  scheduled: "scheduled",
  fired: "fired",
  acknowledged: "acknowledged",
  completed: "completed",
  skipped: "skipped",
  expired: "expired",
  failed: "failed",
  dismissed: "dismissed",
};

/** Legality guards `apply()` is allowed to throw; anything else is a bug. */
const ALLOWED_APPLY_ERROR =
  /^reopen: (window expired|task .* is not in a terminal state)/;

const VERBS = [
  "snooze",
  "skip",
  "complete",
  "dismiss",
  "escalate",
  "acknowledge",
  "edit",
  "reopen",
] as const satisfies readonly ScheduledTaskVerb[];

type DispatchScript = DispatchResult | undefined | "throw";

const DISPATCH_POOL: readonly DispatchScript[] = [
  { ok: true },
  { ok: true, messageId: "msg-fuzz" },
  undefined, // void dispatcher (notify-only emitter)
  {
    ok: false,
    reason: "rate_limited",
    retryAfterMinutes: 5,
    userActionable: false,
  },
  { ok: false, reason: "disconnected", userActionable: false },
  {
    ok: false,
    reason: "auth_expired",
    userActionable: true,
    message: "expired",
  },
  { ok: false, reason: "unknown_recipient", userActionable: false },
  { ok: false, reason: "transport_error", userActionable: false },
  "throw",
];

/** Trigger pool for scheduled tasks (built against the current clock). */
function triggerAt(index: number, nowMs: number): ScheduledTask["trigger"] {
  switch (index % 5) {
    case 0:
      return {
        kind: "once",
        atIso: new Date(nowMs - 5 * 60_000).toISOString(),
      };
    case 1:
      return {
        kind: "once",
        atIso: new Date(nowMs + 60 * 60_000).toISOString(),
      };
    case 2:
      return { kind: "interval", everyMinutes: 30 };
    case 3:
      return { kind: "cron", expression: "0 */6 * * *", tz: "UTC" };
    default:
      return { kind: "manual" };
  }
}

type FuzzOp =
  | {
      op: "schedule";
      kindIdx: number;
      priority: ScheduledTask["priority"];
      triggerIdx: number;
      withPipeline: boolean;
    }
  | { op: "advance"; minutes: number }
  | { op: "verb"; verb: ScheduledTaskVerb; pick: number; minutes: number }
  | { op: "fire"; pick: number; refire: boolean; resultIdx: number };

const arbOp: fc.Arbitrary<FuzzOp> = fc.oneof(
  {
    arbitrary: fc.record({
      op: fc.constant("schedule" as const),
      kindIdx: fc.nat(7),
      priority: fc.constantFrom<ScheduledTask["priority"]>(
        "low",
        "medium",
        "high",
      ),
      triggerIdx: fc.nat(9),
      withPipeline: fc.boolean(),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      op: fc.constant("advance" as const),
      minutes: fc.integer({ min: 1, max: 180 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      op: fc.constant("verb" as const),
      verb: fc.constantFrom(...VERBS),
      pick: fc.nat(30),
      minutes: fc.integer({ min: 1, max: 90 }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      op: fc.constant("fire" as const),
      pick: fc.nat(30),
      refire: fc.boolean(),
      resultIdx: fc.nat(DISPATCH_POOL.length - 1),
    }),
    weight: 4,
  },
);

const TASK_KINDS = [
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
] as const;

function scheduleInput(
  op: Extract<FuzzOp, { op: "schedule" }>,
  nowMs: number,
): Omit<ScheduledTask, "taskId" | "state"> {
  const base: Omit<ScheduledTask, "taskId" | "state"> = {
    kind: TASK_KINDS[op.kindIdx % TASK_KINDS.length] ?? "reminder",
    promptInstructions: "fuzz task",
    trigger: triggerAt(op.triggerIdx, nowMs),
    priority: op.priority,
    respectsGlobalPause: false,
    ownerVisible: true,
    source: "user_chat",
    createdBy: "fuzz",
  };
  if (!op.withPipeline) return base;
  const child: ScheduledTask = {
    taskId: "st_child_template",
    state: { status: "scheduled", followupCount: 0 },
    ...base,
    trigger: { kind: "manual" },
    promptInstructions: "fuzz pipeline child",
    pipeline: undefined,
  };
  return { ...base, pipeline: { onComplete: [child], onFail: [child] } };
}

interface FuzzHarness {
  runner: ScheduledTaskRunnerHandle;
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
  claims: Array<{ taskId: string; firedAtIso: string }>;
  dispatches: ScheduledTaskDispatchRecord[];
  setDispatchScript(script: DispatchScript): void;
  advance(minutes: number): void;
  nowMs(): number;
}

function makeHarness(startIso: string): FuzzHarness {
  // Auto-incrementing clock: every observation ticks 1ms so state-log rows
  // are strictly ordered by call sequence (the in-memory log store's sort is
  // not stable across equal timestamps).
  let nowMs = Date.parse(startIso);
  let script: DispatchScript = { ok: true };

  const claims: Array<{ taskId: string; firedAtIso: string }> = [];
  const dispatches: ScheduledTaskDispatchRecord[] = [];

  const inner = createInMemoryScheduledTaskStore();
  const store: ScheduledTaskStore = {
    ...inner,
    async claimForFire(args) {
      const result = await inner.claimForFire(args);
      if (result.kind === "fired") {
        claims.push({ taskId: args.taskId, firedAtIso: args.firedAtIso });
      }
      return result;
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
    agentId: AGENT_ID,
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
        if (script === "throw") {
          dispatches.push(record);
          throw new Error("fuzz transport exploded");
        }
        dispatches.push(record);
        return script;
      },
    },
    channelKeys: () => new Set(["in_app", "push", "imessage"]),
    now: () => {
      nowMs += 1;
      return new Date(nowMs);
    },
  });

  return {
    runner,
    store,
    logStore,
    claims,
    dispatches,
    setDispatchScript(next) {
      script = next;
    },
    advance(minutes) {
      nowMs += minutes * 60_000;
    },
    nowMs: () => nowMs,
  };
}

async function pickTask(
  store: ScheduledTaskStore,
  pick: number,
): Promise<ScheduledTask | null> {
  const tasks = await store.list();
  if (tasks.length === 0) return null;
  return tasks[pick % tasks.length] ?? null;
}

function isTerminalStatus(status: ScheduledTaskStatus): boolean {
  return (
    status === "completed" ||
    status === "skipped" ||
    status === "expired" ||
    status === "failed" ||
    status === "dismissed"
  );
}

async function assertStatusesValid(store: ScheduledTaskStore): Promise<void> {
  for (const task of await store.list()) {
    expect(VALID_STATUSES.has(task.state.status)).toBe(true);
  }
}

async function runSequence(ops: FuzzOp[]): Promise<void> {
  const h = makeHarness("2026-05-11T08:00:00.000Z");

  for (const op of ops) {
    switch (op.op) {
      case "schedule": {
        const created = await h.runner.schedule(scheduleInput(op, h.nowMs()));
        expect(created.state.status).toBe("scheduled");
        break;
      }
      case "advance": {
        h.advance(op.minutes);
        break;
      }
      case "verb": {
        const task = await pickTask(h.store, op.pick);
        if (!task) break;
        const wasTerminal = isTerminalStatus(task.state.status);
        const payload =
          op.verb === "snooze"
            ? { minutes: op.minutes }
            : op.verb === "edit"
              ? { priority: "high" as const }
              : { reason: "fuzz" };
        try {
          await h.runner.apply(task.taskId, op.verb, payload);
        } catch (error) {
          // Verbs may only throw their documented legality guards.
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(ALLOWED_APPLY_ERROR);
          break;
        }
        if (op.verb === "reopen") {
          // A reopen that did NOT throw must have started from terminal.
          expect(wasTerminal).toBe(true);
        }
        if (op.verb === "snooze") {
          const persisted = await h.store.get(task.taskId);
          expect(persisted?.state.status).toBe("scheduled");
          // pendingDispatch never survives a snooze (ladder reset).
          expect(persisted?.metadata?.pendingDispatch).toBeUndefined();
        }
        break;
      }
      case "fire": {
        const task = await pickTask(h.store, op.pick);
        if (!task) break;
        h.setDispatchScript(DISPATCH_POOL[op.resultIdx] ?? { ok: true });
        const result = await h.runner.fireWithResult(task.taskId, {
          allowTerminalRefire: op.refire,
        });
        const persisted = await h.store.get(task.taskId);
        switch (result.kind) {
          case "fired":
            expect(persisted?.state.status).toBe("fired");
            // pendingDispatch never survives a successful dispatch.
            expect(persisted?.metadata?.pendingDispatch).toBeUndefined();
            break;
          case "dispatch_deferred":
            expect(persisted?.state.status).toBe("scheduled");
            expect(persisted?.metadata?.pendingDispatch).toBeDefined();
            expect(persisted?.state.firedAt).toBe(result.nextAttemptAtIso);
            break;
          case "dispatch_failed":
            expect(persisted?.state.status).toBe("failed");
            break;
          case "skipped":
            expect(result.reason.length).toBeGreaterThan(0);
            break;
          case "raced":
            expect(result.taskId).toBe(task.taskId);
            break;
          default: {
            const _exhaustive: never = result;
            throw new Error("unreachable fire result");
          }
        }
        break;
      }
      default: {
        const _exhaustive: never = op;
        throw new Error("unreachable op");
      }
    }
    await assertStatusesValid(h.store);
  }

  // -------------------------------------------------------------------------
  // Global invariants over the whole run
  // -------------------------------------------------------------------------

  // No dispatch without a successful atomic claim.
  expect(h.dispatches.length).toBeLessThanOrEqual(h.claims.length);
  for (const dispatch of h.dispatches) {
    expect(
      h.claims.some(
        (claim) =>
          claim.taskId === dispatch.taskId &&
          claim.firedAtIso === dispatch.firedAtIso,
      ),
    ).toBe(true);
  }

  // State-log consistency per task.
  for (const task of await h.store.list()) {
    const rows = await h.logStore.list({
      agentId: AGENT_ID,
      taskId: task.taskId,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.transition).toBe("scheduled");
    let attempts = 0;
    let fired = 0;
    for (const row of rows) {
      if (row.transition === "fire_attempt") attempts += 1;
      if (row.transition === "fired") {
        fired += 1;
        expect(fired).toBeLessThanOrEqual(attempts);
      }
    }
    const required = STATUS_TO_TRANSITION[task.state.status];
    expect(rows.some((row) => row.transition === required)).toBe(true);
  }
}

describe("runner fuzz: randomized verb sequences hold the state-machine invariants", () => {
  it("statuses stay valid, dispatches require claims, pendingDispatch clears, log stays consistent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOp, { minLength: 5, maxLength: 30 }),
        async (ops) => {
          await runSequence(ops);
        },
      ),
      { seed: SEED, numRuns: 40 },
    );
  }, 120_000);

  it("dispatch-failure storms (every fire fails or throws) never corrupt state", async () => {
    const arbFailingOp: fc.Arbitrary<FuzzOp> = fc.oneof(
      {
        arbitrary: fc.record({
          op: fc.constant("schedule" as const),
          kindIdx: fc.nat(7),
          priority: fc.constantFrom<ScheduledTask["priority"]>(
            "low",
            "medium",
            "high",
          ),
          triggerIdx: fc.nat(9),
          withPipeline: fc.boolean(),
        }),
        weight: 2,
      },
      {
        arbitrary: fc.record({
          op: fc.constant("advance" as const),
          minutes: fc.integer({ min: 1, max: 60 }),
        }),
        weight: 2,
      },
      {
        arbitrary: fc.record({
          op: fc.constant("fire" as const),
          pick: fc.nat(30),
          refire: fc.boolean(),
          // Only failing outcomes: indices 3.. of DISPATCH_POOL.
          resultIdx: fc.integer({ min: 3, max: DISPATCH_POOL.length - 1 }),
        }),
        weight: 5,
      },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbFailingOp, { minLength: 5, maxLength: 25 }),
        async (ops) => {
          await runSequence(ops);
        },
      ),
      { seed: SEED, numRuns: 30 },
    );
  }, 120_000);
});
