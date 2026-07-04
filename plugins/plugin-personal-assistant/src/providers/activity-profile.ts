/**
 * `activity-profile` provider — owner-and-agent-only ambient presence context.
 *
 * Reads the proactive-worker task metadata (last-seen platform, sleep/wake
 * signals, screen-focus) and the activity-tracker foreground-app report, then
 * renders a compact single-line context string plus structured `values` the
 * planner uses to reason about whether the owner is active, sleeping, or busy.
 * Gated to the owner role and to the screen_time / tasks / health contexts.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type ActivityAppBreakdown,
  type ActivityForegroundApp,
  type ActivityReport,
  getActivityReportBetween,
  getLatestForegroundActivity,
} from "../activity-profile/activity-tracker-reporting.js";
import { resolveCurrentBucket } from "../activity-profile/analyzer.js";
import { PROACTIVE_TASK_TAGS } from "../activity-profile/proactive-worker.js";
import { readProfileFromMetadata } from "../activity-profile/service.js";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import {
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getZonedDateParts,
} from "../lifeops/time.js";

const MAX_PROFILE_TASKS = 25;
const ACTIVITY_USAGE_TOP_APPS = 3;

type ActivityProviderValues = NonNullable<ProviderResult["values"]>;
type ActivityProviderData = NonNullable<ProviderResult["data"]>;

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

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function formatTopApps(apps: ActivityAppBreakdown[]): string {
  return apps
    .filter((app) => app.totalMs > 0)
    .slice(0, ACTIVITY_USAGE_TOP_APPS)
    .map((app) => `${app.appName} ${formatDuration(app.totalMs)}`)
    .join(", ");
}

export function formatActivityUsageContext(args: {
  current: ActivityForegroundApp | null;
  report: ActivityReport;
}): string | null {
  const parts: string[] = [];
  if (args.current) {
    parts.push(
      `current app ${args.current.appName} for ${formatDuration(
        args.current.activeMs,
      )}`,
    );
  }

  const topApps = formatTopApps(args.report.apps);
  if (topApps) {
    parts.push(`today apps ${topApps}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

async function readActivityUsageContext(args: {
  runtime: IAgentRuntime;
  timezone: string;
  now: Date;
}): Promise<{
  text: string | null;
  current: ActivityForegroundApp | null;
  report: ActivityReport;
}> {
  const zonedParts = getZonedDateParts(args.now, args.timezone);
  const dayStart = buildUtcDateFromLocalParts(args.timezone, {
    ...zonedParts,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const sinceMs = dayStart.getTime();
  const untilMs = args.now.getTime();
  const [report, current] = await Promise.all([
    getActivityReportBetween(args.runtime, String(args.runtime.agentId), {
      sinceMs,
      untilMs,
      limit: ACTIVITY_USAGE_TOP_APPS,
    }),
    getLatestForegroundActivity(args.runtime, String(args.runtime.agentId), {
      sinceMs,
      untilMs,
    }),
  ]);
  return {
    text: formatActivityUsageContext({ current, report }),
    current,
    report,
  };
}

export const activityProfileProvider: Provider = {
  name: "activity-profile",
  description:
    "Owner and agent only. Compact user activity context: platform, app usage, time bucket, recency.",
  descriptionCompressed:
    "owner+agent activity: platform, app usage, time bucket, recency",
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
    const baseValues: ActivityProviderValues = {
      userIsActive: false,
      userPrimaryPlatform: null,
      userLastSeenPlatform: null,
      userLastSeenAt: 0,
      userTimeBucket: bucket,
      userEffectiveDayKey: null,
      userHasOpenActivityCycle: false,
      userTypicalWakeHour: null,
      userTypicalSleepHour: null,
      userHasSleepData: false,
      userIsSleeping: false,
      userLastSleepSignalAt: null,
      userLastWakeSignalAt: null,
      userTypicalSleepDurationMinutes: null,
      userScreenContextFocus: null,
      userScreenContextSource: null,
      userScreenContextSampledAt: null,
      userScreenContextConfidence: null,
      userScreenContextBusy: false,
      userScreenContextAvailable: false,
      userScreenContextStale: false,
      userCurrentAppName: null,
      userCurrentAppBundleId: null,
      userCurrentAppActiveMs: null,
      userTodayAppUsage: [] as Array<{
        appName: string;
        bundleId: string;
        totalMs: number;
        sessionCount: number;
      }>,
      userTodayAppUsageTotalMs: 0,
    };
    let values: ActivityProviderValues = { ...baseValues };
    let data: ActivityProviderData = {};
    const parts: string[] = [];
    let profileLoaded = false;

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

        values = {
          ...values,
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
          userTypicalSleepDurationMinutes: profile.typicalSleepDurationMinutes,
          userScreenContextFocus: profile.screenContextFocus,
          userScreenContextSource: profile.screenContextSource,
          userScreenContextSampledAt: profile.screenContextSampledAt,
          userScreenContextConfidence: profile.screenContextConfidence,
          userScreenContextBusy: profile.screenContextBusy,
          userScreenContextAvailable: profile.screenContextAvailable,
          userScreenContextStale: profile.screenContextStale,
        };
        profileLoaded = true;
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

    try {
      const usage = await readActivityUsageContext({ runtime, timezone, now });
      if (usage.text) {
        parts.push(usage.text);
        logger.debug(
          {
            boundary: "activity_profile",
            operation: "provider_activity_usage_context",
            currentAppPresent: usage.current !== null,
            topAppCount: usage.report.apps.length,
          },
          "[activity-profile] Injected ambient app-usage context.",
        );
      }
      values = {
        ...values,
        userCurrentAppName: usage.current?.appName ?? null,
        userCurrentAppBundleId: usage.current?.bundleId ?? null,
        userCurrentAppActiveMs: usage.current?.activeMs ?? null,
        userTodayAppUsage: usage.report.apps.map((app) => ({
          appName: app.appName,
          bundleId: app.bundleId,
          totalMs: app.totalMs,
          sessionCount: app.sessionCount,
        })),
        userTodayAppUsageTotalMs: usage.report.totalMs,
      };
      data = {
        ...data,
        activityUsage: {
          current: usage.current,
          today: usage.report,
        },
      };
    } catch (error) {
      logger.warn(
        {
          boundary: "activity_profile",
          operation: "provider_activity_usage_read",
          err: error instanceof Error ? error : undefined,
        },
        "[activity-profile] Failed to read ambient app-usage context; continuing without app-usage context.",
      );
    }

    if (parts.length > 0) {
      return {
        text: `User: ${parts.join(" | ")}`,
        values,
        data,
      };
    }

    return {
      text: profileLoaded ? "" : `User context: ${bucket}`,
      values,
      data,
    };
  },
};
