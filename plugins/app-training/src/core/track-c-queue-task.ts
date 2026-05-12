/**
 * Track-C nightly jobs on the elizaOS TaskService repeat-task path (no plugin-cron).
 * Uses the same cron-boundary math as Heartbeats via `computeNextCronRunAtMs`.
 */

import { computeNextCronRunAtMs } from "@elizaos/agent";
import type { IAgentRuntime, Task } from "@elizaos/core";

export const TRACK_C_QUEUE_TAGS = ["queue", "repeat", "track-c"] as const;

export const TRACK_C_TRAJECTORY_EXPORT_TASK_NAME =
  "TRACK_C_TRAJECTORY_EXPORT_NIGHTLY" as const;
export const TRACK_C_SKILL_SCORING_TASK_NAME =
  "TRACK_C_SKILL_SCORING_NIGHTLY" as const;

const CRON_FALLBACK_MS = 60_000;

/** Subset of `IAgentRuntime` required for Track-C repeat queue tasks */
export interface TrackCRuntimeSubset {
  getTaskWorker: IAgentRuntime["getTaskWorker"];
  registerTaskWorker: IAgentRuntime["registerTaskWorker"];
  createTask: IAgentRuntime["createTask"];
  getTasksByName: IAgentRuntime["getTasksByName"];
  deleteTask: IAgentRuntime["deleteTask"];
}

interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

function taskUpdatedMs(task: Task): number {
  const meta = task.metadata as { updatedAt?: number } | undefined;
  if (typeof meta?.updatedAt === "number") return meta.updatedAt;
  if (typeof task.updatedAt === "number") return task.updatedAt;
  if (typeof task.updatedAt === "bigint") return Number(task.updatedAt);
  return 0;
}

function msUntilNextCron(
  expression: string,
  timezone: string | undefined,
): number {
  const now = Date.now();
  const next = computeNextCronRunAtMs(expression, now, timezone);
  if (next === null) return CRON_FALLBACK_MS;
  const delta = next - now;
  return delta > 0 ? delta : CRON_FALLBACK_MS;
}

export async function pruneDuplicateTasksByName(
  runtime: TrackCRuntimeSubset,
  taskName: string,
  log?: Pick<MinimalLogger, "warn">,
  logPrefix = "[TrackCTask]",
): Promise<void> {
  const tasks = await runtime.getTasksByName(taskName);
  if (tasks.length <= 1) return;

  const sorted = [...tasks].sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a));
  let removed = 0;
  for (const dup of sorted.slice(1)) {
    if (dup.id) {
      await runtime.deleteTask(dup.id);
      removed += 1;
    }
  }
  if (removed > 0) {
    log?.warn(
      `${logPrefix} removed ${removed} duplicate task(s) for "${taskName}"`,
    );
  }
}

function registerTrackCWorkerOnce(
  runtime: TrackCRuntimeSubset,
  taskName: string,
  cronExpr: string,
  timezone: string | undefined,
  onExecute: (rt: IAgentRuntime) => Promise<void>,
): void {
  if (runtime.getTaskWorker(taskName)) return;

  runtime.registerTaskWorker({
    name: taskName,
    execute: async (rt, _options, task) => {
      await onExecute(rt);
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      const expr =
        typeof meta.trackCCronExpr === "string"
          ? meta.trackCCronExpr
          : cronExpr;
      const tzRaw = meta.trackCCronTz;
      let tz: string | undefined;
      if (tzRaw === null || tzRaw === undefined) {
        tz = timezone;
      } else if (typeof tzRaw === "string" && tzRaw.length > 0) {
        tz = tzRaw;
      } else {
        tz = timezone;
      }
      return {
        nextInterval: msUntilNextCron(expr, tz),
      };
    },
  });
}

export interface EnsureTrackCCronRepeatTaskParams {
  taskName: string;
  description: string;
  cronExpr: string;
  timezone?: string;
  log?: MinimalLogger;
  logPrefix?: string;
  onExecute: (rt: IAgentRuntime) => Promise<void>;
}

/**
 * Registers a repeat queue task wired to TaskService ticks. Dedupes by task name,
 * invokes `onExecute` on each fire, and sets `nextInterval` from the cron boundary.
 */
export async function ensureTrackCCronRepeatTask(
  runtime: TrackCRuntimeSubset,
  params: EnsureTrackCCronRepeatTaskParams,
): Promise<"created" | "existing"> {
  const logPrefix = params.logPrefix ?? "[TrackCTask]";
  await pruneDuplicateTasksByName(
    runtime,
    params.taskName,
    params.log,
    logPrefix,
  );

  registerTrackCWorkerOnce(
    runtime,
    params.taskName,
    params.cronExpr,
    params.timezone,
    params.onExecute,
  );

  const existing = await runtime.getTasksByName(params.taskName);
  if (existing.length > 0) {
    return "existing";
  }

  const now = Date.now();
  const nextInterval = msUntilNextCron(params.cronExpr, params.timezone);
  await runtime.createTask({
    name: params.taskName,
    description: params.description,
    tags: [...TRACK_C_QUEUE_TAGS],
    metadata: {
      updatedAt: now,
      updateInterval: nextInterval,
      baseInterval: nextInterval,
      maxFailures: -1,
      trackCCronExpr: params.cronExpr,
      trackCCronTz: params.timezone ?? null,
    },
  });
  params.log?.info(`${logPrefix} created repeat task "${params.taskName}"`);
  return "created";
}
