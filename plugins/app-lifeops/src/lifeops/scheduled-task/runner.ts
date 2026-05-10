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

import type { CompletionCheckRegistry } from "./completion-check-registry.js";
import type {
  AnchorRegistry,
  ConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  type EscalationLadderRegistry,
  resetLadderForSnooze,
} from "./escalation.js";
import type { TaskGateRegistry } from "./gate-registry.js";
import { createStateLogger, type ScheduledTaskLogStore } from "./state-log.js";
import type {
  ActivitySignalBusView,
  CompletionCheckContext,
  GateDecision,
  GateEvaluationContext,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskFilter,
  ScheduledTaskRef,
  ScheduledTaskRunner,
  ScheduledTaskState,
  ScheduledTaskVerb,
  SubjectStoreView,
  TerminalState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Store interface — DB-backed in production; in-memory in unit tests.
// ---------------------------------------------------------------------------

export interface ScheduledTaskStore {
  upsert(task: ScheduledTask): Promise<void>;
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

// ---------------------------------------------------------------------------
// Dispatcher (channel-side egress is owned by the channel registry; we only
// emit a describe-it record here so the runner is testable in isolation).
// ---------------------------------------------------------------------------

export interface ScheduledTaskDispatchRecord {
  taskId: string;
  firedAtIso: string;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
  promptInstructions: string;
  contextRequest: ScheduledTask["contextRequest"];
  consolidationBatchId?: string;
}

export interface ScheduledTaskDispatcher {
  dispatch(record: ScheduledTaskDispatchRecord): Promise<void>;
}

export const NoopScheduledTaskDispatcher: ScheduledTaskDispatcher = {
  async dispatch() {
    /* intentional no-op (Wave 1 default) */
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
  dispatcher?: ScheduledTaskDispatcher;
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

function asEscalationCursor(task: ScheduledTask): {
  stepIndex: number;
  lastDispatchedAt: string;
} {
  // The runner persists escalation cursor inside metadata under a
  // reserved key. The cursor is opaque to other consumers.
  const cursor = (task.metadata?.escalationCursor ?? null) as {
    stepIndex?: number;
    lastDispatchedAt?: string;
  } | null;
  return {
    stepIndex: typeof cursor?.stepIndex === "number" ? cursor.stepIndex : -1,
    lastDispatchedAt:
      typeof cursor?.lastDispatchedAt === "string"
        ? cursor.lastDispatchedAt
        : (task.state.firedAt ?? new Date().toISOString()),
  };
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

export interface ScheduledTaskRunnerExtras {
  /**
   * Drive a single fire-attempt for a task. Used by the scheduler tick;
   * exposed for tests so we can assert behavior deterministically without
   * waiting on a real timer.
   */
  fire(
    taskId: string,
    args?: { eventPayload?: unknown },
  ): Promise<ScheduledTask>;
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
}

export interface ScheduledTaskRunnerHandle
  extends ScheduledTaskRunner,
    ScheduledTaskRunnerExtras {}

export function createScheduledTaskRunner(
  deps: ScheduledTaskRunnerDeps,
): ScheduledTaskRunnerHandle {
  const newTaskId = deps.newTaskId ?? defaultTaskIdGenerator;
  const now = deps.now ?? (() => new Date());
  const dispatcher = deps.dispatcher ?? NoopScheduledTaskDispatcher;
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
      const lastDeny = decisions.reverse().find((d) => d.decision.kind === "deny");
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
    const pause = await deps.globalPause.current();
    if (!pause.active) return { paused: false };
    return {
      paused: true,
      reason: pause.reason ? `global_pause: ${pause.reason}` : "global_pause",
    };
  }

  async function persist(task: ScheduledTask): Promise<ScheduledTask> {
    await deps.store.upsert(task);
    return structuredClone(task);
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
    const initialState: ScheduledTaskState = {
      status: "scheduled",
      followupCount: 0,
    };
    // Validation: pipeline.onSkip vs followupAfterMinutes — we keep both
    // fields if set but record the resolution rule on creation so the
    // state log shows the operator decision.
    const task: ScheduledTask = {
      taskId: newTaskId(),
      ...input,
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

  async function list(
    filter?: ScheduledTaskFilter,
  ): Promise<ScheduledTask[]> {
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

  async function applyAcknowledge(
    task: ScheduledTask,
  ): Promise<ScheduledTask> {
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
    return runPipeline(task, outcome);
  }

  // -------------------------------------------------------------------------
  // Fire / evaluate completion
  // -------------------------------------------------------------------------

  async function fire(
    taskId: string,
    args?: { eventPayload?: unknown },
  ): Promise<ScheduledTask> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`fire: task ${taskId} not found`);
    if (isTerminal(task.state.status)) {
      // Idempotent — already settled; return unchanged.
      return task;
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
      return task;
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
      return task;
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
      return task;
    }

    // Allow → dispatch.
    const fireAtIso = now().toISOString();
    task.state.status = "fired";
    task.state.firedAt = fireAtIso;
    task.state.lastDecisionLog = "fired";
    setEscalationCursor(task, {
      stepIndex: -1,
      lastDispatchedAt: fireAtIso,
    });
    await persist(task);
    await logger.log(task.taskId, "fired");
    await dispatcher.dispatch({
      taskId: task.taskId,
      firedAtIso: fireAtIso,
      channelKey: pickChannelKey(task),
      intensity: pickIntensity(task),
      promptInstructions: task.promptInstructions,
      contextRequest: task.contextRequest,
    });
    return task;
  }

  function pickChannelKey(task: ScheduledTask): string {
    if (task.escalation?.steps && task.escalation.steps.length > 0) {
      return task.escalation.steps[0]?.channelKey ?? "in_app";
    }
    if (task.priority === "high") return "in_app";
    if (task.priority === "medium") return "in_app";
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

  return {
    schedule,
    list,
    apply,
    pipeline,
    fire,
    evaluateCompletion,
    rolloverStateLog,
    inspectRegistries,
  };
}
