/**
 * Activity-profile maintenance worker.
 *
 * One scheduler (#10721 H1): owner-facing proactive dispatch (GM/GN, nudges,
 * check-ins, follow-ups) is owned exclusively by the `ScheduledTask` runner —
 * the first-run defaults pack and the default-pack catalog seed those records
 * through `@elizaos/plugin-scheduling`'s seed registry, and the production
 * dispatcher delivers them. This worker's old parallel firing path (its own
 * timing gates, fired-actions log, and direct send-to-target / assistant-event
 * dispatch) is retired.
 *
 * What remains on this tick:
 *   1. **Activity-profile maintenance** — build/refresh the owner
 *      `ActivityProfile` and persist it on the task's metadata, where the
 *      `activityProfileProvider` reads it for prompt context.
 *   2. **WS5 background-planner observability** — route the tick through
 *      {@link planJob} so planner decisions are observable and sensitive
 *      actions land in the WS6 approval queue (which itself executes through
 *      the scheduled-task spine).
 *
 * The pure planning content this worker used to fire directly lives on in
 * `./proactive-planner.ts` as the content library for spine consumers (e.g.
 * goal check-ins on the scheduling spine); it is intentionally not invoked
 * from here.
 */

import { loadElizaConfig } from "@elizaos/agent";
import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import { logger, ModelType, stringToUuid } from "@elizaos/core";
import { loadLifeOpsAppState } from "../lifeops/app-state.js";
import {
  type BackgroundJobContext,
  BackgroundPlannerError,
  planJob,
} from "../lifeops/background-planner.js";
import { enqueueIfSensitive } from "../lifeops/background-planner-dispatch.js";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { ensureRuntimeAgentRecord } from "../lifeops/runtime.js";
import {
  PROACTIVE_TASK_NAME,
  PROACTIVE_TASK_TAGS,
} from "./profile-metadata.js";
import {
  buildActivityProfile,
  profileNeedsRebuild,
  readProfileFromMetadata,
  refreshCurrentState,
  resolveOwnerEntityId,
} from "./service.js";
import type { ActivityProfile } from "./types.js";
import { learnRhythmWindows } from "./window-learning-writer.js";

// Re-exported for API stability; canonical definitions live in
// `profile-metadata.ts` so lightweight consumers can import them directly.
export { PROACTIVE_TASK_NAME, PROACTIVE_TASK_TAGS };
export const PROACTIVE_TASK_INTERVAL_MS = 60_000;

const TASK_DESCRIPTION =
  "Activity-profile maintenance + background-planner tick (proactive dispatch is owned by the scheduled-task runner)";

