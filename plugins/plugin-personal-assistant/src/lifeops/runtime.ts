/**
 * LifeOps runtime wiring: constructs the composed LifeOpsService, ensures the
 * agent record and the LifeOps scheduler task exist, and re-exports the
 * scheduler-task helpers callers use to bootstrap the plugin at init.
 */
import { resolveOwnerEntityId } from "@elizaos/agent";
import type { IAgentRuntime, TaskWorker } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { loadLifeOpsAppState } from "./app-state.js";
import type { HouseholdGrantExpiryWarningReceipt } from "./household/grant-expiry-warning.js";
import {
  DEFAULT_SCHEDULED_TASK_PROCESS_LIMIT,
  processDueScheduledTasks,
} from "./scheduled-task/scheduler.js";
import {
  isMissingLifeOpsRelationError,
  LIFEOPS_TASK_NAME,
  rerunLifeOpsPluginMigrations,
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
  subsystemFailures: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >["subsystemFailures"];
  householdGrantWarningReceipts: HouseholdGrantExpiryWarningReceipt[];
}> {
  const now = resolveSchedulerNowIso(options);
  const scheduledWorkOptions = {
    now,
    ...(typeof options.reminderLimit === "number"
      ? { reminderLimit: options.reminderLimit }
      : {}),
    ...(typeof options.workflowLimit === "number"
      ? { workflowLimit: options.workflowLimit }
      : {}),
    ...(typeof options.scheduledTaskLimit === "number"
      ? { scheduledTaskLimit: options.scheduledTaskLimit }
      : {}),
    ...(typeof options.sleepCycleCheckins === "boolean"
      ? { sleepCycleCheckins: options.sleepCycleCheckins }
      : {}),
  };

  const ownerEntityId = await resolveOwnerEntityId(runtime);
  const service = new LifeOpsService(
    runtime,
    ownerEntityId ? { ownerEntityId } : {},
  );
  let scheduledWork: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >;
  try {
    scheduledWork = await service.processScheduledWork(scheduledWorkOptions);
  } catch (error) {
    // A persisted scheduler task can fire from the task queue on restart
    // before this plugin's schema migration finishes. Run migrations once
    // and retry rather than dropping the tick.
    if (!isMissingLifeOpsRelationError(error)) {
      throw error;
    }
    logger.warn(
      "[lifeops-scheduler] LifeOps schema not ready; running plugin migrations and retrying tick",
    );
    await rerunLifeOpsPluginMigrations(runtime);
    scheduledWork = await service.processScheduledWork(scheduledWorkOptions);
  }

  // Escalate any unacknowledged intents from desktop to mobile. Isolated so
  // an escalation failure cannot fail the whole tick (which would feed the
  // core failure ladder even though the scheduled work already completed).
  try {
    const { escalateUnacknowledgedIntents } = await import("./intent-sync.js");
    const escalationResult = await escalateUnacknowledgedIntents(runtime);
    if (escalationResult.escalated > 0) {
      logger.info(
        `[lifeops-scheduler] Escalated ${escalationResult.escalated} unacknowledged intent(s) to mobile.`,
      );
    }
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error : undefined },
      `[lifeops-scheduler] intent escalation failed; continuing tick: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let householdGrantWarningReceipts: HouseholdGrantExpiryWarningReceipt[] = [];
  const subsystemFailures = [...scheduledWork.subsystemFailures];
  if (!ownerEntityId) {
    const error = new ElizaError("LifeOps scheduler owner is unavailable", {
      code: "LIFEOPS_SCHEDULER_OWNER_UNAVAILABLE",
      context: { agentId: runtime.agentId },
    });
    runtime.reportError("LifeOpsScheduler.owner", error);
    subsystemFailures.push({ subsystem: "owner", error: error.message });
  }
  try {
    const {
      createHouseholdCoordinationService,
      getHouseholdCoordinationService,
    } = await import("./household/service.js");
    const household =
      getHouseholdCoordinationService(runtime) ??
      createHouseholdCoordinationService(runtime);
    householdGrantWarningReceipts =
      await household.reconcileGrantExpiryWarnings();
  } catch (error) {
    // error-policy:J7 this runs inside the existing LifeOps scheduler tick.
    // The durable outbox remains pending and the next tick retries it; the
    // failure is also returned alongside the other isolated subsystems.
    runtime.reportError("LifeOpsScheduler.householdGrantWarnings", error, {
      recovery: "next_lifeops_scheduler_tick",
    });
    subsystemFailures.push({
      subsystem: "household_grant_warnings",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    nextInterval: resolveLifeOpsTaskIntervalMs(runtime.agentId),
    now: scheduledWork.now,
    reminderAttempts: scheduledWork.reminderAttempts,
    workflowRuns: scheduledWork.workflowRuns,
    scheduledTaskFires: scheduledWork.scheduledTaskFires,
    scheduledTaskCompletionTimeouts:
      scheduledWork.scheduledTaskCompletionTimeouts,
    subsystemFailures,
    householdGrantWarningReceipts,
  };
}

/** Runs only the production reminder-delivery processor for focused harnesses. */
export async function executeLifeOpsReminderTask(
  runtime: IAgentRuntime,
  options: { now?: string; limit?: number } = {},
): Promise<Awaited<ReturnType<LifeOpsService["processReminders"]>>> {
  const ownerEntityId = await resolveOwnerEntityId(runtime);
  if (!ownerEntityId) {
    throw new ElizaError("Configure an owner before running owner reminders", {
      code: "LIFEOPS_REMINDER_OWNER_UNAVAILABLE",
      context: { agentId: runtime.agentId },
    });
  }
  const service = new LifeOpsService(runtime, { ownerEntityId });
  const request = { ...options, scope: "definitions" as const };
  try {
    return await service.processReminders(request);
  } catch (error) {
    // The focused entrypoint can be the first LifeOps work invoked after
    // startup, so it preserves the scheduler worker's migration retry.
    if (!isMissingLifeOpsRelationError(error)) {
      throw error;
    }
    logger.warn(
      "[lifeops-reminders] LifeOps schema not ready; running plugin migrations and retrying reminder tick",
    );
    await rerunLifeOpsPluginMigrations(runtime);
    return service.processReminders(request);
  }
}

async function executeReminderHostTick(
  runtime: IAgentRuntime,
  options: Record<string, unknown>,
) {
  const now = resolveSchedulerNowIso(options) ?? new Date().toISOString();
  const limit =
    options.scheduledTaskLimit ?? DEFAULT_SCHEDULED_TASK_PROCESS_LIMIT;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ElizaError("scheduledTaskLimit must be a positive integer", {
      code: "LIFEOPS_SCHEDULED_TASK_LIMIT_INVALID",
      context: { agentId: runtime.agentId },
    });
  }
  const reminders = await executeLifeOpsReminderTask(runtime, {
    now,
    ...(typeof options.reminderLimit === "number"
      ? { limit: options.reminderLimit }
      : {}),
  });
  const scheduledTasks = await processDueScheduledTasks({
    runtime,
    agentId: runtime.agentId,
    now: new Date(now),
    limit,
  });
  return {
    ...reminders,
    scheduledTasks,
    nextInterval: resolveLifeOpsTaskIntervalMs(runtime.agentId),
  };
}

type LifeOpsWorkerMode = "all" | "reminders";
const workerModes = new WeakMap<TaskWorker, LifeOpsWorkerMode>();
const workerStops = new WeakMap<TaskWorker, () => Promise<void>>();
const hostAdmissions = new WeakMap<
  IAgentRuntime,
  { mode: LifeOpsWorkerMode }
>();

/** Holds host admission across deferred startup and complete disposal. */
export function reserveLifeOpsSchedulerHost(
  runtime: IAgentRuntime,
  mode: LifeOpsWorkerMode,
): () => void {
  assertLifeOpsTaskWorkerMode(runtime, mode);
  if (hostAdmissions.has(runtime)) {
    throw new ElizaError(
      "LifeOps scheduler host is still initialized or disposing",
      {
        code: "LIFEOPS_SCHEDULER_HOST_CONFLICT",
        context: { requestedMode: mode, agentId: runtime.agentId },
      },
    );
  }
  const admission = { mode };
  hostAdmissions.set(runtime, admission);
  return () => {
    if (hostAdmissions.get(runtime) === admission)
      hostAdmissions.delete(runtime);
  };
}

/** Reject incompatible hosts before either changes the runtime's contributions. */
export function assertLifeOpsTaskWorkerMode(
  runtime: IAgentRuntime,
  mode: LifeOpsWorkerMode,
): void {
  const existing = runtime.getTaskWorker(LIFEOPS_TASK_NAME);
  const admission = hostAdmissions.get(runtime);
  if (
    (existing && workerModes.get(existing) !== mode) ||
    (admission && admission.mode !== mode)
  ) {
    throw new ElizaError(
      "Load either the full assistant or its reminder assembly",
      {
        code: "LIFEOPS_SCHEDULER_HOST_CONFLICT",
        context: { requestedMode: mode, agentId: runtime.agentId },
      },
    );
  }
}

export function registerLifeOpsTaskWorker(
  runtime: IAgentRuntime,
  options: {
    disabled?: boolean;
    mode?: LifeOpsWorkerMode;
    isWorkflowClaimSchemaReady?: () => boolean;
  } = {},
): () => Promise<void> {
  const mode = options.mode ?? "all";
  assertLifeOpsTaskWorkerMode(runtime, mode);
  const existing = runtime.getTaskWorker(LIFEOPS_TASK_NAME);
  if (existing) {
    const existingStop = workerStops.get(existing);
    if (!existingStop) {
      throw new ElizaError("LifeOps scheduler lifecycle is unavailable", {
        code: "LIFEOPS_SCHEDULER_LIFECYCLE_UNAVAILABLE",
        context: { mode, agentId: runtime.agentId },
      });
    }
    return existingStop;
  }
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  const disabled = options.disabled === true;
  const worker: TaskWorker = {
    name: LIFEOPS_TASK_NAME,
    // Keep the worker identity registered even when the process-level scheduler
    // kill switch is set. Owner-profile writes use the scheduler row as their
    // metadata store and may create it lazily; without this disabled worker the
    // live TaskService treats that valid row as an orphan and emits a fatal
    // TASK_WORKER_MISSING error every second. Returning false preserves the kill
    // switch exactly: the timer still validates the row, but never executes it.
    shouldRun: async (rt) => {
      if (disabled || stopped) return false;
      if (options.isWorkflowClaimSchemaReady?.() === false) return false;
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
    execute: async (rt, taskOptions) => {
      if (stopped || disabled) {
        throw new ElizaError("LifeOps scheduler host is stopped or disabled", {
          code: "LIFEOPS_SCHEDULER_INACTIVE",
          context: { agentId: rt.agentId },
        });
      }
      if (options.isWorkflowClaimSchemaReady?.() === false) {
        throw new ElizaError(
          "[LifeOpsScheduler] workflow-run claim schema is not ready",
          {
            code: "LIFEOPS_WORKFLOW_RUN_CLAIM_SCHEMA_NOT_READY",
            context: { agentId: rt.agentId },
            severity: "ephemeral",
          },
        );
      }
      const taskRequest = isRecord(taskOptions) ? taskOptions : {};
      const execution =
        mode === "reminders"
          ? executeReminderHostTick(rt, taskRequest)
          : executeLifeOpsSchedulerTask(rt, taskRequest);
      pending.add(execution);
      try {
        return await execution;
      } finally {
        pending.delete(execution);
      }
    },
  };
  workerModes.set(worker, mode);
  runtime.registerTaskWorker(worker);
  const stop = async () => {
    stopped = true;
    await Promise.allSettled([...pending]);
    if (runtime.getTaskWorker(LIFEOPS_TASK_NAME) === worker) {
      runtime.unregisterTaskWorker(LIFEOPS_TASK_NAME);
    }
  };
  workerStops.set(worker, stop);
  return stop;
}
