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
import { createRuntimeScheduledTaskRunner } from "./runtime-wiring.js";
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
  const runner = createRuntimeScheduledTaskRunner({
    runtime: request.runtime,
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
  const tasks = await repo.listScheduledTasks(request.agentId, {
    status: [
      "scheduled",
      "fired",
      "acknowledged",
      "completed",
      "skipped",
      "expired",
      "failed",
    ],
  });
  const timeoutTaskIds = new Set<string>();

  for (const task of tasks) {
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

  for (const task of tasks) {
    if (timeoutTaskIds.has(task.taskId)) continue;
    if (result.fires.length + result.completionTimeouts.length >= limit) {
      break;
    }
    const decision = await isScheduledTaskDue(task, dueContext);
    if (!decision.due) continue;
    try {
      const fired = await runner.fire(task.taskId, {
        allowTerminalRefire: isRecurringTrigger(task.trigger),
      });
      const windowMetadata = markWindowFireIfNeeded(fired, dueContext);
      const persisted =
        windowMetadata !== null
          ? await runner.apply(fired.taskId, "edit", { metadata: windowMetadata })
          : fired;
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
          `[lifeops-scheduled-task] pending prompt record failed for ${task.taskId}: ${message}`,
        );
        result.errors.push({
          taskId: task.taskId,
          phase: "pending_prompt",
          message,
        });
      }
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
