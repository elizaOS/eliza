/**
 * ScheduledTaskRunner.
 *
 * Cross-agent invariants enforced here:
 *  - The runner does NOT pattern-match on `promptInstructions`.
 *  - `acknowledged` is non-terminal; `pipeline.onComplete` only fires on
 *    `completed`.
 *  - Snooze RESETS the ladder.
 *  - Global pause skips tasks with `respectsGlobalPause: true`.
 *  - `shouldFire` is always an array; empty / missing arrays are treated as
 *    "no gates → allow".
 *  - `idempotencyKey` deduplicates schedules.
 *  - `pipeline.onSkip` wins over `completionCheck.followupAfterMinutes` when
 *    both are set.
 *  - `trigger.kind = "after_task"` children auto-fire when the parent reaches
 *    the recorded terminal outcome through a runner transition (verbs,
 *    gate-deny skip, dispatch failure, `pipeline()`), EXCEPT the global-pause
 *    skip: pause suppresses proactive behavior, and chaining is proactive.
 */

import { decideDispatchPolicy } from "../dispatch-policy.js";
import type { DispatchResult } from "../dispatch-types.js";
import type { CompletionCheckRegistry } from "./completion-check-registry.js";
import type {
  AnchorRegistry,
  ConsolidationRegistry,
} from "./consolidation-policy.js";
import { isScheduledTaskDue } from "./due.js";
import {
  type EscalationLadderRegistry,
  resetLadderForSnooze,
  resolveEffectiveLadder,
} from "./escalation.js";
import type { TaskGateRegistry } from "./gate-registry.js";
import { computeNextFireAt } from "./next-fire-at.js";
import { createStateLogger, type ScheduledTaskLogStore } from "./state-log.js";
import {
  type ActivitySignalBusView,
  APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
  type CompletionCheckContext,
  DEFAULT_TASK_EXECUTION_PROFILE,
  type GateDecision,
  type GateEvaluationContext,
  type GlobalPauseView,
  type OwnerFactsView,
  type ScheduledTask,
  type ScheduledTaskFilter,
  type ScheduledTaskRef,
  type ScheduledTaskRunner,
  type ScheduledTaskState,
  type ScheduledTaskVerb,
  type SubjectStoreView,
  TASK_EXECUTION_PROFILES,
  type TaskExecutionProfile,
  type TerminalState,
} from "./types.js";

/**
 * Typed error thrown by `runner.schedule()` when an `escalation.steps[].channelKey`
 * does not match a registered channel in the host runtime's `ChannelRegistry`.
 * The runner stays decoupled from the channel registry implementation; the
 * caller injects a `channelKeys()` lookup via {@link ScheduledTaskRunnerDeps}.
 */
export class ChannelKeyError extends Error {
  readonly code = "channel_key_unknown";
  constructor(
    readonly channelKey: string,
    readonly available: readonly string[],
  ) {
    super(
      `escalation.steps[].channelKey "${channelKey}" is not registered (registered: ${available.join(", ") || "<none>"})`,
    );
    this.name = "ChannelKeyError";
  }
}

// ---------------------------------------------------------------------------
// Store interface — DB-backed in production; in-memory in unit tests.
// ---------------------------------------------------------------------------

/**
 * Options the runner passes to `store.upsert` to keep the indexed
 * `next_fire_at` column in sync with the task's current trigger and state.
 *
 * The store does not compute this itself — the runner computes the value
 * using the active anchor / owner-facts / now references and forwards it
 * here. The repository writes a Postgres `timestamp with time zone`
 * (NULL for triggers without a wall-clock fire time).
 */
export interface ScheduledTaskUpsertOptions {
  nextFireAtIso: string | null;
}

/**
 * Outcome of the atomic fire-claim. Exactly one parallel call resolves to
 * `"fired"` for a given `(taskId, status="scheduled")` row; concurrent
 * callers see `"raced"` because the UPDATE … WHERE status='scheduled' clause
 * matches zero rows after the first wins.
 *
 * `task` on the `"fired"` branch carries the post-claim state (status =
 * "fired", `firedAt` set to the claim instant, `nextFireAt` cleared so the
 * scheduler tick will not re-pick it up before the next mutation).
 */
export type ScheduledTaskClaimResult =
  | { kind: "fired"; task: ScheduledTask }
  | { kind: "raced" };

/**
 * Compare-and-swap guard for a recurrence-refire claim. The runner passes the
 * `(status, firedAt)` pair it OBSERVED on the row; the store only claims when
 * the row still matches. Because a successful claim always rewrites
 * `state.firedAt` to the (new) claim instant, two concurrent ticks refiring
 * the same occurrence cannot both match: the winner's UPDATE changes
 * `firedAt`, so the loser's expected pair no longer holds and it races out —
 * even when both ticks observed the same status (e.g. `fired` → `fired`).
 */
export interface ScheduledTaskClaimExpectation {
  status: ScheduledTask["state"]["status"];
  firedAtIso: string | null;
}

export interface ScheduledTaskStore {
  upsert(
    task: ScheduledTask,
    options?: ScheduledTaskUpsertOptions,
  ): Promise<void>;
  /**
   * Atomically transition a row to `"fired"`, returning the resulting row.
   * Returns `{ kind: "raced" }` when zero rows matched — either because the
   * row's state moved (another tick claimed it) or the id no longer exists.
   *
   * Without `expected`, the claim matches `state.status === "scheduled"`
   * only (the fresh-fire path — flipping `scheduled` → `fired` makes the
   * WHERE clause self-invalidating for concurrent claimers). With
   * `expected`, the claim is a CAS on the observed `(status, firedAt)` pair
   * — the recurrence-refire path, where the pre-claim status may already be
   * `fired` / `acknowledged` / a terminal state.
   *
   * The store is the only place where the read-mutate-write becomes
   * atomic; the runner's previous read-then-upsert pattern was racy
   * across parallel ticks. See `LifeOpsRepository.claimScheduledTaskForFire`.
   */
  claimForFire(args: {
    taskId: string;
    firedAtIso: string;
    expected?: ScheduledTaskClaimExpectation;
  }): Promise<ScheduledTaskClaimResult>;
  get(taskId: string): Promise<ScheduledTask | null>;
  findByIdempotencyKey(key: string): Promise<ScheduledTask | null>;
  list(filter?: ScheduledTaskFilter): Promise<ScheduledTask[]>;
  delete(taskId: string): Promise<void>;
}

