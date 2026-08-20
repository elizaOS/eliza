/**
 * Standalone scheduler tick — the fallback TaskService worker for the
 * ScheduledTask spine when no consumer host is loaded. Core owns the only
 * process clock; this module contributes one durable repeat row and worker.
 *
 * `@elizaos/plugin-scheduling` is the always-loaded scheduling primitive: it
 * hosts the runner service, the REST surface (`POST /api/lifeops/scheduled-tasks`
 * returns 201), and the seed registry. But the only production caller of the
 * due-task evaluation loop lived in `@elizaos/plugin-personal-assistant`
 * (`processDueScheduledTasks`, driven by its `LIFEOPS_SCHEDULER` task worker).
 * On any runtime without PA, every wall-clock trigger — `once`, `cron`,
 * `interval` — was accepted, persisted, listed... and never fired
 * (sol-dev cutover QA 2026-08-11: a `once` reminder stayed `scheduled`
 * indefinitely past its `atIso`).
 *
 * This module closes that gap with a minimal in-plugin tick:
 *
 * - **Defers to a consumer host.** The tick no-ops whenever
 *   {@link getScheduledTaskRunnerDeps} reports an injected deps provider —
 *   that provider's owner (PA) runs the production tick with owner facts,
 *   quiet-hours gates, escalation ladders, and completion timeouts. The check
 *   runs EVERY tick, so a host that registers after boot takes over cleanly.
 * - **Reuses the runner's own safety.** Dueness comes from the shared
 *   {@link isScheduledTaskDue}; firing goes through `fireWithResult` whose
 *   CAS claim makes a race with any other driver observable (`raced`) instead
 *   of a double-fire.
 * - **Stays small on purpose.** No completion-timeout follow-ups, no
 *   escalation advancement, no owner-facts enrichment — those are consumer
 *   host domain content. This is only the "wall clock exists" guarantee the
 *   spine's REST contract already implies.
 */

import {
  type IAgentRuntime,
  logger,
  ServiceType,
  type Task,
  type TaskMetadata,
  type UUID,
} from "@elizaos/core";
import { isScheduledTaskDue } from "./due.js";
import type { ScheduledTaskFireResult } from "./runner.js";
import {
  getScheduledTaskRunner,
  getScheduledTaskRunnerDeps,
} from "./runner-service.js";

/** Base cadence of the fallback tick; mirrors PA's LIFEOPS_TASK_INTERVAL_MS. */
export const STANDALONE_TICK_INTERVAL_MS = 60_000;
export const STANDALONE_TICK_TASK_NAME = "SCHEDULED_TASK_RUNNER" as const;
export const STANDALONE_TICK_TASK_TAGS = [
  "queue",
  "repeat",
  "scheduling",
] as const;

const STANDALONE_TICK_TASK_KIND = "standalone_scheduled_task_runner";

function taskServiceNow(runtime: IAgentRuntime): Date {
  const service = runtime.getService(ServiceType.TASK) as
    | { currentTime?: () => Date }
    | null
    | undefined;
  return service?.currentTime?.() ?? new Date();
}

/** Process-level kill switch, mirroring PA's ELIZA_DISABLE_LIFEOPS_SCHEDULER. */
export function isStandaloneTickDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.ELIZA_DISABLE_SCHEDULING_TICK?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export interface StandaloneTickResult {
  /** Why the tick did no work, when it didn't. */
  skipped?: "consumer_host" | "disabled";
  /** Fire attempts made this tick, in task order. */
  fires: Array<{ taskId: string; outcome: ScheduledTaskFireResult["kind"] }>;
  /** Per-task errors; one bad row must not starve the rest of the tick. */
  errors: Array<{ taskId: string; message: string }>;
}

/**
 * Run one standalone tick: fire every due wall-clock task through the runner.
 * Exposed for tests and for the TaskService worker registered below.
 */
