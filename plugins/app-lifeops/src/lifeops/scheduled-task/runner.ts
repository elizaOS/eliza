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
 */

import type { DispatchResult } from "../connectors/contract.js";
import type { CompletionCheckRegistry } from "./completion-check-registry.js";
import type {
  AnchorRegistry,
  ConsolidationRegistry,
} from "./consolidation-policy.js";
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

export interface ScheduledTaskStore {
  upsert(
    task: ScheduledTask,
    options?: ScheduledTaskUpsertOptions,
  ): Promise<void>;
  /**
   * Atomically transition a row from `state.status === "scheduled"` to
   * `"fired"`, returning the resulting row. Returns `{ kind: "raced" }`
   * when zero rows matched — either because the task is already past
   * `scheduled` (another tick claimed it) or the id no longer exists.
   *
   * The store is the only place where the read-mutate-write becomes
   * atomic; the runner's previous read-then-upsert pattern was racy
   * across parallel ticks. See `LifeOpsRepository.claimScheduledTaskForFire`.
   */
  claimForFire(args: {
    taskId: string;
    firedAtIso: string;
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
    async claimForFire({ taskId, firedAtIso }) {
      const existing = map.get(taskId);
      if (!existing || existing.state.status !== "scheduled") {
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
}

export interface ScheduledTaskDispatcher {
  dispatch(record: ScheduledTaskDispatchRecord): Promise<DispatchResult | void>;
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
  /** Override for tests. */
  newTaskId?: () => string;
  /** Override for tests. */
  now?: () => Date;
}

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
 * - `dispatch_failed` — the atomic claim succeeded and the row is in
 *   `"fired"` state, but the dispatcher threw. The runner has already
 *   persisted the `fired` row and a `fire_attempt` log line; the caller
 *   surfaces the error.
 */
export type ScheduledTaskFireResult =
  | { kind: "fired"; task: ScheduledTask }
  | { kind: "raced"; taskId: string }
  | { kind: "skipped"; task: ScheduledTask; reason: string }
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
    // Terminal-state rows do not refire (except recurring triggers that get
    // explicitly reopened via `fire({ allowTerminalRefire: true })`). Storing
    // a stale `next_fire_at` would leave the row in the partial-index slice
    // until the next mutation; clearing it keeps the index slim.
    if (isTerminal(task.state.status)) return null;
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
    await runPipeline(task, "skipped");
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
    await runPipeline(task, "completed");
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
  // Pipeline propagation
  // -------------------------------------------------------------------------

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
    // runner did not yet record), bring the parent's terminal state into
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
    return runPipeline(task, outcome);
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

  async function fireWithResult(
    taskId: string,
    args?: { eventPayload?: unknown; allowTerminalRefire?: boolean },
  ): Promise<ScheduledTaskFireResult> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`fire: task ${taskId} not found`);
    if (isTerminal(task.state.status)) {
      const canRefire =
        args?.allowTerminalRefire === true &&
        task.state.status !== "dismissed" &&
        isRecurringTrigger(task.trigger);
      if (!canRefire) {
        // Idempotent — already settled; report skipped so callers do not
        // double-count this as a fresh fire.
        return {
          kind: "skipped",
          task,
          reason: `terminal:${task.state.status}`,
        };
      }
      task.state.status = "scheduled";
      delete task.state.acknowledgedAt;
      delete task.state.completedAt;
      task.state.lastDecisionLog = "recurrence refire";
      clearEscalationCursor(task);
      // Flip the row back to `scheduled` so the atomic claim below has
      // something to match. The claim writes `firedAt` itself.
      await persist(task);
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
      await runPipeline(task, "skipped");
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

    // Allow → atomic claim. The store does UPDATE … WHERE status='scheduled'
    // RETURNING * so exactly one parallel caller can transition `scheduled`
    // → `fired`. Concurrent ticks see `kind: "raced"` and bail.
    const fireAtIso = now().toISOString();
    const claim = await deps.store.claimForFire({
      taskId: task.taskId,
      firedAtIso: fireAtIso,
    });
    if (claim.kind === "raced") {
      return { kind: "raced", taskId: task.taskId };
    }
    const claimed = claim.task;
    claimed.state.lastDecisionLog = "fired";
    setEscalationCursor(claimed, {
      stepIndex: -1,
      lastDispatchedAt: fireAtIso,
    });
    // Persist the post-claim metadata (escalationCursor, lastDecisionLog).
    // `persist` recomputes `next_fire_at` from the now-`fired` row.
    await persist(claimed);
    await logger.log(claimed.taskId, "fired");
    let dispatchResult: DispatchResult | void | undefined;
    try {
      dispatchResult = await dispatcher.dispatch({
        taskId: claimed.taskId,
        firedAtIso: fireAtIso,
        channelKey: pickChannelKey(claimed),
        intensity: pickIntensity(claimed),
        promptInstructions: claimed.promptInstructions,
        contextRequest: claimed.contextRequest,
        output: claimed.output,
      });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      return { kind: "dispatch_failed", task: claimed, error: wrapped };
    }
    if (dispatchResult) {
      claimed.metadata = {
        ...(claimed.metadata ?? {}),
        lastDispatchResult: dispatchResult,
      };
      await persist(claimed);
    }
    return { kind: "fired", task: claimed };
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
