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
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import {
  type RecordedPendingPrompt,
  resolvePendingPromptsStore,
} from "../pending-prompts/store.js";
import { LifeOpsRepository } from "../repository.js";
import { getScheduledTaskRunner } from "./service.js";

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
  const ownerFacts = ownerFactsToView(
    await resolveOwnerFactStore(request.runtime).read(),
  );
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
        const skipped = await runner.apply(task.taskId, "skip", {
          reason: timeout.reason,
        });
        result.completionTimeouts.push({
          taskId: skipped.taskId,
          status: skipped.state.status,
          reason: timeout.reason,
          occurrenceAtIso: timeout.occurrenceAtIso,
        });
        timeoutTaskIds.add(skipped.taskId);
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
