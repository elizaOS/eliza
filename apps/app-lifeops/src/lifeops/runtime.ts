import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import { logger, stringToUuid } from "@elizaos/core";
import { loadLifeOpsAppState } from "./app-state.js";
import { LifeOpsService } from "./service.js";
import { readTwilioCredentialsFromEnv } from "./twilio.js";

export const LIFEOPS_TASK_NAME = "LIFEOPS_SCHEDULER" as const;
export const LIFEOPS_TASK_TAGS = ["queue", "repeat", "lifeops"] as const;
/** Base interval for the LifeOps scheduler polling loop. */
export const LIFEOPS_TASK_INTERVAL_MS = 60_000;
/** Maximum deterministic jitter added per agent to avoid synchronized polls. */
export const LIFEOPS_TASK_JITTER_MS = 10_000;

type AutonomyServiceLike = {
  getAutonomousRoomId?: () => UUID;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLifeOpsSchedulerTask(task: Task): boolean {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const scheduler = metadata?.lifeopsScheduler;
  return (
    task.name === LIFEOPS_TASK_NAME &&
    isRecord(scheduler) &&
    scheduler.kind === "runtime_runner"
  );
}

function buildSchedulerMetadata(
  agentId: UUID,
  current: Record<string, unknown> | null = null,
): TaskMetadata {
  const intervalMs = resolveLifeOpsTaskIntervalMs(agentId);
  return {
    ...(current ?? {}),
    updateInterval: intervalMs,
    baseInterval: intervalMs,
    blocking: true,
    lifeopsScheduler: {
      kind: "runtime_runner",
      version: 1,
    },
  };
}

export function resolveLifeOpsTaskIntervalMs(agentId: UUID): number {
  let hash = 0;
  for (let index = 0; index < agentId.length; index++) {
    hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  }
  return LIFEOPS_TASK_INTERVAL_MS + (hash % (LIFEOPS_TASK_JITTER_MS + 1));
}

export async function executeLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
  options: Record<string, unknown> = {},
): Promise<{
  nextInterval: number;
}> {
  const service = new LifeOpsService(runtime);
  await service.processScheduledWork({
    now: typeof options.now === "string" ? options.now : undefined,
  });
  return {
    nextInterval: resolveLifeOpsTaskIntervalMs(runtime.agentId),
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
      } catch {
        return true;
      }
    },
    execute: async (rt, options) =>
      executeLifeOpsSchedulerTask(rt, isRecord(options) ? options : {}),
  });
}

/**
 * Wait for the database adapter to be ready before running task queries.
 * PGlite may still be initializing when plugin init fires; a short probe
 * avoids a noisy retry cycle in plugin-sql.
 */
async function waitForDbReady(
  runtime: IAgentRuntime,
  maxAttempts = 3,
  delayMs = 500,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Light-weight probe: fetch tasks with a filter that should match nothing.
      await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: ["__db_ready_probe__"],
      });
      return;
    } catch {
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  // If still failing, let the caller proceed — the original retry logic in
  // plugin-sql will handle it, we just reduced the likelihood of hitting it.
}

let credentialStatusLogged = false;
function logCredentialStatus(): void {
  if (credentialStatusLogged) return;
  credentialStatusLogged = true;
  const hasTwilio = Boolean(readTwilioCredentialsFromEnv());
  if (!hasTwilio) {
    logger.info(
      "[lifeops] Twilio credentials not configured — SMS and voice reminders will be blocked. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to enable.",
    );
  }
}

export async function ensureLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  await waitForDbReady(runtime);
  logCredentialStatus();

  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...LIFEOPS_TASK_TAGS],
  });
  const existing = tasks.find(isLifeOpsSchedulerTask);
  const metadata = buildSchedulerMetadata(
    runtime.agentId,
    isRecord(existing?.metadata) ? existing.metadata : null,
  );
  if (existing?.id) {
    await runtime.updateTask(existing.id, {
      description: "Process life-ops reminders and scheduled workflows",
      metadata,
    });
    return existing.id;
  }

  const autonomy = runtime.getService("AUTONOMY") as AutonomyServiceLike | null;
  const roomId =
    autonomy?.getAutonomousRoomId?.() ??
    stringToUuid(`lifeops-scheduler-room-${runtime.agentId}`);

  return runtime.createTask({
    name: LIFEOPS_TASK_NAME,
    description: "Process life-ops reminders and scheduled workflows",
    roomId,
    tags: [...LIFEOPS_TASK_TAGS],
    metadata,
    dueAt: Date.now(),
  });
}
