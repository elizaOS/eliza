import { logger, type IAgentRuntime } from "@elizaos/core";

import {
  ownerFactsToView,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { getAnchorRegistry } from "../registries/anchor-registry.js";
import { LifeOpsRepository } from "../repository.js";
import {
  createPendingPromptsStore,
  type RecordedPendingPrompt,
} from "../pending-prompts/store.js";
import {
  expectedReplyKindForTask,
  isCompletionTimeoutDue,
  isRecurringTrigger,
  isScheduledTaskDue,
  markWindowFireIfNeeded,
  pendingPromptRoomIdForTask,
} from "./due.js";
import { getScheduledTaskRunner } from "./service.js";
import type { ScheduledTask } from "./types.js";

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
  phase: "fire" | "completion_timeout" | "pending_prompt";
  message: string;
}

export interface ProcessDueScheduledTasksResult {
  fires: ScheduledTaskFireResult[];
  completionTimeouts: ScheduledTaskFireResult[];
  pendingPrompts: RecordedPendingPrompt[];
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

async function recordPendingPromptIfNeeded(args: {
  runtime: IAgentRuntime;
  result: ScheduledTask;
}): Promise<RecordedPendingPrompt | null> {
  if (args.result.state.status !== "fired") return null;
  if (!shouldRecordPendingPrompt(args.result)) return null;
  const roomId = pendingPromptRoomIdForTask(args.result);
  if (!roomId || !args.result.state.firedAt) return null;
  const store = createPendingPromptsStore(args.runtime);
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
  // `(agent_id, next_fire_at) WHERE state_json->>'status' IN ('scheduled','fired')`,
  // so this query touches O(# due rows + # event-driven rows with NULL)
  // instead of every row owned by the agent. `next_fire_at IS NULL` rows are
  // included so event / manual / after_task triggers (which deliberately
  // have no wall-clock fire time) still get a chance at fire-time gates if
  // they're invoked through another path. The authoritative
  // `isScheduledTaskDue` re-evaluates per task below.
  const nowIso = request.now.toISOString();
  const dueCandidates = await repo.listScheduledTasks(request.agentId, {
    status: ["scheduled", "fired"],
    dueAtOrBeforeIso: nowIso,
  });
  // Indexed pass 2: completion-timeout candidates. These are rows that have
  // already fired (`status = 'fired'`) and have a `followupAfterMinutes` on
  // the completion-check. The partial index has them too because `fired` is
  // in the index predicate. `dueAtOrBeforeIso` is intentionally omitted —
  // a fired row's `next_fire_at` is NULL after the claim, so we filter by
  // `state.firedAt` in JS via `isCompletionTimeoutDue`.
  const timeoutCandidates = await repo.listScheduledTasks(request.agentId, {
    status: ["fired"],
  });
  const timeoutTaskIds = new Set<string>();

  for (const task of timeoutCandidates) {
    if (result.fires.length + result.completionTimeouts.length >= limit) {
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
    if (timeoutTaskIds.has(task.taskId)) continue;
    if (result.fires.length + result.completionTimeouts.length >= limit) {
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

/**
 * Branch on the `ScheduledTaskFireResult` discriminated union and record the
 * outcome into the tick result. Returns `true` when the result counted as a
 * fire (so the caller knows it consumed a slot), `false` otherwise.
 */
async function handleFireResult(args: {
  request: ProcessDueScheduledTasksRequest;
  repo: LifeOpsRepository;
  fireResult: import("./runner.js").ScheduledTaskFireResult;
  decision: import("./due.js").ScheduledTaskDueDecision;
  dueContext: import("./due.js").ScheduledTaskDueContext;
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
