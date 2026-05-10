import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { loadLifeOpsAppState } from "./app-state.js";
import {
  LIFEOPS_TASK_NAME,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";
import { LifeOpsService } from "./service.js";

export {
  ensureLifeOpsSchedulerTask,
  ensureRuntimeAgentRecord,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveSchedulerNowIso(
  options: Record<string, unknown>,
): string | undefined {
  const raw = options.now;
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
}

export async function executeLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
  options: Record<string, unknown> = {},
): Promise<{
  nextInterval: number;
  now: string;
  reminderAttempts: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >["reminderAttempts"];
  workflowRuns: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >["workflowRuns"];
  scheduledTaskFires: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >["scheduledTaskFires"];
  scheduledTaskCompletionTimeouts: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >["scheduledTaskCompletionTimeouts"];
}> {
  const now = resolveSchedulerNowIso(options);

  const service = new LifeOpsService(runtime);
  const scheduledWork = await service.processScheduledWork({ now });

  // Escalate any unacknowledged intents from desktop to mobile
  const { escalateUnacknowledgedIntents } = await import("./intent-sync.js");
  const escalationResult = await escalateUnacknowledgedIntents(runtime);
  if (escalationResult.escalated > 0) {
    logger.info(
      `[lifeops-scheduler] Escalated ${escalationResult.escalated} unacknowledged intent(s) to mobile.`,
    );
  }

  return {
    nextInterval: resolveLifeOpsTaskIntervalMs(runtime.agentId),
    now: scheduledWork.now,
    reminderAttempts: scheduledWork.reminderAttempts,
    workflowRuns: scheduledWork.workflowRuns,
    scheduledTaskFires: scheduledWork.scheduledTaskFires,
    scheduledTaskCompletionTimeouts:
      scheduledWork.scheduledTaskCompletionTimeouts,
  };
}

export function registerLifeOpsTaskWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(LIFEOPS_TASK_NAME)) {
    return;
  }
  runtime.registerTaskWorker({
    name: LIFEOPS_TASK_NAME,
    // Skip execution when the user has disabled LifeOps via the UI. The task
    // record and worker stay registered so toggling back on requires no
    // restart — cycles just become cheap no-ops while disabled.
    shouldRun: async (rt) => {
      try {
        const state = await loadLifeOpsAppState(rt as IAgentRuntime);
        return state.enabled;
      } catch (error) {
        logger.warn(
          `[lifeops-scheduler] loadLifeOpsAppState failed; skipping scheduler tick because LifeOps toggle state is unknown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
    execute: async (rt, options) =>
      executeLifeOpsSchedulerTask(rt, isRecord(options) ? options : {}),
  });
}
