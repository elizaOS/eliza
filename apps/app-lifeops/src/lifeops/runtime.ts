import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import { logger, runPluginMigrations, stringToUuid } from "@elizaos/core";
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

type RuntimeWithPluginMigrations = IAgentRuntime & {
  runPluginMigrations?: () => Promise<void>;
};

type ErrorWithCause = {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
  query?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isErrorWithCause(value: unknown): value is ErrorWithCause {
  return Boolean(value) && typeof value === "object";
}

function isMissingTasksTableError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (current instanceof Error) {
      if (current.message.includes('relation "tasks" does not exist')) {
        return true;
      }
      if (current.cause !== undefined) {
        queue.push(current.cause);
      }
      continue;
    }

    if (!isErrorWithCause(current)) {
      continue;
    }

    if (
      typeof current.message === "string" &&
      current.message.includes('relation "tasks" does not exist')
    ) {
      return true;
    }

    if (
      current.code === "42P01" &&
      typeof current.query === "string" &&
      current.query.includes('"tasks"')
    ) {
      return true;
    }

    if (current.cause !== undefined) {
      queue.push(current.cause);
    }
  }

  return false;
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

async function rerunPluginMigrations(runtime: IAgentRuntime): Promise<void> {
  const runtimeWithPluginMigrations = runtime as RuntimeWithPluginMigrations;
  if (typeof runtimeWithPluginMigrations.runPluginMigrations === "function") {
    await runtimeWithPluginMigrations.runPluginMigrations();
    return;
  }

  await runPluginMigrations(runtime);
}

export async function executeLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
  options: Record<string, unknown> = {},
): Promise<{
  nextInterval: number;
}> {
  // Real dispatch runs unconditionally via processScheduledWork below.
  //
  // NOTE: Previously this method also called `planJob(runtime, {
  //   jobKind: "meeting_reminder", snapshot: { now, scheduler } })` per tick.
  // That call was a LARP: every tick built an empty snapshot with a
  // hardcoded jobKind and no occurrence/calendar context, so the LLM
  // planner received effectively nothing to plan with, wasted tokens, and
  // its result was never used by processScheduledWork. The call was removed.
  //
  // When we wire the background planner into this scheduler for real, the
  // planner call must receive a populated `snapshot` with pending
  // occurrences + upcoming events + overdue follow-ups + any other context
  // needed to produce a useful plan, and the plan result must actually
  // influence dispatch. Until then, do NOT re-introduce the empty-snapshot
  // call here.
  const now = typeof options.now === "string" ? options.now : undefined;

  const service = new LifeOpsService(runtime);
  await service.processScheduledWork({ now });
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
      } catch (error) {
        logger.warn(
          `[lifeops-scheduler] loadLifeOpsAppState failed; defaulting shouldRun=true: ${
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

/**
 * Wait for the database adapter to be ready before running task queries.
 * PGlite may still be initializing when plugin init fires; a short probe
 * avoids a noisy retry cycle in plugin-sql.
 */
async function waitForDbReady(
  runtime: IAgentRuntime,
  maxAttempts = 12,
  delayMs = 500,
): Promise<void> {
  let lastError: unknown = null;
  let migrationRepairAttempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Light-weight probe: fetch tasks with a filter that should match nothing.
      await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: ["__db_ready_probe__"],
      });
      return;
    } catch (error) {
      lastError = error;
      if (
        isMissingTasksTableError(error) &&
        typeof runtime.runPluginMigrations === "function" &&
        migrationRepairAttempts < 2
      ) {
        migrationRepairAttempts += 1;
        await rerunPluginMigrations(runtime);
        continue;
      }
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("[lifeops] database adapter did not become ready");
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

export async function ensureRuntimeAgentRecord(
  runtime: IAgentRuntime,
): Promise<void> {
  const existing = await runtime.getAgent(runtime.agentId);
  if (existing) {
    return;
  }

  await runtime.createAgent({
    ...runtime.character,
    id: runtime.agentId,
  });

  const hydrated = await runtime.getAgent(runtime.agentId);
  if (!hydrated) {
    throw new Error(
      `[lifeops] runtime agent ${runtime.agentId} is missing from the agents table`,
    );
  }
}

export async function ensureLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  await waitForDbReady(runtime);
  await ensureRuntimeAgentRecord(runtime);
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
