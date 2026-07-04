/**
 * Real production readers for the two gate kinds that previously fell through
 * to always-allow stubs (issue #12186, tasks B2 + B3 / plan D.2.2 + D.4.1):
 *
 *   - `circadian_state_in` — gates on the observed awake/asleep state from the
 *     `ActivityProfile` (health sleep signals + activity heartbeat). Health
 *     default packs (`wake-up`, `bedtime`, `sleep-recap`) declare
 *     `params.states: ["awake"]` so they only fire while the user is up.
 *
 *   - `no_recent_user_message_in` — suppresses a proactive poke when the user
 *     has been active within `params.minutes`. Reads the profile's `lastSeenAt`
 *     (owner messages + activity/health signals) and the `message_activity_event`
 *     bus family. Returns `defer` (reschedule) not `deny` so the poke isn't
 *     dropped, just delayed until the user goes quiet.
 *
 *   - `personal_baseline_sufficient` context feeder (B3 / plan D.2.3): the
 *     profile also feeds a *behavioural* sample count so the built-in
 *     `personal_baseline_sufficient` gate can fire once enough rhythm has been
 *     observed, independent of the health baseline.
 *
 * These read structural fields only. No prompt-text routing, no new scheduler.
 */

import type { IAgentRuntime, Task } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  GateDecision,
  GateEvaluationContext,
  ScheduledTask,
  TaskGateContribution,
} from "@elizaos/plugin-scheduling";
import {
  PROACTIVE_TASK_NAME,
  PROACTIVE_TASK_TAGS,
  readProfileFromMetadata,
} from "../../activity-profile/profile-metadata.js";
import type { ActivityProfile } from "../../activity-profile/types.js";

const MAX_PROFILE_TASKS = 25;

/** Circadian states this gate understands. */
type CircadianState = "awake" | "asleep";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the persisted `ActivityProfile` from the `PROACTIVE_AGENT` task
 * metadata — the same source the activity-profile provider reads. Returns
 * `null` when no profile has been built yet.
 */
export async function readActivityProfile(
  runtime: IAgentRuntime,
): Promise<ActivityProfile | null> {
  const tasks = (await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...PROACTIVE_TASK_TAGS],
  })) as Task[];
  const task = tasks
    .slice(0, MAX_PROFILE_TASKS)
    .find((t) => t.name === PROACTIVE_TASK_NAME && isRecord(t.metadata));
  const metadata = isRecord(task?.metadata) ? task.metadata : null;
  return readProfileFromMetadata(metadata);
}

function gateParams(
  context: GateEvaluationContext,
  kind: string,
): Record<string, unknown> {
  const params = context.task.shouldFire?.gates.find(
    (g) => g.kind === kind,
  )?.params;
  return isRecord(params) ? params : {};
}

function parseStates(raw: unknown): CircadianState[] {
  if (!Array.isArray(raw)) return ["awake"];
  const states = raw.filter(
    (s): s is CircadianState => s === "awake" || s === "asleep",
  );
  return states.length > 0 ? states : ["awake"];
}

/**
 * `circadian_state_in` — allow only when the observed circadian state is in the
 * requested `states`. Reads `ActivityProfile.isCurrentlySleeping`.
 *
 * When no profile exists yet (day one, before the first rhythm rebuild) the
 * observed state is unknown. Defaulting to `awake` matches the honest reality
 * that we have no evidence the user is asleep, and keeps day-one packs firing
 * rather than silently starving them.
 */
function makeCircadianStateInGate(
  runtime: IAgentRuntime,
): TaskGateContribution {
  return {
    kind: "circadian_state_in",
    async evaluate(
      _task: ScheduledTask,
      context: GateEvaluationContext,
    ): Promise<GateDecision> {
      const states = parseStates(
        gateParams(context, "circadian_state_in").states,
      );
      const profile = await readActivityProfile(runtime);
      const observed: CircadianState =
        profile?.isCurrentlySleeping === true ? "asleep" : "awake";
      if (states.includes(observed)) {
        return { kind: "allow" };
      }
      return {
        kind: "deny",
        reason: `circadian_state_in: observed "${observed}" not in [${states.join(",")}]`,
      };
    },
  };
}

interface NoRecentUserMessageParams {
  /** Suppress the poke when the user was seen within this many minutes. */
  minutes?: number;
}

const DEFAULT_NO_RECENT_MINUTES = 30;