export async function runStandaloneSchedulingTick(
  runtime: IAgentRuntime,
  opts: { now?: Date } = {},
): Promise<StandaloneTickResult> {
  const result: StandaloneTickResult = { fires: [], errors: [] };
  if (isStandaloneTickDisabled()) {
    result.skipped = "disabled";
    return result;
  }
  // A consumer host (e.g. plugin-personal-assistant) owns the production
  // tick. Checked per-tick so late-registering hosts take over without a
  // restart, and so the two drivers never run concurrently by design (the
  // runner's CAS claim would still prevent double-fires if they did).
  if (getScheduledTaskRunnerDeps(runtime) !== null) {
    result.skipped = "consumer_host";
    return result;
  }

  const now = opts.now ?? new Date();
  const runner = getScheduledTaskRunner(runtime, {
    agentId: runtime.agentId,
    now: () => now,
  });

  const tasks = await runner.list();
  for (const task of tasks) {
    if (task.state.status === "dismissed") continue;
    try {
      const decision = await isScheduledTaskDue(task, { now });
      if (!decision.due) continue;
      // `allowTerminalRefire` lets a due next occurrence of a RECURRING task
      // reopen from a parked status; `fireWithResult`'s own refire guard
      // re-verifies dueness on the fresh row before claiming.
      const fire = await runner.fireWithResult(task.taskId, {
        allowTerminalRefire: true,
      });
      result.fires.push({ taskId: task.taskId, outcome: fire.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ taskId: task.taskId, message });
      // error-policy:J7 A malformed or temporarily failing scheduled row must
      // not starve independent rows; diagnostics make the isolated failure
      // visible while the durable row remains eligible for the next tick.
      runtime.reportError("SchedulingStandaloneTick.task", error, {
        taskId: task.taskId,
      });
      logger.warn(
        { src: "scheduling:standalone-tick", taskId: task.taskId },
        `[scheduling] standalone tick failed for ${task.taskId}: ${message}`,
      );
    }
  }
  return result;
}

function isStandaloneTickTask(task: Task): boolean {
  const marker = task.metadata?.schedulingTick;
  return (
    task.name === STANDALONE_TICK_TASK_NAME &&
    typeof marker === "object" &&
    marker !== null &&
    "kind" in marker &&
    marker.kind === STANDALONE_TICK_TASK_KIND
  );
}

function buildStandaloneTickMetadata(nowMs: number): TaskMetadata {
  return {
    updatedAt: nowMs,
    updateInterval: STANDALONE_TICK_INTERVAL_MS,
    baseInterval: STANDALONE_TICK_INTERVAL_MS,
    blocking: true,
    maxFailures: 0,
    paused: false,
    schedulingTick: {
      kind: STANDALONE_TICK_TASK_KIND,
      version: 1,
    },
  };
}

/** Register the fallback tick as a core TaskService worker. */
export function registerStandaloneTickWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(STANDALONE_TICK_TASK_NAME)) return;
  runtime.registerTaskWorker({
    name: STANDALONE_TICK_TASK_NAME,
    shouldRun: async () =>
      !isStandaloneTickDisabled() &&
      getScheduledTaskRunnerDeps(runtime) === null,
    execute: async () => {
      await runStandaloneSchedulingTick(runtime, {
        now: taskServiceNow(runtime),
      });
      return { nextInterval: STANDALONE_TICK_INTERVAL_MS };
    },
  });
}

/**
 * Ensure exactly one durable repeat row drives the fallback worker.
 *
 * The row remains present while a richer consumer host is loaded; the worker's
 * `shouldRun` gate hands ownership to that host without introducing another
 * wall clock. If the host unloads, the next core TaskService poll resumes the
 * fallback automatically.
 */
export async function ensureStandaloneTickTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...STANDALONE_TICK_TASK_TAGS],
  });
  const matches = tasks.filter(isStandaloneTickTask);
  const [canonical, ...duplicates] = matches;

  for (const duplicate of duplicates) {
    if (duplicate.id) await runtime.deleteTask(duplicate.id);
  }

  const nowMs = taskServiceNow(runtime).getTime();
  const metadata = buildStandaloneTickMetadata(nowMs);
  if (canonical?.id) {
    await runtime.updateTask(canonical.id, {
      description:
        "Drive scheduled tasks when no consumer host owns the runner",
      metadata,
    });
    return canonical.id;
  }

  return runtime.createTask({
    name: STANDALONE_TICK_TASK_NAME,
    description: "Drive scheduled tasks when no consumer host owns the runner",
    agentId: runtime.agentId,
    tags: [...STANDALONE_TICK_TASK_TAGS],
    metadata,
    dueAt: nowMs,
  });
}

/** Remove the worker and its durable driver rows during plugin unload. */
export async function disposeStandaloneTick(
  runtime: IAgentRuntime,
): Promise<void> {
  runtime.unregisterTaskWorker(STANDALONE_TICK_TASK_NAME);
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...STANDALONE_TICK_TASK_TAGS],
  });
  for (const task of tasks) {
    if (isStandaloneTickTask(task) && task.id) {
      await runtime.deleteTask(task.id);
    }
  }
}
