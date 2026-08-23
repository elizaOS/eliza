/**
 * LifeOps runtime wiring: constructs the composed LifeOpsService, ensures the
 * agent record and the LifeOps scheduler task exist, and re-exports the
 * scheduler-task helpers callers use to bootstrap the plugin at init.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { loadLifeOpsAppState } from "./app-state.js";
import type { HouseholdGrantExpiryWarningReceipt } from "./household/grant-expiry-warning.js";
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

  const service = new LifeOpsService(runtime);
  let scheduledWork: Awaited<
    ReturnType<LifeOpsService["processScheduledWork"]>
  >;
  try {
    scheduledWork = await service.processScheduledWork({ now });
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
    scheduledWork = await service.processScheduledWork({ now });
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

export function registerLifeOpsTaskWorker(
  runtime: IAgentRuntime,
  options: {
    disabled?: boolean;
    isWorkflowClaimSchemaReady?: () => boolean;
  } = {},
): void {
  if (runtime.getTaskWorker(LIFEOPS_TASK_NAME)) {
    return;
  }
  const disabled = options.disabled === true;
  runtime.registerTaskWorker({
    name: LIFEOPS_TASK_NAME,
    // Keep the worker identity registered even when the process-level scheduler
    // kill switch is set. Owner-profile writes use the scheduler row as their
    // metadata store and may create it lazily; without this disabled worker the
    // live TaskService treats that valid row as an orphan and emits a fatal
    // TASK_WORKER_MISSING error every second. Returning false preserves the kill
    // switch exactly: the timer still validates the row, but never executes it.
    shouldRun: async (rt) => {
      if (disabled) return false;
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
      return executeLifeOpsSchedulerTask(
        rt,
        isRecord(taskOptions) ? taskOptions : {},
      );
    },
  });
}