/**
 * `no_recent_user_message_in` — suppress a proactive poke when the user has
 * been active within `params.minutes`. "Active" = the profile's `lastSeenAt`
 * (owner messages + activity/health signals) OR a `message_activity_event` on
 * the bus since the cutoff.
 *
 * Returns `defer` (reschedule for the remaining suppression window) rather than
 * `deny` so the poke is delayed until the user goes quiet, not dropped.
 */
function makeNoRecentUserMessageInGate(
  runtime: IAgentRuntime,
): TaskGateContribution {
  return {
    kind: "no_recent_user_message_in",
    async evaluate(
      _task: ScheduledTask,
      context: GateEvaluationContext,
    ): Promise<GateDecision> {
      const params = gateParams(
        context,
        "no_recent_user_message_in",
      ) as NoRecentUserMessageParams;
      const minutes =
        typeof params.minutes === "number" &&
        Number.isFinite(params.minutes) &&
        params.minutes > 0
          ? params.minutes
          : DEFAULT_NO_RECENT_MINUTES;

      const nowMs = Date.parse(context.nowIso);
      if (!Number.isFinite(nowMs)) {
        return { kind: "allow" };
      }
      const cutoffMs = nowMs - minutes * 60_000;
      const sinceIso = new Date(cutoffMs).toISOString();

      const profile = await readActivityProfile(runtime);
      const lastSeenAt =
        profile && Number.isFinite(profile.lastSeenAt) ? profile.lastSeenAt : 0;
      const recentByProfile = lastSeenAt > 0 && lastSeenAt >= cutoffMs;

      const recentByBus =
        (await context.activity.hasSignalSince({
          signalKind: "message_activity_event",
          sinceIso,
        })) === true;

      if (!recentByProfile && !recentByBus) {
        return { kind: "allow" };
      }

      // How long until the user is "quiet" again, measured from the most
      // recent activity we can see.
      const lastActivityMs = recentByProfile ? lastSeenAt : cutoffMs;
      const quietAtMs = lastActivityMs + minutes * 60_000;
      const deferMinutes = Math.max(1, Math.ceil((quietAtMs - nowMs) / 60_000));
      return {
        kind: "defer",
        until: { offsetMinutes: deferMinutes },
        reason: `no_recent_user_message_in: user active within ${minutes}m; deferring ${deferMinutes}m`,
      };
    },
  };
}

/**
 * Register the two real gate readers into a `TaskGateRegistry`-shaped object.
 * Must run BEFORE `registerBuiltInGates` (which is first-wins after the change
 * in this issue) so these readers take precedence over any built-in fallback.
 */
export function registerActivityProfileGates(
  runtime: IAgentRuntime,
  registry: { register(c: TaskGateContribution): void },
): void {
  registry.register(makeCircadianStateInGate(runtime));
  registry.register(makeNoRecentUserMessageInGate(runtime));
  logger.debug(
    { src: "lifeops:scheduled-task:activity-gates", agentId: runtime.agentId },
    "[activity-gates] registered circadian_state_in + no_recent_user_message_in readers",
  );
}

/**
 * Behavioural personal-baseline sample count (B3 / plan D.2.3). Counts the
 * number of distinct observed-rhythm signals the profile carries so
 * `personal_baseline_sufficient` can fire once enough behaviour is observed,
 * not only from a health baseline. Exposed for the owner-facts feeder.
 *
 * A sample is any of: an observed wake hour, an observed sleep hour, or a
 * meaningful message-activity history. `windowDays` mirrors the profile's
 * analysis window.
 */
export function behaviouralBaselineFromProfile(
  profile: ActivityProfile | null,
): { sampleCount: number; windowDays: number } | null {
  if (!profile) return null;
  let sampleCount = 0;
  if (
    typeof profile.typicalWakeHour === "number" &&
    Number.isFinite(profile.typicalWakeHour)
  ) {
    sampleCount += 1;
  }
  if (
    typeof profile.typicalSleepHour === "number" &&
    Number.isFinite(profile.typicalSleepHour)
  ) {
    sampleCount += 1;
  }
  // Each platform with sustained history contributes one behavioural sample.
  for (const platform of profile.platforms) {
    if (platform.messageCount > 0) sampleCount += 1;
  }
  if (sampleCount === 0) return null;
  return {
    sampleCount,
    windowDays: profile.analysisWindowDays,
  };
}
