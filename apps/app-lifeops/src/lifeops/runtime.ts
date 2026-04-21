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
}> {
  // Real dispatch runs unconditionally via `processScheduledWork` below.
  //
  // NOTE: This method previously also called `planJob(runtime, {
  //   jobKind: "meeting_reminder", snapshot: { now, scheduler } })` per tick
  // as "WS5 routing through the shared LLM planner". That call was a LARP:
  //   - `jobKind` was hardcoded to "meeting_reminder" regardless of context.
  //   - The snapshot carried only `{ now, scheduler }` — no pending
  //     occurrences, no calendar events, no overdue follow-ups.
  //   - The planner's returned `plan` was never used by
  //     `processScheduledWork`; the enqueue-if-sensitive path only ran when
  //     the LLM happened to return a sensitive action, which it couldn't
  //     meaningfully do given the empty snapshot.
  //   - Net effect: wasted LLM tokens per minute, zero influence on
  //     dispatch.
  //
  // When this scheduler wants real planner integration, the caller must
  // first build a populated `BackgroundJobContext.snapshot` with the
  // relevant state, and the plan must actually gate dispatch. Until that
  // happens, do NOT reintroduce the empty-snapshot call here — that would
  // just regress this fix.
  const now = resolveSchedulerNowIso(options);

  const service = new LifeOpsService(runtime);
  const scheduledWork = await service.processScheduledWork({ now });
  return {
    nextInterval: resolveLifeOpsTaskIntervalMs(runtime.agentId),
    now: scheduledWork.now,
    reminderAttempts: scheduledWork.reminderAttempts,
    workflowRuns: scheduledWork.workflowRuns,
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
          `[lifeops-scheduler] loadLifeOpsAppState failed; defaulting shouldRun=true (scheduler runs even though LifeOps toggle state is unknown): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return true;
      }
    },
    execute: async (rt, options) =>
      executeLifeOpsSchedulerTask(rt, isRecord(options) ? options : {}),
  });
}