export function createInMemoryScheduledTaskStore(): ScheduledTaskStore {
  const map = new Map<string, ScheduledTask>();
  return {
    async upsert(task) {
      map.set(task.taskId, structuredClone(task));
    },
    async claimForFire({ taskId, firedAtIso, expected }) {
      const existing = map.get(taskId);
      if (!existing) return { kind: "raced" };
      if (expected) {
        if (
          existing.state.status !== expected.status ||
          (existing.state.firedAt ?? null) !== expected.firedAtIso
        ) {
          return { kind: "raced" };
        }
      } else if (existing.state.status !== "scheduled") {
        return { kind: "raced" };
      }
      const next: ScheduledTask = structuredClone(existing);
      next.state.status = "fired";
      next.state.firedAt = firedAtIso;
      map.set(taskId, next);
      return { kind: "fired", task: structuredClone(next) };
    },
    async get(taskId) {
      const found = map.get(taskId);
      return found ? structuredClone(found) : null;
    },
    async findByIdempotencyKey(key) {
      for (const t of map.values()) {
        if (t.idempotencyKey === key) {
          return structuredClone(t);
        }
      }
      return null;
    },
    async list(filter) {
      let view = Array.from(map.values()).map((t) => structuredClone(t));
      if (!filter) return view;
      if (filter.kind) view = view.filter((t) => t.kind === filter.kind);
      if (filter.status) {
        const allowed = Array.isArray(filter.status)
          ? new Set(filter.status)
          : new Set([filter.status]);
        view = view.filter((t) => allowed.has(t.state.status));
      }
      if (filter.subject) {
        view = view.filter(
          (t) =>
            t.subject?.kind === filter.subject?.kind &&
            t.subject?.id === filter.subject?.id,
        );
      }
      if (filter.source) view = view.filter((t) => t.source === filter.source);
      if (filter.firedSince) {
        view = view.filter(
          (t) =>
            typeof t.state.firedAt === "string" &&
            t.state.firedAt >= (filter.firedSince ?? ""),
        );
      }
      if (filter.ownerVisibleOnly) view = view.filter((t) => t.ownerVisible);
      return view;
    },
    async delete(taskId) {
      map.delete(taskId);
    },
  };
}

export interface ScheduledTaskDispatchRecord {
  taskId: string;
  firedAtIso: string;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
  promptInstructions: string;
  contextRequest: ScheduledTask["contextRequest"];
  consolidationBatchId?: string;
  output?: ScheduledTask["output"];
  metadata?: ScheduledTask["metadata"];
}

