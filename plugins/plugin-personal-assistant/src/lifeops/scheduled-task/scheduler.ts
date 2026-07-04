/**
 * Core scheduled-task processor for the LifeOps family: given the persisted
 * ScheduledTask records, decides which are due, fires them, evaluates completion
 * checks and completion timeouts, advances recurrences, and emits pending
 * prompts — the structural heart of the "one clock, two consumers" design.
 *
 * Firing is decided entirely on the tasks' structural fields (trigger,
 * shouldFire, completionCheck, recurrence, due time), never on promptInstructions
 * text. The always-loaded scheduling plugin owns the runner service; this module
 * is the pure due/fire computation it drives.
 */
import { hasOwnerAccess } from "@elizaos/agent";
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type MessagePayload,
} from "@elizaos/core";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import {
  expectedReplyKindForTask,
  getAnchorRegistry,
  isCompletionTimeoutDue,
  isRecurringTrigger,
  isScheduledTaskDue,
  markWindowFireIfNeeded,
  pendingPromptRoomIdForTask,
} from "@elizaos/plugin-scheduling";
import {
  ownerFactsToView,
  type ReminderIntensity,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import {
  type RecordedPendingPrompt,
  resolvePendingPromptsStore,
} from "../pending-prompts/store.js";
import { LifeOpsRepository } from "../repository.js";
import { applyReminderIntensityToNoReplyPolicy } from "./no-reply-intensity.js";
import { getScheduledTaskRunner } from "./service.js";

type NoReplyTerminalStatus = "skipped" | "expired" | "failed";

interface NoReplyPolicy {
  maxRetries: number;
  retryCadenceMinutes: number[];
  terminalStatus: NoReplyTerminalStatus;
  terminalReason: string;
  sensitive: boolean;
  allowCrossChannel: boolean;
  allowNonOwnerNotification: boolean;
}

interface StoredNoReplyPolicy {
  maxRetries?: unknown;
  retryCadenceMinutes?: unknown;
  terminalStatus?: unknown;
  terminalReason?: unknown;
  sensitive?: unknown;
  allowCrossChannel?: unknown;
  allowNonOwnerNotification?: unknown;
}

interface NoReplyState {
  retryCount: number;
  lastTimedOutAt?: string;
  nextRetryAt?: string;
  terminalReason?: string;
  terminalOutcome?: string;
}

export interface ProcessDueScheduledTasksRequest {
  runtime: IAgentRuntime;
  agentId: string;
  now: Date;
  limit: number;
}

export interface ScheduledTaskFireResult {
  taskId: string;
  status: ScheduledTask["state"]["status"];
  reason: string;
  occurrenceAtIso?: string;
}

export interface ScheduledTaskProcessingError {
  taskId: string;
  phase: "fire" | "completion_check" | "completion_timeout" | "pending_prompt";
  message: string;
}

export interface ScheduledTaskCompletionResult {
  taskId: string;
  status: ScheduledTask["state"]["status"];
  reason: string;
  completionCheckKind: string;
}

export interface ProcessDueScheduledTasksResult {
  completions: ScheduledTaskCompletionResult[];
  fires: ScheduledTaskFireResult[];
  completionTimeouts: ScheduledTaskFireResult[];
  pendingPrompts: RecordedPendingPrompt[];
  errors: ScheduledTaskProcessingError[];
}

export interface ProcessScheduledTaskInboundMessageRequest {
  runtime: IAgentRuntime;
  agentId: string;
  message: Memory;
  now?: Date;
}

export interface ProcessScheduledTaskInboundMessageResult {
  completions: ScheduledTaskCompletionResult[];
  errors: ScheduledTaskProcessingError[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldRecordPendingPrompt(task: ScheduledTask): boolean {
  return (
    task.completionCheck?.kind === "user_replied_within" ||
    task.completionCheck?.kind === "user_acknowledged" ||
    task.kind === "approval"
  );
}

function isTickDrivenCompletionCheck(task: ScheduledTask): boolean {
  return (
    task.completionCheck?.kind === "subject_updated" ||
    task.completionCheck?.kind === "health_signal_observed"
  );
}

function isTerminalStatus(status: ScheduledTask["state"]["status"]): boolean {
  return (
    status === "completed" ||
    status === "skipped" ||
    status === "expired" ||
    status === "failed" ||
    status === "dismissed"
  );
}

function completionResult(task: ScheduledTask): ScheduledTaskCompletionResult {
  return {
    taskId: task.taskId,
    status: task.state.status,
    reason: task.state.lastDecisionLog ?? "completed",
    completionCheckKind: task.completionCheck?.kind ?? "unknown",
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function readPositiveIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (entry): entry is number =>
      typeof entry === "number" && Number.isInteger(entry) && entry > 0,
  );
  return out.length > 0 ? out : undefined;
}

function readNoReplyState(task: ScheduledTask): NoReplyState {
  const raw = readRecord(task.metadata?.noReplyState);
  return {
    retryCount: readPositiveInteger(raw?.retryCount) ?? 0,
    lastTimedOutAt:
      typeof raw?.lastTimedOutAt === "string" ? raw.lastTimedOutAt : undefined,
    nextRetryAt:
      typeof raw?.nextRetryAt === "string" ? raw.nextRetryAt : undefined,
    terminalReason:
      typeof raw?.terminalReason === "string" ? raw.terminalReason : undefined,
    terminalOutcome:
      typeof raw?.terminalOutcome === "string"
        ? raw.terminalOutcome
        : undefined,
  };
}

function defaultNoReplyPolicyFor(task: ScheduledTask): NoReplyPolicy | null {
  switch (task.kind) {
    case "reminder":
      return {
        maxRetries: 1,
        retryCadenceMinutes: [60],
        terminalStatus: "skipped",
        terminalReason: "no_reply_reminder_expired",
        sensitive: false,
        allowCrossChannel: false,
        allowNonOwnerNotification: false,
      };
    case "checkin":
      return {
        maxRetries: 1,
        retryCadenceMinutes: [24 * 60],
        terminalStatus: "expired",
        terminalReason: "no_reply_checkin_expired",
        sensitive: false,
        allowCrossChannel: false,
        allowNonOwnerNotification: false,
      };
    case "approval": {
      const metadata = task.metadata ?? {};
      const sensitive =
        metadata.sensitive === true ||
        metadata.privacyClass === "sensitive" ||
        metadata.privacyClass === "restricted" ||
        metadata.requiresApproval === true;
      return sensitive
        ? {
            maxRetries: 1,
            retryCadenceMinutes: [30],
            terminalStatus: "expired",
            terminalReason: "no_reply_sensitive_denied",
            sensitive: true,
            allowCrossChannel: false,
            allowNonOwnerNotification: false,
          }
        : {
            maxRetries: 2,
            retryCadenceMinutes: [30, 120],
            terminalStatus: "expired",
            terminalReason: "no_reply_approval_expired",
            sensitive: false,
            allowCrossChannel: false,
            allowNonOwnerNotification: false,
          };
    }
    default:
      return null;
  }
}

function resolveNoReplyPolicy(
  task: ScheduledTask,
  intensity?: ReminderIntensity,
): NoReplyPolicy | null {
  const defaultPolicy = defaultNoReplyPolicyFor(task);
  // Owner intensity shapes the DEFAULT ladder; an explicit per-task
  // `metadata.noReplyPolicy` override (merged below) still wins field-by-field.
  const base = defaultPolicy
    ? applyReminderIntensityToNoReplyPolicy(
        defaultPolicy,
        intensity,
        task.priority,
      )
    : null;
  const raw = readRecord(
    task.metadata?.noReplyPolicy,
  ) as StoredNoReplyPolicy | null;
  if (!base && !raw) return null;
  const fallback = base ?? {
    maxRetries: 0,
    retryCadenceMinutes: [],
    terminalStatus: "skipped" as const,
    terminalReason: "no_reply_timeout",
    sensitive: false,
    allowCrossChannel: false,
    allowNonOwnerNotification: false,
  };
  const terminalStatus =
    raw?.terminalStatus === "skipped" ||
    raw?.terminalStatus === "expired" ||
    raw?.terminalStatus === "failed"
      ? raw.terminalStatus
      : fallback.terminalStatus;
  return {
    maxRetries: readPositiveInteger(raw?.maxRetries) ?? fallback.maxRetries,
    retryCadenceMinutes:
      readPositiveIntegerArray(raw?.retryCadenceMinutes) ??
      fallback.retryCadenceMinutes,
    terminalStatus,
    terminalReason:
      typeof raw?.terminalReason === "string" && raw.terminalReason.length > 0
        ? raw.terminalReason
        : fallback.terminalReason,
    sensitive:
      typeof raw?.sensitive === "boolean" ? raw.sensitive : fallback.sensitive,
    allowCrossChannel:
      typeof raw?.allowCrossChannel === "boolean"
        ? raw.allowCrossChannel
        : fallback.allowCrossChannel,
    allowNonOwnerNotification:
      typeof raw?.allowNonOwnerNotification === "boolean"
        ? raw.allowNonOwnerNotification
        : fallback.allowNonOwnerNotification,
  };
}

function readMessageOccurredAt(message: Memory, fallback: Date): Date {
  return typeof message.createdAt === "number" &&
    Number.isFinite(message.createdAt)
    ? new Date(message.createdAt)
    : fallback;
}

async function recordPendingPromptIfNeeded(args: {
  runtime: IAgentRuntime;
  result: ScheduledTask;
}): Promise<RecordedPendingPrompt | null> {
  if (args.result.state.status !== "fired") return null;
  if (!shouldRecordPendingPrompt(args.result)) return null;
  const roomId = pendingPromptRoomIdForTask(args.result);
  if (!roomId || !args.result.state.firedAt) return null;
  const store = resolvePendingPromptsStore(args.runtime);
  return store.record({
    roomId,
    taskId: args.result.taskId,
    promptSnippet: args.result.promptInstructions,
    firedAt: args.result.state.firedAt,
    expectedReplyKind: expectedReplyKindForTask(args.result),
    expiresAt:
      typeof args.result.completionCheck?.followupAfterMinutes === "number"
        ? new Date(
            Date.parse(args.result.state.firedAt) +
              args.result.completionCheck.followupAfterMinutes * 60_000,
          ).toISOString()
        : undefined,
  });
}

export async function processDueScheduledTasks(
  request: ProcessDueScheduledTasksRequest,
): Promise<ProcessDueScheduledTasksResult> {
  const result: ProcessDueScheduledTasksResult = {
    completions: [],
    fires: [],
    completionTimeouts: [],
    pendingPrompts: [],
    errors: [],
  };
  const limit = Math.max(1, Math.floor(request.limit));
  const repo = new LifeOpsRepository(request.runtime);
  // The runner is constructed ONCE per runtime by ScheduledTaskRunnerService
  // (registered in plugin.ts). Reaching for it here every tick is O(map-get),
  // not the O(register-channels + build-registries) reconstruction the old
  // `createRuntimeScheduledTaskRunner` call did per minute.
  const runner = getScheduledTaskRunner(request.runtime, {
    agentId: request.agentId,
    now: () => request.now,
  });
  const ownerFactsRaw = await resolveOwnerFactStore(request.runtime).read();
  const ownerFacts = ownerFactsToView(ownerFactsRaw);
  // Owner-wide reminder intensity shapes how persistently the no-reply loop
  // re-nudges (see `applyReminderIntensityToNoReplyPolicy`).
  const reminderIntensity = ownerFactsRaw.reminderIntensity?.value;
  const dueContext = {
    now: request.now,
    ownerFacts,
    anchors: getAnchorRegistry(request.runtime),
  };
  // Indexed pass 1: due-to-fire candidates.
  //
  // The partial index `idx_life_scheduled_tasks_due` covers
  // `(agent_id, next_fire_at)` for every status except `dismissed`, so these
  // queries touch O(# due rows + # event-driven rows with NULL) instead of
  // every row owned by the agent. `next_fire_at IS NULL` rows are included
  // in the live slice so event / manual / after_task triggers (which
  // deliberately have no wall-clock fire time) still get a chance at
  // fire-time gates if they're invoked through another path. The
  // authoritative `isScheduledTaskDue` re-evaluates per task below.
  const nowIso = request.now.toISOString();
  const liveCandidates = await repo.listScheduledTasks(request.agentId, {
    status: ["scheduled", "fired"],
    dueAtOrBeforeIso: nowIso,
  });
  // Indexed pass 1b: recurrence-refire candidates. A RECURRING task parked in
  // `acknowledged` or a terminal-but-refirable status (`completed` /
  // `skipped` / `expired` / `failed` — never `dismissed`) keeps a
  // trigger-derived `next_fire_at` (see `resolveNextFireAt` in the runner);
  // once that next occurrence is due, the tick reopens it via the CAS refire
  // claim in `fireWithResult`. `requireNextFireAt` keeps this slice tight:
  // settled NON-recurring rows have `next_fire_at = NULL` and stay out, so
  // the scan does not grow with the agent's history of finished one-shots.
  const refireCandidates = await repo.listScheduledTasks(request.agentId, {
    status: ["acknowledged", "completed", "skipped", "expired", "failed"],
    dueAtOrBeforeIso: nowIso,
    requireNextFireAt: true,
  });
  // Status sets are disjoint, so a plain concat cannot double-list a task.
  const dueCandidates = [...liveCandidates, ...refireCandidates];
  // Indexed pass 2: completion-timeout candidates. These are rows that have
  // already fired (`status = 'fired'`) and have a `followupAfterMinutes` on
  // the completion-check. The partial index has them too because `fired` is
  // in the index predicate. `dueAtOrBeforeIso` is intentionally omitted —
  // a fired row's `next_fire_at` is NULL after the claim, so we filter by
  // `state.firedAt` in JS via `isCompletionTimeoutDue`.
  const timeoutCandidates = await repo.listScheduledTasks(request.agentId, {
    status: ["fired"],
  });
  const completedTaskIds = new Set<string>();
  const timeoutTaskIds = new Set<string>();

  for (const task of timeoutCandidates) {
    if (result.completions.length >= limit) {
      break;
    }
    if (!isTickDrivenCompletionCheck(task)) continue;
    try {
      const evaluated = await runner.evaluateCompletion(task.taskId, {});
      if (evaluated.state.status === "completed") {
        result.completions.push(completionResult(evaluated));
        completedTaskIds.add(evaluated.taskId);
      }
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(
        `[lifeops-scheduled-task] completion check failed for ${task.taskId}: ${message}`,
      );
      result.errors.push({
        taskId: task.taskId,
        phase: "completion_check",
        message,
      });
    }
  }

  // Each pass gets its OWN budget of `limit`, not a shared one. A shared
  // budget lets a burst of completion-timeouts (this pass) consume the whole
  // tick and starve every user-facing due fire (the pass below) — a dropped
  // reminder / mobile notification. Independent counters cost at most ~2x
  // cheap indexed DB ops in a pathological burst and guarantee the due-fire
  // pass always gets its full `limit`.
  for (const task of timeoutCandidates) {
    if (completedTaskIds.has(task.taskId)) continue;
    if (result.completionTimeouts.length >= limit) {
      break;
    }
    const timeout = isCompletionTimeoutDue(task, request.now);
    if (timeout.due) {
      try {
        const timedOut = await handleCompletionTimeout({
          repo,
          runner,
          agentId: request.agentId,
          task,
          reminderIntensity,
          now: request.now,
          reason: timeout.reason,
        });
        result.completionTimeouts.push({
          taskId: timedOut.task.taskId,
          status: timedOut.task.state.status,
          reason: timedOut.reason,
          occurrenceAtIso: timeout.occurrenceAtIso,
        });
        timeoutTaskIds.add(timedOut.task.taskId);
      } catch (error) {
        const message = errorMessage(error);
        logger.warn(
          `[lifeops-scheduled-task] completion timeout failed for ${task.taskId}: ${message}`,
        );
        result.errors.push({
          taskId: task.taskId,
          phase: "completion_timeout",
          message,
        });
      }
    }
  }

  for (const task of dueCandidates) {
    if (completedTaskIds.has(task.taskId)) continue;
    if (timeoutTaskIds.has(task.taskId)) continue;
    if (result.fires.length >= limit) {
      break;
    }
    const decision = await isScheduledTaskDue(task, dueContext);
    if (!decision.due) continue;
    try {
      const fireResult = await runner.fireWithResult(task.taskId, {
        allowTerminalRefire: isRecurringTrigger(task.trigger),
      });
      const fired = await handleFireResult({
        request,
        repo,
        fireResult,
        decision,
        dueContext,
        result,
      });
      if (!fired) continue;
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(
        `[lifeops-scheduled-task] fire failed for ${task.taskId}: ${message}`,
      );
      result.errors.push({ taskId: task.taskId, phase: "fire", message });
    }
  }

  return result;
}

async function handleCompletionTimeout(args: {
  repo: LifeOpsRepository;
  runner: ReturnType<typeof getScheduledTaskRunner>;
  agentId: string;
  task: ScheduledTask;
  now: Date;
  reason: string;
  reminderIntensity?: ReminderIntensity;
}): Promise<{ task: ScheduledTask; reason: string }> {
  const policy = resolveNoReplyPolicy(args.task, args.reminderIntensity);
  if (!policy) {
    const skipped = await args.runner.apply(args.task.taskId, "skip", {
      reason: args.reason,
    });
    return { task: skipped, reason: args.reason };
  }

  const state = readNoReplyState(args.task);
  if (state.retryCount < policy.maxRetries) {
    const cadenceIndex = Math.min(
      state.retryCount,
      Math.max(0, policy.retryCadenceMinutes.length - 1),
    );
    const retryMinutes = policy.retryCadenceMinutes[cadenceIndex] ?? 60;
    const nextRetryAt = new Date(
      args.now.getTime() + retryMinutes * 60_000,
    ).toISOString();
    args.task.metadata = {
      ...(args.task.metadata ?? {}),
      noReplyPolicy: {
        ...(readRecord(args.task.metadata?.noReplyPolicy) ?? {}),
        maxRetries: policy.maxRetries,
        retryCadenceMinutes: policy.retryCadenceMinutes,
        terminalStatus: policy.terminalStatus,
        terminalReason: policy.terminalReason,
        sensitive: policy.sensitive,
        allowCrossChannel: policy.allowCrossChannel,
        allowNonOwnerNotification: policy.allowNonOwnerNotification,
      },
      noReplyState: {
        retryCount: state.retryCount + 1,
        lastTimedOutAt: args.now.toISOString(),
        nextRetryAt,
      },
    };
    await args.repo.upsertScheduledTask(args.agentId, args.task);
    const snoozed = await args.runner.apply(args.task.taskId, "snooze", {
      untilIso: nextRetryAt,
    });
    snoozed.trigger = { kind: "once", atIso: nextRetryAt };
    delete snoozed.state.firedAt;
    snoozed.state.lastDecisionLog = `no_reply_retry_${state.retryCount + 1}: ${args.reason}`;
    await args.repo.upsertScheduledTask(args.agentId, snoozed);
    return {
      task: snoozed,
      reason: `no_reply_retry_${state.retryCount + 1}`,
    };
  }

  args.task.metadata = {
    ...(args.task.metadata ?? {}),
    noReplyPolicy: {
      ...(readRecord(args.task.metadata?.noReplyPolicy) ?? {}),
      maxRetries: policy.maxRetries,
      retryCadenceMinutes: policy.retryCadenceMinutes,
      terminalStatus: policy.terminalStatus,
      terminalReason: policy.terminalReason,
      sensitive: policy.sensitive,
      allowCrossChannel: policy.allowCrossChannel,
      allowNonOwnerNotification: policy.allowNonOwnerNotification,
    },
    noReplyState: {
      ...state,
      lastTimedOutAt: args.now.toISOString(),
      terminalReason: policy.terminalReason,
      terminalOutcome: policy.sensitive ? "denied" : policy.terminalStatus,
    },
  };
  await args.repo.upsertScheduledTask(args.agentId, args.task);

  if (policy.terminalStatus === "skipped") {
    const skipped = await args.runner.apply(args.task.taskId, "skip", {
      reason: policy.terminalReason,
    });
    return { task: skipped, reason: policy.terminalReason };
  }
  const settled = await args.runner.pipeline(
    args.task.taskId,
    policy.terminalStatus,
  );
  const terminal =
    (await args.repo.getScheduledTask(args.agentId, args.task.taskId)) ??
    settled[0] ??
    args.task;
  terminal.state.lastDecisionLog = policy.terminalReason;
  await args.repo.upsertScheduledTask(args.agentId, terminal);
  return { task: terminal, reason: policy.terminalReason };
}

export async function processScheduledTaskInboundMessage(
  request: ProcessScheduledTaskInboundMessageRequest,
): Promise<ProcessScheduledTaskInboundMessageResult> {
  const result: ProcessScheduledTaskInboundMessageResult = {
    completions: [],
    errors: [],
  };
  const roomId =
    typeof request.message.roomId === "string" &&
    request.message.roomId.length > 0
      ? request.message.roomId
      : null;
  if (!roomId) return result;
  if (request.message.entityId === request.agentId) return result;
  if (!(await hasOwnerAccess(request.runtime, request.message))) return result;

  const now = request.now ?? readMessageOccurredAt(request.message, new Date());
  const repliedAtIso = now.toISOString();
  const promptStore = resolvePendingPromptsStore(request.runtime);
  const prompts = await promptStore.list(roomId, { now });
  if (prompts.length === 0) return result;

  const repo = new LifeOpsRepository(request.runtime);
  const runner = getScheduledTaskRunner(request.runtime, {
    agentId: request.agentId,
    now: () => now,
  });

  for (const prompt of prompts) {
    try {
      const task = await repo.getScheduledTask(request.agentId, prompt.taskId);
      if (!task) {
        await promptStore.resolve(roomId, prompt.taskId);
        continue;
      }
      if (
        isTerminalStatus(task.state.status) ||
        task.state.status !== "fired"
      ) {
        await promptStore.resolve(roomId, prompt.taskId);
        continue;
      }
      if (task.completionCheck?.kind !== "user_replied_within") {
        continue;
      }
      const evaluated = await runner.evaluateCompletion(task.taskId, {
        repliedAtIso,
      });
      if (evaluated.state.status === "completed") {
        result.completions.push(completionResult(evaluated));
        await promptStore.resolve(roomId, prompt.taskId);
      }
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(
        `[lifeops-scheduled-task] inbound completion check failed for ${prompt.taskId}: ${message}`,
      );
      result.errors.push({
        taskId: prompt.taskId,
        phase: "completion_check",
        message,
      });
    }
  }

  return result;
}

export async function handleScheduledTaskInboundMessage(
  payload: MessagePayload,
): Promise<void> {
  try {
    const runtime = payload.runtime;
    if (!runtime || !payload.message) return;
    const result = await processScheduledTaskInboundMessage({
      runtime,
      agentId: runtime.agentId,
      message: payload.message,
    });
    if (result.completions.length > 0) {
      logger.info(
        {
          src: "lifeops:scheduled-task",
          agentId: runtime.agentId,
          taskIds: result.completions.map((entry) => entry.taskId),
        },
        "[lifeops-scheduled-task] Completed fired scheduled task(s) from owner inbound reply",
      );
    }
  } catch (error) {
    logger.warn(
      {
        src: "lifeops:scheduled-task",
        error,
      },
      "[lifeops-scheduled-task] Inbound completion handler failed",
    );
  }
}

/**
 * Branch on the `ScheduledTaskFireResult` discriminated union and record the
 * outcome into the tick result. Returns `true` when the result counted as a
 * fire (so the caller knows it consumed a slot), `false` otherwise.
 */
async function handleFireResult(args: {
  request: ProcessDueScheduledTasksRequest;
  repo: LifeOpsRepository;
  fireResult: import("@elizaos/plugin-scheduling").ScheduledTaskFireResult;
  decision: import("@elizaos/plugin-scheduling").ScheduledTaskDueDecision;
  dueContext: import("@elizaos/plugin-scheduling").ScheduledTaskDueContext;
  result: ProcessDueScheduledTasksResult;
}): Promise<boolean> {
  const { request, fireResult, decision, dueContext, result } = args;
  switch (fireResult.kind) {
    case "raced": {
      // Another tick atomically claimed this row first. Nothing to record —
      // the winning tick will publish its own fire event. Surfacing this as
      // an error would double-count; surfacing as a fire would double-bill.
      return false;
    }
    case "skipped": {
      // Gate denial / global-pause / terminal-non-recurring etc. Recorded so
      // observers see the task was visited and chose not to dispatch.
      result.fires.push({
        taskId: fireResult.task.taskId,
        status: fireResult.task.state.status,
        reason: fireResult.reason || decision.reason,
        occurrenceAtIso: decision.occurrenceAtIso,
      });
      return true;
    }
    case "dispatch_deferred": {
      // Typed connector failure; the runner parked the task back in
      // `scheduled` with a retry/escalation continuation. Recorded as a
      // visited fire so observers see the attempt + the policy decision,
      // without claiming anything reached the user.
      result.fires.push({
        taskId: fireResult.task.taskId,
        status: fireResult.task.state.status,
        reason: fireResult.reason,
        occurrenceAtIso: fireResult.nextAttemptAtIso,
      });
      return true;
    }
    case "dispatch_failed": {
      result.errors.push({
        taskId: fireResult.task.taskId,
        phase: "fire",
        message: fireResult.error.message,
      });
      return true;
    }
    case "fired": {
      const windowMetadata = markWindowFireIfNeeded(
        fireResult.task,
        dueContext,
      );
      // Service singleton — same instance the scheduler grabbed at the top.
      const runner = getScheduledTaskRunner(request.runtime, {
        agentId: request.agentId,
        now: () => request.now,
      });
      const persisted =
        windowMetadata !== null
          ? await runner.apply(fireResult.task.taskId, "edit", {
              metadata: windowMetadata,
            })
          : fireResult.task;
      result.fires.push({
        taskId: persisted.taskId,
        status: persisted.state.status,
        reason: decision.reason,
        occurrenceAtIso: decision.occurrenceAtIso,
      });
      try {
        const recorded = await recordPendingPromptIfNeeded({
          runtime: request.runtime,
          result: persisted,
        });
        if (recorded) result.pendingPrompts.push(recorded);
      } catch (error) {
        const message = errorMessage(error);
        logger.warn(
          `[lifeops-scheduled-task] pending prompt record failed for ${fireResult.task.taskId}: ${message}`,
        );
        result.errors.push({
          taskId: fireResult.task.taskId,
          phase: "pending_prompt",
          message,
        });
      }
      return true;
    }
    default: {
      const _exhaustive: never = fireResult;
      return false;
    }
  }
}