export function isAppFirstRunComplete(): boolean {
  try {
    return loadElizaConfig().meta?.firstRunComplete === true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveExecutionNow(options: Record<string, unknown> = {}): Date {
  const raw = options.now;
  if (raw instanceof Date) {
    return new Date(raw.getTime());
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function isProactiveTask(task: Task): boolean {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const agent = metadata?.proactiveAgent;
  return (
    task.name === PROACTIVE_TASK_NAME &&
    isRecord(agent) &&
    agent.kind === "runtime_runner"
  );
}

function buildProactiveMetadata(
  current: Record<string, unknown> | null = null,
): TaskMetadata {
  return {
    ...current,
    updateInterval: PROACTIVE_TASK_INTERVAL_MS,
    baseInterval: PROACTIVE_TASK_INTERVAL_MS,
    blocking: true,
    proactiveAgent: {
      kind: "runtime_runner",
      version: 1,
    },
  };
}

export async function executeProactiveTask(
  runtime: IAgentRuntime,
  options: Record<string, unknown> = {},
): Promise<{ nextInterval: number }> {
  const now = resolveExecutionNow(options);
  const timezone = resolveDefaultTimeZone();

  const ownerEntityId = await resolveOwnerEntityId(runtime);
  if (!ownerEntityId) {
    return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
  }

  // WS5: Route this tick through the shared LLM planner so every tick is
  // observable via `planJob` and sensitive actions are always enqueued into
  // the WS6 approval queue (which executes through the scheduled-task spine).
  const plannerContext: BackgroundJobContext = {
    jobKind: "daily_brief",
    subjectUserId: ownerEntityId,
    snapshot: {
      now: now.toISOString(),
      timezone,
    },
    availableChannels: ["internal"],
    trigger: "proactive_tick",
  };
  try {
    const plan = await planJob(runtime, plannerContext);
    await enqueueIfSensitive(runtime, plannerContext, plan);
  } catch (error) {
    if (error instanceof BackgroundPlannerError) {
      logger.warn(
        `[proactive] background planner unavailable — ${error.message}`,
      );
    } else {
      throw error;
    }
  }

  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...PROACTIVE_TASK_TAGS],
  });
  const task = tasks.find(isProactiveTask);
  if (!task?.id) {
    return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
  }

  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const currentProfile = readProfileFromMetadata(metadata);
  let profile: ActivityProfile | null;
  if (profileNeedsRebuild(currentProfile, now)) {
    logger.info("[proactive] Building full activity profile");
    profile = await buildActivityProfile(runtime, ownerEntityId, timezone, now);
  } else if (currentProfile) {
    profile = await refreshCurrentState(
      runtime,
      ownerEntityId,
      currentProfile,
      now,
    );
  } else {
    profile = null;
  }

  if (!profile) {
    return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
  }

  // Drop the retired parallel-path fired-actions log from persisted metadata;
  // dispatch dedup is the runner's job (idempotency keys + task state).
  const { firedActionsLog: _retiredFiredLog, ...cleanMetadata } = metadata;
  await runtime.updateTask(task.id, {
    metadata: {
      ...cleanMetadata,
      activityProfile: profile,
    },
  });

  // Close the observe→learn→schedule loop: fold the freshly-computed
  // wake/sleep rhythm into OwnerFacts.morningWindow / eveningWindow so
  // during_window triggers and wake/bedtime anchors track the user's real
  // rhythm. User-set windows are never clobbered; the write is idempotent.
  //
  // Guarded: rhythm learning is a best-effort side-effect of the tick. A
  // transient store/cache write failure here must NOT abort the proactive tick
  // (which would feed the core failure ladder even though the profile already
  // persisted). Log-and-continue is the intended behavior for this one call.
  try {
    await learnRhythmWindows(
      runtime,
      {
        typicalWakeHour: profile.typicalWakeHour,
        typicalSleepHour: profile.typicalSleepHour,
      },
      now,
    );
  } catch (error) {
    logger.warn(
      {
        src: "lifeops:activity-profile:proactive-worker",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[proactive] rhythm-window learning failed; continuing tick (best-effort learning)",
    );
  }

  return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
}

export function registerProactiveTaskWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(PROACTIVE_TASK_NAME)) {
    return;
  }
  runtime.registerTaskWorker({
    name: PROACTIVE_TASK_NAME,
    // Skip execution when the user has disabled LifeOps via the UI. The task
    // record and worker stay registered so toggling back on requires no
    // restart — cycles just become cheap no-ops while disabled.
    shouldRun: async (rt) => {
      try {
        if (!isAppFirstRunComplete()) return false;
        if (!rt.getModel(ModelType.TEXT_SMALL)) return false;
        const state = await loadLifeOpsAppState(rt as IAgentRuntime);
        return state.enabled;
      } catch (error) {
        logger.warn(
          `[proactive-worker] proactive tick preflight failed; skipping because runtime readiness is unknown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
    execute: (rt, options) =>
      executeProactiveTask(rt, isRecord(options) ? options : {}),
  });
}

type AutonomyServiceLike = {
  getAutonomousRoomId?: () => UUID;
};

export async function ensureProactiveAgentTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  await ensureRuntimeAgentRecord(runtime);
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...PROACTIVE_TASK_TAGS],
  });
  const existing = tasks.find(isProactiveTask);
  const metadata = buildProactiveMetadata(
    isRecord(existing?.metadata) ? existing.metadata : null,
  );
  if (existing?.id) {
    await runtime.updateTask(existing.id, {
      description: TASK_DESCRIPTION,
      metadata,
    });
    return existing.id;
  }

  const autonomy = runtime.getService("AUTONOMY") as AutonomyServiceLike | null;
  const roomId =
    autonomy?.getAutonomousRoomId?.() ??
    stringToUuid(`proactive-agent-room-${runtime.agentId}`);

  return runtime.createTask({
    name: PROACTIVE_TASK_NAME,
    description: TASK_DESCRIPTION,
    roomId,
    tags: [...PROACTIVE_TASK_TAGS],
    metadata,
    dueAt: Date.now(),
  });
}
