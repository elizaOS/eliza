import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveCurrentBucket } from "../activity-profile/analyzer.js";
import { PROACTIVE_TASK_TAGS } from "../activity-profile/proactive-worker.js";
import { readProfileFromMetadata } from "../activity-profile/service.js";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { getLocalDateKey, getZonedDateParts } from "../lifeops/time.js";

const MAX_PROFILE_TASKS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const activityProfileProvider: Provider = {
  name: "activity-profile",
  description:
    "Owner and agent only. Compact user activity context: platform, time bucket, recency.",
  descriptionCompressed: "owner+agent activity: platform, time bucket, recency",
  dynamic: true,
  position: 13,
  contexts: ["screen_time", "tasks", "health"],
  contextGate: { anyOf: ["screen_time", "tasks", "health"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    const timezone = resolveDefaultTimeZone();
    const now = new Date();
    const bucket = resolveCurrentBucket(timezone, now);
    try {
      const tasks = await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: [...PROACTIVE_TASK_TAGS],
      });
      const task = tasks
        .slice(0, MAX_PROFILE_TASKS)
        .find((t) => t.name === "PROACTIVE_AGENT" && isRecord(t.metadata));
      const metadata = isRecord(task?.metadata) ? task.metadata : null;
      const profile = readProfileFromMetadata(metadata);

      if (profile) {
        const parts: string[] = [];
        const localDateKey = getLocalDateKey(getZonedDateParts(now, timezone));

        const hasActiveScreen =
          profile.screenContextAvailable &&
          profile.screenContextFocus !== null &&
          profile.screenContextFocus !== "idle" &&
          profile.screenContextFocus !== "unknown";

        if (
          !hasActiveScreen &&
          profile.lastSeenPlatform &&
          profile.lastSeenAt > 0
        ) {
          const ago = formatAgo(now.getTime() - profile.lastSeenAt);
          parts.push(
            profile.isCurrentlyActive
              ? `active on ${profile.lastSeenPlatform} ${ago}`
              : `last seen on ${profile.lastSeenPlatform} ${ago}`,
          );
        }
        if (hasActiveScreen && profile.screenContextFocus) {
          const screenAgo = profile.screenContextSampledAt
            ? formatAgo(now.getTime() - profile.screenContextSampledAt)
            : "recently";
          const screenParts = [`screen ${profile.screenContextFocus}`];
          if (
            profile.screenContextSource &&
            profile.screenContextSource !== "disabled"
          ) {
            screenParts.push(`via ${profile.screenContextSource}`);
          }
          screenParts.push(screenAgo);
          parts.push(screenParts.join(" "));
        }
        if (profile.isCurrentlySleeping) {
          parts.push("sleeping");
        } else if (profile.hasSleepData) {
          parts.push("sleep data ready");
        }
        parts.push(bucket);
        if (profile.effectiveDayKey !== localDateKey) {
          parts.push("previous day still open");
        }

        return {
          text: parts.length > 0 ? `User: ${parts.join(" | ")}` : "",
          values: {
            userIsActive: profile.isCurrentlyActive,
            userPrimaryPlatform: profile.primaryPlatform,
            userLastSeenPlatform: profile.lastSeenPlatform,
            userLastSeenAt: profile.lastSeenAt,
            userTimeBucket: bucket,
            userEffectiveDayKey: profile.effectiveDayKey,
            userHasOpenActivityCycle: profile.hasOpenActivityCycle,
            userTypicalWakeHour: profile.typicalWakeHour,
            userTypicalSleepHour: profile.typicalSleepHour,
            userHasSleepData: profile.hasSleepData,
            userIsSleeping: profile.isCurrentlySleeping,
            userLastSleepSignalAt: profile.lastSleepSignalAt,
            userLastWakeSignalAt: profile.lastWakeSignalAt,
            userTypicalSleepDurationMinutes:
              profile.typicalSleepDurationMinutes,
            userScreenContextFocus: profile.screenContextFocus,
            userScreenContextSource: profile.screenContextSource,
            userScreenContextSampledAt: profile.screenContextSampledAt,
            userScreenContextConfidence: profile.screenContextConfidence,
            userScreenContextBusy: profile.screenContextBusy,
            userScreenContextAvailable: profile.screenContextAvailable,
            userScreenContextStale: profile.screenContextStale,
          },
          data: {},
        };
      }
    } catch (error) {
      logger.warn(
        {
          boundary: "activity_profile",
          operation: "provider_profile_read",
          err: error instanceof Error ? error : undefined,
        },
        "[activity-profile] Failed to read proactive task metadata; falling back to time-bucket-only context.",
      );
    }

    return {
      text: `User context: ${bucket}`,
      values: {
        userIsActive: false,
        userPrimaryPlatform: null,
        userLastSeenPlatform: null,
        userLastSeenAt: 0,
        userTimeBucket: bucket,
        userScreenContextFocus: null,
        userScreenContextSource: null,
        userScreenContextSampledAt: null,
        userScreenContextConfidence: null,
        userScreenContextBusy: false,
        userScreenContextAvailable: false,
        userScreenContextStale: false,
        userHasSleepData: false,
        userIsSleeping: false,
        userLastSleepSignalAt: null,
        userLastWakeSignalAt: null,
        userTypicalSleepDurationMinutes: null,
      },
      data: {},
    };
  },
};