export interface ScheduledTaskDispatcher {
  dispatch(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined>;
}

/**
 * Test-only no-op dispatcher. Production code MUST inject
 * `createProductionScheduledTaskDispatcher` via runtime-wiring; the runner
 * factory requires a dispatcher and there is no silent fallback. Exported only
 * so tests can construct a runner without touching the channel layer.
 *
 * @internal
 */
export const TestNoopScheduledTaskDispatcher: ScheduledTaskDispatcher = {
  async dispatch() {
    /* intentional no-op for tests */
  },
};

// ---------------------------------------------------------------------------
// Runner deps (factory)
// ---------------------------------------------------------------------------

export interface ScheduledTaskRunnerDeps {
  agentId: string;
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
  gates: TaskGateRegistry;
  completionChecks: CompletionCheckRegistry;
  ladders: EscalationLadderRegistry;
  anchors: AnchorRegistry;
  consolidation: ConsolidationRegistry;
  ownerFacts: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause: GlobalPauseView;
  activity: ActivitySignalBusView;
  subjectStore: SubjectStoreView;
  dispatcher: ScheduledTaskDispatcher;
  /**
   * Lookup of registered `ChannelRegistry` keys. When supplied, `schedule()`
   * validates each `escalation.steps[].channelKey` against this set and
   * throws {@link ChannelKeyError} on miss. Decoupled from the channels
   * module to keep the spine free of channel-layer dependencies.
   */
  channelKeys?: () => ReadonlySet<string>;
  /**
   * Returns the set of `TaskExecutionProfile` values the current host can
   * actually run. The runner consults this AFTER the atomic fire-claim but
   * BEFORE dispatch: if `task.executionProfile` is not in the set, dispatch
   * is rewritten to `notify-only` and a `"substituted"` state-log row is
   * recorded. Default (when not provided): all four profiles available —
   * appropriate for tests and Node desktop. Mobile / Capacitor callers
   * inject a real probe from
   * `@elizaos/app-core/services/local-inference/host-capabilities`.
   */
  hostCapabilities?: () => ReadonlySet<TaskExecutionProfile>;
  /** Override for tests. */
  newTaskId?: () => string;
  /** Override for tests. */
  now?: () => Date;
}

/**
 * Default capability probe — assumes a full host (test/Node). Mobile callers
 * inject a real probe so heavy tasks substitute to notify-only on incapable
 * hosts instead of silently failing under a 30s wake budget.
 */
const ALL_PROFILES_AVAILABLE: ReadonlySet<TaskExecutionProfile> = new Set(
  TASK_EXECUTION_PROFILES,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultTaskIdGenerator(): string {
  // Stable enough across runtimes; the DB is authoritative for uniqueness.
  return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isTerminal(status: ScheduledTask["state"]["status"]): boolean {
  return (
    status === "completed" ||
    status === "skipped" ||
    status === "expired" ||
    status === "failed" ||
    status === "dismissed"
  );
}

function isRecurringTrigger(trigger: ScheduledTask["trigger"]): boolean {
  return (
    trigger.kind === "cron" ||
    trigger.kind === "interval" ||
    trigger.kind === "relative_to_anchor" ||
    trigger.kind === "during_window"
  );
}

function setEscalationCursor(
  task: ScheduledTask,
  cursor: { stepIndex: number; lastDispatchedAt: string },
): void {
  task.metadata = {
    ...(task.metadata ?? {}),
    escalationCursor: { ...cursor },
  };
}

/**
 * Retry attempts allowed on one dispatch step before the policy's `retry`
 * decision is escalated to `advance` (or `fail` on the last step). Guards
 * against a connector that reports `rate_limited` forever pinning the task
 * in an infinite retry loop.
 */
const MAX_DISPATCH_RETRIES_PER_STEP = 3;

/**
 * Continuation marker for a dispatch that failed with a typed
 * `DispatchResult { ok: false }`. `stepIndex` is the escalation-ladder step
 * the NEXT fire attempt must dispatch through (`-1` = the initial/default
 * channel), `attempt` counts retries already burned on that step.
 * Persisted in `metadata.pendingDispatch`; cleared on successful dispatch
 * and on snooze (ladder reset).
 */
interface PendingDispatch {
  stepIndex: number;
  attempt: number;
}

function readPendingDispatch(task: ScheduledTask): PendingDispatch | null {
  const raw = task.metadata?.pendingDispatch;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const stepIndex = (raw as Record<string, unknown>).stepIndex;
  const attempt = (raw as Record<string, unknown>).attempt;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) {
    return null;
  }
  return {
    stepIndex,
    attempt:
      typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 0
        ? attempt
        : 0,
  };
}

function setPendingDispatch(task: ScheduledTask, pending: PendingDispatch) {
  task.metadata = {
    ...(task.metadata ?? {}),
    pendingDispatch: { ...pending },
  };
}

function clearPendingDispatch(task: ScheduledTask): void {
  if (task.metadata && "pendingDispatch" in task.metadata) {
    const next = { ...task.metadata };
    delete (next as Record<string, unknown>).pendingDispatch;
    task.metadata = next;
  }
}

function clearEscalationCursor(task: ScheduledTask): void {
  if (task.metadata && "escalationCursor" in task.metadata) {
    const next = { ...task.metadata };
    delete (next as Record<string, unknown>).escalationCursor;
    task.metadata = next;
  }
}

function stripServerManaged(
  task: ScheduledTask,
): Omit<ScheduledTask, "taskId" | "state"> {
  const { taskId: _id, state: _state, ...rest } = task;
  return rest;
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Public read view of `metadata.escalationCursor`.
 *
 * The cursor is the runner's persistence channel for the snooze-resets-ladder
 * rule. Consumers that need to surface "currently on step N of escalation"
 * read it through {@link ScheduledTaskRunnerExtras.getEscalationCursor} so
 * they don't reach into the metadata namespace directly.
 *
 * - `stepIndex` follows the {@link EscalationCursor} convention: `-1` means
 *   the task was fired but no escalation step has been dispatched yet;
 *   `0..n` is the index into the resolved ladder's `steps`.
 * - `lastFiredAt` is the ISO of the most recent dispatch (or the initial
 *   task fire when `stepIndex === -1`).
 * - `channelKey` is resolved from the effective ladder. For `stepIndex === -1`
 *   we surface the first step's channel when the ladder has steps, falling
 *   back to `"in_app"` when the ladder is empty.
 */
export interface EscalationCursorView {
  stepIndex: number;
  lastFiredAt: string;
  channelKey: string;
}

/**
 * Strict result of a single `fire()` attempt. Callers should exhaustively
 * switch on `kind`.
 *
 * - `fired` — the task transitioned to `"fired"` (or was deferred via
 *   `gate.defer`, reopened for a recurrence, etc.) and the dispatcher ran.
 *   `task` is the post-mutation state.
 * - `raced` — another tick atomically claimed this task first. Caller drops
 *   the attempt silently; the winning tick's dispatch is authoritative.
 * - `skipped` — the task was skipped without dispatch: global-pause active,
 *   a gate denied, or the task was already terminal and not eligible for
 *   recurrence refire.
 * - `dispatch_deferred` — the dispatcher returned a typed
 *   `DispatchResult { ok: false }` and {@link decideDispatchPolicy} chose to
 *   retry the SAME step after a backoff (transient failures, bounded
 *   attempts) or advance to the next escalation-ladder step (permanent
 *   failures with rungs remaining). The task is back in `"scheduled"` with
 *   `state.firedAt` set to the next attempt time (the scheduled-override the
 *   tick honors). Nothing reached the user yet.
 * - `dispatch_failed` — the atomic claim succeeded but the dispatch did not
 *   reach the user and no retry/escalation step remains: the dispatcher
 *   threw, or it returned a non-retriable `{ ok: false }` with the ladder
 *   exhausted. The runner persists the row as `"failed"`, writes a failed
 *   state-log entry, and runs `pipeline.onFail` so history does not strand
 *   the task as successfully fired.
 */
export type ScheduledTaskFireResult =
  | { kind: "fired"; task: ScheduledTask }
  | { kind: "raced"; taskId: string }
  | { kind: "skipped"; task: ScheduledTask; reason: string }
  | {
      kind: "dispatch_deferred";
      task: ScheduledTask;
      reason: string;
      nextAttemptAtIso: string;
    }
  | { kind: "dispatch_failed"; task: ScheduledTask; error: Error };

export interface ScheduledTaskRunnerExtras {
  /**
   * Convenience wrapper around {@link ScheduledTaskRunnerExtras.fireWithResult}
   * that flattens the discriminated union into a `ScheduledTask`. Returns
   * the post-fire task on `fired` / `skipped` / `dispatch_failed`, and the
   * still-`scheduled` task on `raced` (so legacy callers that re-read see
   * the unmodified row). The strict-fire callsite — `processDueScheduledTasks`
   * — uses `fireWithResult` directly.
   *
   * Exposed for tests so we can assert behavior deterministically without
   * waiting on a real timer, and for legacy actions that only want the
   * task back.
   */
  fire(
    taskId: string,
    args?: { eventPayload?: unknown; allowTerminalRefire?: boolean },
  ): Promise<ScheduledTask>;
  /**
   * Strict fire-attempt. Returns the {@link ScheduledTaskFireResult}
   * discriminated union; callers must exhaustively switch on `kind`. This
   * is the path the scheduler tick uses so the `raced` outcome (another
   * tick claimed the same row first) is observable instead of silently
   * collapsed into a "fired" return.
   */
  fireWithResult(
    taskId: string,
    args?: { eventPayload?: unknown; allowTerminalRefire?: boolean },
  ): Promise<ScheduledTaskFireResult>;
  /**
   * Re-evaluate completion for a fired task (e.g. user_replied_within
   * scenarios, late inbounds). The runner consults its registered
   * completion-check and may transition the task to `completed`.
   */
  evaluateCompletion(
    taskId: string,
    signal: {
      acknowledged?: boolean;
      repliedAtIso?: string;
    },
  ): Promise<ScheduledTask>;
  /**
   * Run the nightly rollup pass on the state-log. Default retention is 90
   * days.
   */
  rolloverStateLog(opts?: { retentionDays?: number }): Promise<{
    rolledUp: number;
    deletedRaw: number;
  }>;
  /**
   * Return all gates registered (for the dev-registries endpoint).
   */
  inspectRegistries(): {
    gates: string[];
    completionChecks: string[];
    ladders: string[];
    anchors: string[];
    consolidationPolicies: string[];
  };
  /**
   * Read the public view of `metadata.escalationCursor` for a task. Returns
   * `null` when the task is not found or has no cursor recorded yet.
   */
  getEscalationCursor(taskId: string): Promise<EscalationCursorView | null>;
}

export interface ScheduledTaskRunnerHandle
  extends ScheduledTaskRunner,
    ScheduledTaskRunnerExtras {}

export function createScheduledTaskRunner(
  deps: ScheduledTaskRunnerDeps,
): ScheduledTaskRunnerHandle {
  const newTaskId = deps.newTaskId ?? defaultTaskIdGenerator;
  const now = deps.now ?? (() => new Date());
  const dispatcher = deps.dispatcher;
  const logger = createStateLogger({
    store: deps.logStore,
    agentId: deps.agentId,
    now,
  });

  async function evaluateGates(
    task: ScheduledTask,
  ): Promise<{ decision: GateDecision; gateKind?: string }> {
    const compose = task.shouldFire?.compose ?? "first_deny";
    const gates = task.shouldFire?.gates ?? [];
    if (gates.length === 0) {
      return { decision: { kind: "allow" } };
    }

    const ownerFacts = await deps.ownerFacts();
    const ctx: GateEvaluationContext = {
      task,
      nowIso: now().toISOString(),
      ownerFacts,
      activity: deps.activity,
      subjectStore: deps.subjectStore,
    };

    const decisions: Array<{ gateKind: string; decision: GateDecision }> = [];
    for (const gateRef of gates) {
      const contrib = deps.gates.get(gateRef.kind);
      if (!contrib) {
        return {
          gateKind: gateRef.kind,
          decision: {
            kind: "deny",
            reason: `unknown gate kind: ${gateRef.kind}`,
          },
        };
      }
      const decision = await contrib.evaluate(task, ctx);
      decisions.push({ gateKind: gateRef.kind, decision });

      if (compose === "first_deny" && decision.kind !== "allow") {
        return { gateKind: gateRef.kind, decision };
      }
      if (compose === "any" && decision.kind === "allow") {
        return { gateKind: gateRef.kind, decision: { kind: "allow" } };
      }
    }

    if (compose === "all") {
      const denied = decisions.find((d) => d.decision.kind !== "allow");
      if (denied) return denied;
      return { decision: { kind: "allow" } };
    }
    if (compose === "any") {
      // No allow seen.
      const lastDeny = decisions
        .reverse()
        .find((d) => d.decision.kind === "deny");
      if (lastDeny) return lastDeny;
      const lastDefer = decisions.find((d) => d.decision.kind === "defer");
      if (lastDefer) return lastDefer;
      return {
        decision: { kind: "deny", reason: "any: no gate allowed" },
      };
    }
    // first_deny: no deny encountered → allow
    return { decision: { kind: "allow" } };
  }

  async function shouldDeferForGlobalPause(
    task: ScheduledTask,
  ): Promise<{ paused: boolean; reason?: string }> {
    if (task.respectsGlobalPause === false) return { paused: false };
    const pause = await deps.globalPause.current(now());
    if (!pause.active) return { paused: false };
    return {
      paused: true,
      reason: pause.reason ? `global_pause: ${pause.reason}` : "global_pause",
    };
  }

  async function persist(task: ScheduledTask): Promise<ScheduledTask> {
    const nextFireAtIso = await resolveNextFireAt(task);
    await deps.store.upsert(task, { nextFireAtIso });
    return structuredClone(task);
  }

  async function resolveNextFireAt(
    task: ScheduledTask,
  ): Promise<string | null> {
    // Dismissed rows never refire. Settled NON-recurring rows are done —
    // storing a stale `next_fire_at` would leave them in the partial-index
    // slice forever; clearing it keeps the index slim.
    //
    // RECURRING rows in every other status (`acknowledged` and the remaining
    // terminal states) keep a trigger-derived `next_fire_at`: that is what
    // lets the scheduler tick's indexed slice resurface a completed / skipped
    // / acknowledged daily task at its NEXT occurrence (recurrence refire,
    // claimed via the CAS in `fireWithResult`). `computeNextFireAt` projects
    // forward from `now`, so the stored value is always the next FUTURE
    // occurrence — a gate-denied occurrence does not re-enter the slice
    // every tick.
    if (task.state.status === "dismissed") return null;
    if (isTerminal(task.state.status) && !isRecurringTrigger(task.trigger)) {
      return null;
    }
    if (
      task.state.status === "acknowledged" &&
      !isRecurringTrigger(task.trigger)
    ) {
      // A non-recurring acknowledged row has no future occurrence; keeping
      // its trigger-derived time would park it in the tick slice where every
      // pass would race out on the `scheduled`-only claim.
      return null;
    }
    const ownerFacts = await deps.ownerFacts();
    return computeNextFireAt(task, {
      now: now(),
      ownerFacts,
      anchors: deps.anchors,
    });
  }

  async function schedule(
    input: Omit<ScheduledTask, "taskId" | "state">,
  ): Promise<ScheduledTask> {
    if (input.idempotencyKey) {
      const existing = await deps.store.findByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) return existing;
    }

    // A11: channel-key validation against the runtime ChannelRegistry.
    if (deps.channelKeys && input.escalation?.steps) {
      const registered = deps.channelKeys();
      for (const step of input.escalation.steps) {
        if (!registered.has(step.channelKey)) {
          throw new ChannelKeyError(
            step.channelKey,
            Array.from(registered).sort(),
          );
        }
      }
    }

    // A7: default `completionCheck.followupAfterMinutes` for approval-kind
    // tasks when the curator did not set one explicitly and pipeline.onSkip
    // is empty (which would otherwise win per §7.4 resolution rule).
    const withApprovalDefaults = applyApprovalCompletionDefault(input);

    const initialState: ScheduledTaskState = {
      status: "scheduled",
      followupCount: 0,
    };
    const task: ScheduledTask = {
      taskId: newTaskId(),
      ...withApprovalDefaults,
      state: initialState,
    };
    await persist(task);
    await logger.log(task.taskId, "scheduled", {
      detail: {
        kind: task.kind,
        priority: task.priority,
        triggerKind: task.trigger.kind,
      },
    });
    if (
      task.completionCheck?.followupAfterMinutes &&
      task.pipeline?.onSkip &&
      task.pipeline.onSkip.length > 0
    ) {
      await logger.log(task.taskId, "edited", {
        reason:
          "validation: pipeline.onSkip overrides completionCheck.followupAfterMinutes",
      });
    }
    return task;
  }

  function applyApprovalCompletionDefault(
    input: Omit<ScheduledTask, "taskId" | "state">,
  ): Omit<ScheduledTask, "taskId" | "state"> {
    if (input.kind !== "approval") return input;
    const onSkipEmpty =
      !input.pipeline?.onSkip || input.pipeline.onSkip.length === 0;
    if (!onSkipEmpty) return input;
    if (input.completionCheck?.followupAfterMinutes !== undefined) return input;
    const baseCheck = input.completionCheck ?? { kind: "user_acknowledged" };
    return {
      ...input,
      completionCheck: {
        ...baseCheck,
        followupAfterMinutes: APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
      },
    };
  }

  async function list(filter?: ScheduledTaskFilter): Promise<ScheduledTask[]> {
    return deps.store.list(filter);
  }

  // -------------------------------------------------------------------------
  // Verb dispatch
  // -------------------------------------------------------------------------

  async function applySnooze(
    task: ScheduledTask,
    payload: { minutes?: number; untilIso?: string } | undefined,
  ): Promise<ScheduledTask> {
    const minutes = payload?.minutes;
    const untilIso = payload?.untilIso;
    let newFireAtIso: string;
    if (typeof untilIso === "string") {
      newFireAtIso = new Date(untilIso).toISOString();
    } else if (typeof minutes === "number" && minutes > 0) {
      newFireAtIso = new Date(now().getTime() + minutes * 60_000).toISOString();
    } else {
      throw new Error("snooze: provide minutes or untilIso");
    }
    const reopenStatus: ScheduledTask["state"]["status"] = "scheduled";
    task.state.status = reopenStatus;
    task.state.firedAt = newFireAtIso;
    task.state.lastDecisionLog = `snoozed until ${newFireAtIso} (ladder reset)`;
    setEscalationCursor(task, resetLadderForSnooze(newFireAtIso));
    // Snooze resets the ladder — any pending dispatch retry/advance
    // continuation resets with it.
    clearPendingDispatch(task);
    await persist(task);
    await logger.log(task.taskId, "snoozed", {
      reason: `until ${newFireAtIso}`,
      detail: { newFireAtIso },
    });
    return task;
  }

  async function applySkip(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    task.state.status = "skipped";
    task.state.lastDecisionLog = payload?.reason ?? "user skipped";
    await persist(task);
    await logger.log(task.taskId, "skipped", {
      reason: payload?.reason ?? "user skipped",
    });
    await settleTerminal(task, "skipped");
    return task;
  }

  async function applyComplete(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    task.state.status = "completed";
    task.state.completedAt = now().toISOString();
    task.state.lastDecisionLog = payload?.reason ?? "completed";
    await persist(task);
    await logger.log(task.taskId, "completed", { reason: payload?.reason });
    await settleTerminal(task, "completed");
    return task;
  }

  async function applyDismiss(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    task.state.status = "dismissed";
    task.state.lastDecisionLog = payload?.reason ?? "dismissed";
    await persist(task);
    await logger.log(task.taskId, "dismissed", { reason: payload?.reason });
    // `pipeline.on*` deliberately does not propagate `dismissed`; `after_task`
    // children DO cover it (the trigger union records all five outcomes).
    await fireAfterTaskChildren(task, "dismissed");
    return task;
  }

  async function applyEscalate(
    task: ScheduledTask,
    payload: { force?: boolean } | undefined,
  ): Promise<ScheduledTask> {
    // `escalate` is a manual nudge to the next ladder step. The dispatcher
    // transition is handled inside fire(); we simply mark the task as fired
    // with intensity escalation and write a log row. The actual channel
    // egress happens via the dispatcher when fire() runs.
    task.state.followupCount += 1;
    task.state.lastFollowupAt = now().toISOString();
    task.state.lastDecisionLog = "escalated";
    await persist(task);
    await logger.log(task.taskId, "escalated", {
      reason: payload?.force ? "force=true" : undefined,
    });
    return task;
  }

  async function applyAcknowledge(task: ScheduledTask): Promise<ScheduledTask> {
    // §7.6: acknowledged is non-terminal. Pipeline.onComplete does NOT fire.
    task.state.status = "acknowledged";
    task.state.acknowledgedAt = now().toISOString();
    task.state.lastDecisionLog = "acknowledged";
    await persist(task);
    await logger.log(task.taskId, "acknowledged");
    return task;
  }

  async function applyEdit(
    task: ScheduledTask,
    payload: Partial<Omit<ScheduledTask, "taskId" | "state">> | undefined,
  ): Promise<ScheduledTask> {
    if (!payload) return task;
    // Cannot edit through state — that's what verbs are for.
    const banned: Array<keyof ScheduledTask> = ["taskId", "state"];
    for (const key of banned) {
      if (key in (payload as Record<string, unknown>)) {
        throw new Error(`edit: ${String(key)} is read-only`);
      }
    }
    Object.assign(task, payload);
    await persist(task);
    await logger.log(task.taskId, "edited", {
      detail: { keys: Object.keys(payload) },
    });
    return task;
  }

  async function applyReopen(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    if (!isTerminal(task.state.status)) {
      throw new Error(
        `reopen: task ${task.taskId} is not in a terminal state (status=${task.state.status})`,
      );
    }
    // §8.12: late-inbound reopen window default 24h after lastFollowupAt;
    // configurable via metadata.reopenWindowHours.
    const windowHours = (() => {
      const raw = task.metadata?.reopenWindowHours;
      return typeof raw === "number" && raw > 0 ? raw : 24;
    })();
    const referenceIso =
      task.state.lastFollowupAt ??
      task.state.firedAt ??
      task.state.completedAt ??
      now().toISOString();
    const expiresMs =
      new Date(referenceIso).getTime() + windowHours * 60 * 60 * 1000;
    if (now().getTime() > expiresMs) {
      throw new Error(
        `reopen: window expired (>${windowHours}h since ${referenceIso})`,
      );
    }
    task.state.status = "scheduled";
    task.state.lastDecisionLog = payload?.reason ?? "reopened";
    clearEscalationCursor(task);
    await persist(task);
    await logger.log(task.taskId, "reopened", { reason: payload?.reason });
    return task;
  }

  async function apply(
    taskId: string,
    verb: ScheduledTaskVerb,
    payload?: unknown,
  ): Promise<ScheduledTask> {
    const task = await deps.store.get(taskId);
    if (!task) {
      throw new Error(`apply: task ${taskId} not found`);
    }
    switch (verb) {
      case "snooze":
        return applySnooze(
          task,
          payload as { minutes?: number; untilIso?: string },
        );
      case "skip":
        return applySkip(task, payload as { reason?: string });
      case "complete":
        return applyComplete(task, payload as { reason?: string });
      case "dismiss":
        return applyDismiss(task, payload as { reason?: string });
      case "escalate":
        return applyEscalate(task, payload as { force?: boolean });
      case "acknowledge":
        return applyAcknowledge(task);
      case "edit":
        return applyEdit(
          task,
          payload as Partial<Omit<ScheduledTask, "taskId" | "state">>,
        );
      case "reopen":
        return applyReopen(task, payload as { reason?: string });
      default: {
        const exhaustive: never = verb;
        throw new Error(`apply: unknown verb ${String(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline propagation + after_task chaining
  // -------------------------------------------------------------------------

  /**
   * Fire every `scheduled` task whose trigger is
   * `{ kind: "after_task", taskId: parent, outcome }`. This is the push side
   * of the `after_task` contract (`isScheduledTaskDue` reports these tasks
   * not-due, so the tick never wall-clock fires them). Firing goes through
   * `fireWithResult`, whose atomic claim makes concurrent terminal
   * transitions race-safe — one dispatch per child, losers observe `raced`.
   *
   * Unlike `pipeline.on*` (declared on the parent), `after_task` is declared
   * on the CHILD, so chains can be attached without editing the parent, and
   * they cover ALL five terminal outcomes (`pipeline` only propagates
   * completed / skipped / failed).
   */
  async function fireAfterTaskChildren(
    parent: ScheduledTask,
    outcome: TerminalState,
  ): Promise<void> {
    const scheduled = await deps.store.list({ status: "scheduled" });
    for (const child of scheduled) {
      if (child.trigger.kind !== "after_task") continue;
      if (child.trigger.taskId !== parent.taskId) continue;
      if (child.trigger.outcome !== outcome) continue;
      await fireWithResult(child.taskId, {
        eventPayload: { afterTask: { taskId: parent.taskId, outcome } },
      });
    }
  }

  /**
   * The single terminal-transition seam: propagate `pipeline.on*` refs, then
   * fire matching `after_task` children. Every runner path that records a
   * terminal outcome routes through here (the global-pause skip deliberately
   * does not — pause suppresses chaining).
   */
  async function settleTerminal(
    parent: ScheduledTask,
    outcome: TerminalState,
  ): Promise<ScheduledTask[]> {
    const created = await runPipeline(parent, outcome);
    await fireAfterTaskChildren(parent, outcome);
    return created;
  }

  async function runPipeline(
    parent: ScheduledTask,
    outcome: TerminalState,
  ): Promise<ScheduledTask[]> {
    const refs: ScheduledTaskRef[] | undefined = (() => {
      switch (outcome) {
        case "completed":
          return parent.pipeline?.onComplete;
        case "skipped":
          return parent.pipeline?.onSkip;
        case "failed":
          return parent.pipeline?.onFail;
        // expired / dismissed do not propagate; pipeline.onSkip captures
        // the user-skip case explicitly.
        default:
          return undefined;
      }
    })();
    if (!refs || refs.length === 0) return [];
    const created: ScheduledTask[] = [];
    for (const ref of refs) {
      if (typeof ref === "string") {
        const child = await deps.store.get(ref);
        if (child) {
          // Mark the parent linkage on the child for observability.
          child.state.pipelineParentId = parent.taskId;
          await persist(child);
          await logger.log(child.taskId, "edited", {
            reason: `pipeline.${outcomeToFieldName(outcome)} parent=${parent.taskId}`,
          });
          created.push(child);
        }
        continue;
      }
      const cloned = structuredClone(ref);
      // Strip server-managed fields if the caller passed a fully-shaped
      // `ScheduledTask`. `schedule()` regenerates them.
      const childInput = stripServerManaged(cloned);
      const fresh = await schedule(childInput);
      fresh.state.pipelineParentId = parent.taskId;
      await persist(fresh);
      created.push(fresh);
    }
    return created;
  }

  function outcomeToFieldName(outcome: TerminalState): string {
    switch (outcome) {
      case "completed":
        return "onComplete";
      case "skipped":
        return "onSkip";
      case "failed":
        return "onFail";
      default:
        return outcome;
    }
  }

  async function pipeline(
    taskId: string,
    outcome: TerminalState,
  ): Promise<ScheduledTask[]> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`pipeline: task ${taskId} not found`);
    // D12: when callers invoke pipeline("failed") (or any terminal state the
    // runner has not recorded), bring the parent's terminal state into
    // alignment with the dispatched outcome before propagating to children.
    // `apply("complete" | "skip")` already writes the matching status, so we
    // only flip when the parent is still live and the outcome differs.
    if (!isTerminal(task.state.status) && task.state.status !== outcome) {
      task.state.status = outcome;
      task.state.lastDecisionLog = `pipeline: ${outcome}`;
      if (outcome === "completed" && !task.state.completedAt) {
        task.state.completedAt = now().toISOString();
      }
      await persist(task);
      await logger.log(task.taskId, outcomeToLogTransition(outcome), {
        reason: `pipeline: ${outcome}`,
      });
    }
    return settleTerminal(task, outcome);
  }

  function outcomeToLogTransition(
    outcome: TerminalState,
  ): "completed" | "skipped" | "expired" | "failed" | "dismissed" {
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Fire / evaluate completion
  // -------------------------------------------------------------------------

  async function fire(
    taskId: string,
    args?: { eventPayload?: unknown; allowTerminalRefire?: boolean },
  ): Promise<ScheduledTask> {
    const result = await fireWithResult(taskId, args);
    switch (result.kind) {
      case "fired":
      case "skipped":
      case "dispatch_deferred":
      case "dispatch_failed":
        return result.task;
      case "raced": {
        // The caller did not opt in to seeing race outcomes; re-read the
        // row the winning tick committed so observers still see a coherent
        // post-claim ScheduledTask instead of stale pre-claim state.
        const winner = await deps.store.get(result.taskId);
        if (winner) return winner;
        throw new Error(`fire: task ${result.taskId} not found after race`);
      }
      default: {
        const _exhaustive: never = result;
        throw new Error("fire: unreachable");
      }
    }
  }

  /**
   * Record a claimed task as `failed` and return the `dispatch_failed`
   * outcome. Shared by two callers: (1) the dispatcher THREW, and (2) the
   * dispatcher RETURNED a non-retriable `DispatchResult { ok: false }`. Both
   * mean the user-visible send did not happen, so history must not strand the
   * row as successfully `fired`. The failure runs `pipeline.onFail` exactly
   * like the throw path always has.
   *
   * `dispatchResult` is attached to `metadata.lastDispatchResult` on the
   * returned-failure path so the connector-degradation surface can read the
   * typed reason; on the throw path there is no result to attach.
   */
  async function recordDispatchFailure(
    claimed: ScheduledTask,
    failure: { error: Error; dispatchResult?: DispatchResult },
  ): Promise<ScheduledTaskFireResult> {
    const reason = `dispatch_failed: ${failure.error.message}`;
    claimed.state.status = "failed";
    claimed.state.lastDecisionLog = reason;
    clearPendingDispatch(claimed);
    claimed.metadata = {
      ...(claimed.metadata ?? {}),
      lastDispatchError: {
        name: failure.error.name,
        message: failure.error.message,
      },
      ...(failure.dispatchResult
        ? { lastDispatchResult: failure.dispatchResult }
        : {}),
    };
    await persist(claimed);
    await logger.log(claimed.taskId, "failed", {
      reason,
      detail: {
        errorName: failure.error.name,
        message: failure.error.message,
      },
    });
    await settleTerminal(claimed, "failed");
    return { kind: "dispatch_failed", task: claimed, error: failure.error };
  }

  async function fireWithResult(
    taskId: string,
    args?: { eventPayload?: unknown; allowTerminalRefire?: boolean },
  ): Promise<ScheduledTaskFireResult> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`fire: task ${taskId} not found`);
    // Recurrence refire: `allowTerminalRefire` authorizes claiming the DUE
    // next occurrence of a RECURRING task whose row is parked in a
    // non-`scheduled` status — `fired` (zombie: nothing ever completed the
    // previous occurrence), `acknowledged` (non-terminal by design), or a
    // terminal state (`completed` / `skipped` / `expired` / `failed`).
    // `dismissed` never refires; non-recurring triggers never refire.
    //
    // Race safety: there is deliberately NO reopen-then-claim two-step here.
    // A pre-claim `persist(status = "scheduled")` is last-write-wins, so two
    // concurrent ticks could each reopen and one could claim the other's
    // reopen — double-fire. Instead the single atomic claim below CASes on
    // the `(status, firedAt)` pair this read observed
    // (see {@link ScheduledTaskClaimExpectation}); the winner rewrites
    // `firedAt`, which invalidates the loser's expectation even when both
    // observed the same status.
    const refireClaim =
      args?.allowTerminalRefire === true &&
      task.state.status !== "scheduled" &&
      task.state.status !== "dismissed" &&
      isRecurringTrigger(task.trigger);
    if (isTerminal(task.state.status) && !refireClaim) {
      // Idempotent — already settled; report skipped so callers do not
      // double-count this as a fresh fire.
      return {
        kind: "skipped",
        task,
        reason: `terminal:${task.state.status}`,
      };
    }
    if (refireClaim) {
      // Re-verify dueness on the FRESH row before claiming. The scheduler
      // tick evaluated dueness against a candidate row read at tick entry;
      // if a parallel tick already claimed this occurrence and fully
      // persisted before our read above, the CAS below would match the NEW
      // `(fired, firedAt)` pair and double-fire the same occurrence. A
      // just-refired row's trigger-derived next occurrence is in the future,
      // so the loser bails here as `raced` (no dispatch, no log noise).
      const ownerFacts = await deps.ownerFacts();
      const freshDecision = await isScheduledTaskDue(task, {
        now: now(),
        ownerFacts,
        anchors: deps.anchors,
      });
      if (!freshDecision.due) {
        return { kind: "raced", taskId: task.taskId };
      }
    }

    await logger.log(task.taskId, "fire_attempt", {
      detail: { eventPayload: args?.eventPayload ? "present" : "absent" },
    });

    // Global-pause check.
    const pause = await shouldDeferForGlobalPause(task);
    if (pause.paused) {
      task.state.status = "skipped";
      task.state.lastDecisionLog = pause.reason ?? "global_pause";
      await persist(task);
      await logger.log(task.taskId, "skipped", {
        reason: pause.reason ?? "global_pause",
      });
      return {
        kind: "skipped",
        task,
        reason: pause.reason ?? "global_pause",
      };
    }

    // Gate check.
    const gateOutcome = await evaluateGates(task);
    if (gateOutcome.decision.kind === "deny") {
      task.state.status = "skipped";
      task.state.lastDecisionLog = `${gateOutcome.gateKind ?? "gate"}: ${gateOutcome.decision.reason}`;
      await persist(task);
      await logger.log(task.taskId, "skipped", {
        reason: task.state.lastDecisionLog,
      });
      await settleTerminal(task, "skipped");
      return {
        kind: "skipped",
        task,
        reason: task.state.lastDecisionLog,
      };
    }
    if (gateOutcome.decision.kind === "defer") {
      const offset =
        "offsetMinutes" in gateOutcome.decision.until
          ? gateOutcome.decision.until.offsetMinutes
          : Math.max(
              1,
              Math.round(
                (new Date(gateOutcome.decision.until.atIso).getTime() -
                  now().getTime()) /
                  60_000,
              ),
            );
      task.state.lastDecisionLog = `${gateOutcome.gateKind ?? "gate"}: deferred ${offset}m (${gateOutcome.decision.reason})`;
      const newFireMs = now().getTime() + offset * 60_000;
      if (refireClaim) {
        // Park the deferred occurrence as a plain scheduled-override so it
        // fires AT the defer time (`scheduledOverrideDue`), not at the
        // trigger's next natural occurrence. This reopens the row from its
        // parked status; the write is last-write-wins across concurrent
        // ticks, which is safe here because both write the same target state
        // and no dispatch happens without the atomic claim below.
        task.state.status = "scheduled";
        delete task.state.acknowledgedAt;
        delete task.state.completedAt;
        clearEscalationCursor(task);
        clearPendingDispatch(task);
      }
      task.state.firedAt = new Date(newFireMs).toISOString();
      await persist(task);
      await logger.log(task.taskId, "snoozed", {
        reason: `gate-defer: ${gateOutcome.decision.reason}`,
        detail: { offsetMinutes: offset },
      });
      return {
        kind: "skipped",
        task,
        reason: `gate-defer:${gateOutcome.decision.reason}`,
      };
    }

    // Allow → atomic claim. For a fresh fire the store does UPDATE … WHERE
    // status='scheduled' RETURNING * so exactly one parallel caller can
    // transition `scheduled` → `fired`. For a recurrence refire the claim
    // CASes on the observed `(status, firedAt)` pair instead. Concurrent
    // ticks see `kind: "raced"` and bail.
    const fireAtIso = now().toISOString();
    const claim = await deps.store.claimForFire({
      taskId: task.taskId,
      firedAtIso: fireAtIso,
      ...(refireClaim
        ? {
            expected: {
              status: task.state.status,
              firedAtIso: task.state.firedAt ?? null,
            },
          }
        : {}),
    });
    if (claim.kind === "raced") {
      return { kind: "raced", taskId: task.taskId };
    }
    const claimed = claim.task;
    if (refireClaim) {
      // Fresh occurrence: drop the previous occurrence's response state and
      // any dispatch continuation — the new occurrence starts at the initial
      // channel with a clean ladder. Persisted below with the post-claim
      // metadata.
      delete claimed.state.acknowledgedAt;
      delete claimed.state.completedAt;
      clearEscalationCursor(claimed);
      clearPendingDispatch(claimed);
      await logger.log(claimed.taskId, "reopened", {
        reason: "recurrence refire",
      });
    }
    claimed.state.lastDecisionLog = "fired";
    // A pending continuation (retry / ladder advance from a previous typed
    // dispatch failure) routes this attempt through its recorded ladder
    // step; a fresh fire starts at the initial channel (cursor -1).
    const pending = readPendingDispatch(claimed);
    const ladder = resolveEffectiveLadder(claimed, deps.ladders);
    const pendingStep =
      pending && pending.stepIndex >= 0
        ? (ladder.steps[pending.stepIndex] ?? null)
        : null;
    setEscalationCursor(claimed, {
      stepIndex: pending?.stepIndex ?? -1,
      lastDispatchedAt: fireAtIso,
    });
    // Persist the post-claim metadata (escalationCursor, lastDecisionLog).
    // `persist` recomputes `next_fire_at` from the now-`fired` row.
    await persist(claimed);
    await logger.log(claimed.taskId, "fired");

    // Host-capability gate. If the host can't satisfy the task's profile,
    // rewrite the dispatch channel to `in_app` (notify-only) and record a
    // "substituted" log row. The substitution does not change the task's
    // status — it merely shifts the wire-out mechanism so a `bg-heavy-fgs`
    // task on iOS becomes a banner the user can tap.
    const hostCaps = deps.hostCapabilities?.() ?? ALL_PROFILES_AVAILABLE;
    const taskProfile =
      claimed.executionProfile ?? DEFAULT_TASK_EXECUTION_PROFILE;
    const substituted = !hostCaps.has(taskProfile);
    const dispatchChannelKey = substituted
      ? "in_app"
      : (pendingStep?.channelKey ?? pickChannelKey(claimed));
    if (substituted) {
      await logger.log(claimed.taskId, "substituted", {
        reason: "host_incapable",
        detail: {
          originalProfile: taskProfile,
          substituteProfile: "notify-only" satisfies TaskExecutionProfile,
          availableProfiles: Array.from(hostCaps),
        },
      });
    }

    let dispatchResult: DispatchResult | undefined;
    try {
      dispatchResult = await dispatcher.dispatch({
        taskId: claimed.taskId,
        firedAtIso: fireAtIso,
        channelKey: dispatchChannelKey,
        intensity: pendingStep?.intensity ?? pickIntensity(claimed),
        promptInstructions: claimed.promptInstructions,
        contextRequest: claimed.contextRequest,
        output: claimed.output,
        metadata: claimed.metadata,
      });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      return recordDispatchFailure(claimed, { error: wrapped });
    }

    if (dispatchResult) {
      claimed.metadata = {
        ...(claimed.metadata ?? {}),
        lastDispatchResult: dispatchResult,
      };
      if (dispatchResult.ok === false) {
        return applyDispatchPolicy({
          task: claimed,
          failure: dispatchResult,
          pending,
          ladder,
          fireAtIso,
        });
      }
      clearPendingDispatch(claimed);
      await persist(claimed);
    } else if (pending) {
      // Void dispatchers (e.g. notify-only event emitters) report no typed
      // result; a completed call is success, so drop the continuation.
      clearPendingDispatch(claimed);
      await persist(claimed);
    }
    return { kind: "fired", task: claimed };
  }

  /**
   * Enforce {@link decideDispatchPolicy} on a typed dispatch failure.
   *
   * Before this, an `{ ok: false }` DispatchResult was stashed in metadata
   * and the fire still reported `"fired"` — the user silently never received
   * the message and the documented retry/backoff/escalation policy was dead
   * code (#10721 H2).
   *
   * - `retry` → same step, bounded by {@link MAX_DISPATCH_RETRIES_PER_STEP};
   *   over budget it degrades to `advance` (or `fail` on the last step).
   * - `advance` / `surface_degraded` → next ladder step at its `delayMinutes`
   *   offset; `surface_degraded` additionally records
   *   `metadata.connectorDegradation` for the degradation provider.
   * - `fail` → terminal `"failed"`, `pipeline.onFail` fires.
   *
   * Retry/advance park the task back in `"scheduled"` with `state.firedAt` =
   * next attempt time — the scheduled-override the tick's due evaluation and
   * the `next_fire_at` index both honor.
   */
  async function applyDispatchPolicy(args: {
    task: ScheduledTask;
    failure: Extract<DispatchResult, { ok: false }>;
    pending: PendingDispatch | null;
    ladder: ReturnType<typeof resolveEffectiveLadder>;
    fireAtIso: string;
  }): Promise<ScheduledTaskFireResult> {
    const { task, failure, pending, ladder, fireAtIso } = args;
    // Policy step space: index 0 = the initial/default-channel attempt,
    // 1..n = ladder steps. `pending.stepIndex` is in ladder space (-1 =
    // initial attempt), hence the +1 shift.
    const ladderIndex = pending?.stepIndex ?? -1;
    const attempt = pending?.attempt ?? 0;
    const totalSteps = ladder.steps.length + 1;
    let decision = decideDispatchPolicy(failure, {
      currentStepIndex: ladderIndex + 1,
      totalSteps,
    });
    if (decision.kind === "retry" && attempt >= MAX_DISPATCH_RETRIES_PER_STEP) {
      // Retry budget for this step is exhausted — force the ladder forward.
      const isLastStep = ladderIndex + 1 >= totalSteps - 1;
      decision = isLastStep
        ? { kind: "fail", reason: failure.reason, message: failure.message }
        : { kind: "advance", reason: failure.reason, message: failure.message };
    }

    switch (decision.kind) {
      case "complete":
        // decideDispatchPolicy only returns `complete` for ok:true input.
        clearPendingDispatch(task);
        await persist(task);
        return { kind: "fired", task };
      case "retry": {
        const nextAttemptAtIso = new Date(
          Date.parse(fireAtIso) + decision.retryAfterMinutes * 60_000,
        ).toISOString();
        task.state.status = "scheduled";
        task.state.firedAt = nextAttemptAtIso;
        task.state.lastDecisionLog = `dispatch retry ${attempt + 1}/${MAX_DISPATCH_RETRIES_PER_STEP} in ${decision.retryAfterMinutes}m (${decision.reason})`;
        setPendingDispatch(task, {
          stepIndex: ladderIndex,
          attempt: attempt + 1,
        });
        await persist(task);
        await logger.log(task.taskId, "dispatch_retried", {
          reason: decision.reason,
          detail: {
            attempt: attempt + 1,
            maxAttempts: MAX_DISPATCH_RETRIES_PER_STEP,
            retryAfterMinutes: decision.retryAfterMinutes,
            nextAttemptAtIso,
          },
        });
        return {
          kind: "dispatch_deferred",
          task,
          reason: `retry:${decision.reason}`,
          nextAttemptAtIso,
        };
      }
      case "advance":
      case "surface_degraded": {
        const nextLadderIndex = ladderIndex + 1;
        const nextStep = ladder.steps[nextLadderIndex];
        if (!nextStep) {
          return failTerminal(task, decision.reason, decision.message);
        }
        const nextAttemptAtIso = new Date(
          Date.parse(fireAtIso) + nextStep.delayMinutes * 60_000,
        ).toISOString();
        task.state.status = "scheduled";
        task.state.firedAt = nextAttemptAtIso;
        task.state.lastDecisionLog = `dispatch advanced to ladder step ${nextLadderIndex} (${nextStep.channelKey}) after ${decision.reason}`;
        setPendingDispatch(task, { stepIndex: nextLadderIndex, attempt: 0 });
        if (decision.kind === "surface_degraded") {
          task.metadata = {
            ...(task.metadata ?? {}),
            connectorDegradation: {
              reason: decision.reason,
              message: decision.message,
              atIso: fireAtIso,
            },
          };
        }
        await persist(task);
        await logger.log(task.taskId, "escalated", {
          reason: `dispatch_failed:${decision.reason}`,
          detail: {
            nextStepIndex: nextLadderIndex,
            nextChannelKey: nextStep.channelKey,
            nextAttemptAtIso,
            degraded: decision.kind === "surface_degraded",
          },
        });
        return {
          kind: "dispatch_deferred",
          task,
          reason: `${decision.kind}:${decision.reason}`,
          nextAttemptAtIso,
        };
      }
      case "fail":
        return failTerminal(task, decision.reason, decision.message);
      default: {
        const _exhaustive: never = decision;
        throw new Error("applyDispatchPolicy: unreachable");
      }
    }
  }

  async function failTerminal(
    task: ScheduledTask,
    reason: string,
    message?: string,
  ): Promise<ScheduledTaskFireResult> {
    const detailMessage = message ? `${reason}: ${message}` : reason;
    task.state.status = "failed";
    task.state.lastDecisionLog = `dispatch_failed: ${detailMessage}`;
    clearPendingDispatch(task);
    task.metadata = {
      ...(task.metadata ?? {}),
      lastDispatchError: {
        name: "DispatchResultError",
        message: detailMessage,
      },
    };
    await persist(task);
    await logger.log(task.taskId, "failed", {
      reason: `dispatch_failed:${reason}`,
      detail: { message: detailMessage },
    });
    await settleTerminal(task, "failed");
    return {
      kind: "dispatch_failed",
      task,
      error: new Error(detailMessage),
    };
  }

  function pickChannelKey(task: ScheduledTask): string {
    if (
      task.output?.destination === "channel" &&
      typeof task.output.target === "string"
    ) {
      const [channelKey] = task.output.target.split(":", 1);
      if (channelKey) return channelKey;
    }
    if (task.escalation?.steps && task.escalation.steps.length > 0) {
      return task.escalation.steps[0]?.channelKey ?? "in_app";
    }
    // Priority does not currently influence default channel — the production
    // dispatcher always routes "in_app" through the event service. If
    // priority-based routing is added later, branch here.
    return "in_app";
  }

  function pickIntensity(task: ScheduledTask): "soft" | "normal" | "urgent" {
    if (task.priority === "high") return "urgent";
    if (task.priority === "medium") return "normal";
    return "soft";
  }

  async function evaluateCompletion(
    taskId: string,
    signal: { acknowledged?: boolean; repliedAtIso?: string },
  ): Promise<ScheduledTask> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`evaluateCompletion: task ${taskId} not found`);
    if (!task.completionCheck) return task;
    const contrib = deps.completionChecks.get(task.completionCheck.kind);
    if (!contrib) return task;
    const ownerFacts = await deps.ownerFacts();
    const ctx: CompletionCheckContext = {
      task,
      nowIso: now().toISOString(),
      ownerFacts,
      activity: deps.activity,
      subjectStore: deps.subjectStore,
      acknowledged: signal.acknowledged === true,
      repliedSinceFiredAt: signal.repliedAtIso
        ? { atIso: signal.repliedAtIso }
        : undefined,
    };
    const completed = await contrib.shouldComplete(task, ctx);
    if (!completed) return task;
    return applyComplete(task, { reason: `completion-check:${contrib.kind}` });
  }

  async function rolloverStateLog(opts?: { retentionDays?: number }) {
    const days = opts?.retentionDays ?? 90;
    const olderThanIso = new Date(
      now().getTime() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    return deps.logStore.rollupOlderThan({
      agentId: deps.agentId,
      olderThanIso,
    });
  }

  function inspectRegistries() {
    return {
      gates: deps.gates.list().map((g) => g.kind),
      completionChecks: deps.completionChecks.list().map((c) => c.kind),
      ladders: deps.ladders.list().map((l) => l.ladderKey),
      anchors: deps.anchors.list().map((a) => a.anchorKey),
      consolidationPolicies: deps.consolidation.list().map((p) => p.anchorKey),
    };
  }

  async function getEscalationCursor(
    taskId: string,
  ): Promise<EscalationCursorView | null> {
    const task = await deps.store.get(taskId);
    if (!task) return null;
    const raw = task.metadata?.escalationCursor;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const cursor = raw as { stepIndex?: unknown; lastDispatchedAt?: unknown };
    if (
      typeof cursor.stepIndex !== "number" ||
      typeof cursor.lastDispatchedAt !== "string"
    ) {
      return null;
    }
    const ladder = resolveEffectiveLadder(task, deps.ladders);
    const stepIndex = cursor.stepIndex;
    const channelKey =
      stepIndex >= 0 && stepIndex < ladder.steps.length
        ? (ladder.steps[stepIndex]?.channelKey ?? "in_app")
        : (ladder.steps[0]?.channelKey ?? "in_app");
    return {
      stepIndex,
      lastFiredAt: cursor.lastDispatchedAt,
      channelKey,
    };
  }

  return {
    schedule,
    list,
    apply,
    pipeline,
    fire,
    fireWithResult,
    evaluateCompletion,
    rolloverStateLog,
    inspectRegistries,
    getEscalationCursor,
  };
}
