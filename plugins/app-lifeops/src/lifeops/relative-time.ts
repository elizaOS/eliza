import type {
  LifeOpsAwakeProbability,
  LifeOpsCircadianState,
  LifeOpsDayBoundary,
  LifeOpsPersonalBaseline,
  LifeOpsRelativeTime,
  LifeOpsRelativeTimeAnchorSource,
  LifeOpsScheduleInsight,
  LifeOpsScheduleRegularity,
} from "@elizaos/shared";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  formatInstantAsRfc3339InTimeZone,
  getZonedDateParts,
} from "./time.js";
import { parseIsoMs, roundConfidence } from "./time-util.js";

type RelativeTimeScheduleFields = Pick<
  LifeOpsScheduleInsight,
  | "circadianState"
  | "stateConfidence"
  | "uncertaintyReason"
  | "awakeProbability"
  | "regularity"
  | "baseline"
  | "sleepConfidence"
  | "currentSleepStartedAt"
  | "lastSleepStartedAt"
  | "lastSleepEndedAt"
  | "wakeAt"
  | "firstActiveAt"
>;

function defaultAwakeProbability(computedAt: string): LifeOpsAwakeProbability {
  return {
    pAwake: 0,
    pAsleep: 0,
    pUnknown: 1,
    contributingSources: [],
    computedAt,
  };
}

function allowsProjectedBedtime(
  regularity: LifeOpsScheduleRegularity | null | undefined,
): boolean {
  return (
    regularity?.regularityClass === "regular" ||
    regularity?.regularityClass === "very_regular"
  );
}

function allowsFallbackBedtimeFromLastSleep(
  regularity: LifeOpsScheduleRegularity | null | undefined,
): boolean {
  return (
    allowsProjectedBedtime(regularity) ||
    regularity?.regularityClass === "insufficient_data"
  );
}

function minutesBetween(startMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startMs) / 60_000));
}

function localDayBoundary(args: {
  nowMs: number;
  timezone: string;
}): Pick<LifeOpsDayBoundary, "startOfDayAt" | "endOfDayAt"> {
  const parts = getZonedDateParts(new Date(args.nowMs), args.timezone);
  const start = buildUtcDateFromLocalParts(args.timezone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const nextDate = addDaysToLocalDate(parts, 1);
  const end = buildUtcDateFromLocalParts(args.timezone, {
    year: nextDate.year,
    month: nextDate.month,
    day: nextDate.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  return {
    startOfDayAt: start.toISOString(),
    endOfDayAt: end.toISOString(),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
// How far in the past we tolerate before rolling the target forward by a day.
// 18h lets a post-midnight "bedtime was ~2h ago" answer survive, while still
// advancing when the anchor is genuinely stale (e.g. multi-day-old wake).
const BEDTIME_TARGET_MAX_PAST_MS = 18 * 60 * 60 * 1000;
// Symmetric ceiling: the target should never be more than a day in the future,
// otherwise it has rolled to "tomorrow night" when it should be "tonight".
const BEDTIME_TARGET_MAX_FUTURE_MS = DAY_MS;

/**
 * Builds a UTC instant for a normalized local bedtime hour
 * (in the canonical [12, 36) range) anchored on the sleep-day that `anchorMs`
 * belongs to. When no wake anchor is given, the local date of `nowMs` is used.
 * The result is then rolled ±24h so it represents "tonight's" bedtime relative
 * to now: not more than ~18h in the past and not more than ~24h in the future.
 */
function localHourInstantMs(args: {
  timezone: string;
  nowMs: number;
  normalizedHour: number;
  anchorMs?: number | null;
}): number | null {
  if (!Number.isFinite(args.normalizedHour)) {
    return null;
  }
  const anchorParts = getZonedDateParts(
    new Date(args.anchorMs ?? args.nowMs),
    args.timezone,
  );
  const wholeMinutes = Math.round(args.normalizedHour * 60);
  const dayDelta = Math.floor(wholeMinutes / (24 * 60));
  const minuteOfDay = ((wholeMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const baseDate = addDaysToLocalDate(anchorParts, dayDelta);
  let candidate = buildUtcDateFromLocalParts(args.timezone, {
    year: baseDate.year,
    month: baseDate.month,
    day: baseDate.day,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  }).getTime();
  // Advance one day at a time until the target is no longer unreasonably far
  // in the past — this handles stale wake anchors without clobbering a
  // just-passed bedtime (e.g. 12:56 AM after an 11:30 PM target).
  for (let step = 0; step < 14; step += 1) {
    if (candidate >= args.nowMs - BEDTIME_TARGET_MAX_PAST_MS) break;
    candidate += DAY_MS;
  }
  for (let step = 0; step < 14; step += 1) {
    if (candidate <= args.nowMs + BEDTIME_TARGET_MAX_FUTURE_MS) break;
    candidate -= DAY_MS;
  }
  return candidate;
}

function isAsleepState(state: LifeOpsCircadianState): boolean {
  return state === "sleeping" || state === "napping";
}

function isAwakeState(state: LifeOpsCircadianState): boolean {
  return state === "awake" || state === "waking" || state === "winding_down";
}

function baselineBedtimeHour(
  baseline: LifeOpsPersonalBaseline | null | undefined,
): number | null {
  return baseline?.medianBedtimeLocalHour ?? null;
}

function sourceConfidence(
  source: LifeOpsRelativeTimeAnchorSource | null,
): number {
  switch (source) {
    case "sleep_cycle":
      return 0.72;
    case "activity":
      return 0.58;
    case "typical_sleep":
      return 0.54;
    case "day_boundary":
      return 0.4;
    default:
      return 0;
  }
}

export function resolveLifeOpsRelativeTime(args: {
  nowMs: number;
  timezone: string;
  schedule: RelativeTimeScheduleFields;
  dayBoundary?: Pick<LifeOpsDayBoundary, "startOfDayAt" | "endOfDayAt">;
}): LifeOpsRelativeTime {
  const awakeProbability =
    args.schedule.awakeProbability ??
    defaultAwakeProbability(new Date(args.nowMs).toISOString());
  const dayBoundary =
    args.dayBoundary ??
    localDayBoundary({ nowMs: args.nowMs, timezone: args.timezone });
  const isUnclear = args.schedule.circadianState === "unclear";
  // Unclear state means callers should wait for event hooks instead of
  // projecting from baseline medians or stale anchors.
  const wakeAnchorAt = isUnclear
    ? null
    : (args.schedule.wakeAt ??
      args.schedule.lastSleepEndedAt ??
      args.schedule.firstActiveAt ??
      null);
  const wakeAnchorSource: LifeOpsRelativeTimeAnchorSource | null = isUnclear
    ? null
    : args.schedule.wakeAt || args.schedule.lastSleepEndedAt
      ? "sleep_cycle"
      : args.schedule.firstActiveAt
        ? "activity"
        : null;
  const wakeAnchorMs = parseIsoMs(wakeAnchorAt);
  const currentSleepStartedMs = parseIsoMs(args.schedule.currentSleepStartedAt);
  const lastSleepStartedMs = parseIsoMs(args.schedule.lastSleepStartedAt);
  // Anchor the bedtime target on the sleep-day (local date of the wake
  // instant) rather than the calendar date of `now`. This makes "bedtime was
  // ~90m ago" the correct answer when the user is up past midnight instead
  // of flipping to tomorrow night's target.
  const bedtimeAnchorMs = wakeAnchorMs ?? null;
  const bedtimeHour = baselineBedtimeHour(args.schedule.baseline);
  const typicalBedtimeMs =
    !isUnclear &&
    allowsProjectedBedtime(args.schedule.regularity) &&
    bedtimeHour !== null
      ? localHourInstantMs({
          timezone: args.timezone,
          nowMs: args.nowMs,
          normalizedHour: bedtimeHour,
          anchorMs: bedtimeAnchorMs,
        })
      : null;
  const fallbackBedtimeMs =
    !isUnclear &&
    typicalBedtimeMs === null &&
    allowsFallbackBedtimeFromLastSleep(args.schedule.regularity) &&
    lastSleepStartedMs !== null
      ? localHourInstantMs({
          timezone: args.timezone,
          nowMs: args.nowMs,
          normalizedHour: (() => {
            const parts = getZonedDateParts(
              new Date(lastSleepStartedMs),
              args.timezone,
            );
            const hour = parts.hour + parts.minute / 60;
            return hour < 12 ? hour + 24 : hour;
          })(),
          anchorMs: bedtimeAnchorMs,
        })
      : null;
  const bedtimeTargetMs =
    isAsleepState(args.schedule.circadianState) &&
    currentSleepStartedMs !== null
      ? currentSleepStartedMs
      : (typicalBedtimeMs ?? fallbackBedtimeMs);
  const bedtimeTargetSource: LifeOpsRelativeTimeAnchorSource | null =
    isAsleepState(args.schedule.circadianState) &&
    currentSleepStartedMs !== null
      ? "sleep_cycle"
      : typicalBedtimeMs !== null
        ? "typical_sleep"
        : fallbackBedtimeMs !== null
          ? "sleep_cycle"
          : null;
  const startOfDayMs = Date.parse(dayBoundary.startOfDayAt);
  const endOfDayMs = Date.parse(dayBoundary.endOfDayAt);
  const minutesSinceWake =
    wakeAnchorMs !== null && wakeAnchorMs <= args.nowMs
      ? minutesBetween(wakeAnchorMs, args.nowMs)
      : null;
  const minutesAwake = isAwakeState(args.schedule.circadianState)
    ? minutesSinceWake
    : null;
  const minutesUntilBedtimeTarget =
    bedtimeTargetMs === null || bedtimeTargetMs < args.nowMs
      ? null
      : Math.round((bedtimeTargetMs - args.nowMs) / 60_000);
  const minutesSinceBedtimeTarget =
    bedtimeTargetMs === null || bedtimeTargetMs > args.nowMs
      ? null
      : minutesBetween(bedtimeTargetMs, args.nowMs);
  return {
    computedAt: new Date(args.nowMs).toISOString(),
    localNowAt: formatInstantAsRfc3339InTimeZone(
      new Date(args.nowMs),
      args.timezone,
    ),
    circadianState: args.schedule.circadianState,
    stateConfidence: roundConfidence(args.schedule.stateConfidence),
    uncertaintyReason: args.schedule.uncertaintyReason,
    awakeProbability,
    wakeAnchorAt,
    wakeAnchorSource,
    minutesSinceWake,
    minutesAwake,
    bedtimeTargetAt:
      bedtimeTargetMs === null ? null : new Date(bedtimeTargetMs).toISOString(),
    bedtimeTargetSource,
    minutesUntilBedtimeTarget,
    minutesSinceBedtimeTarget,
    dayBoundaryStartAt: dayBoundary.startOfDayAt,
    dayBoundaryEndAt: dayBoundary.endOfDayAt,
    minutesSinceDayBoundaryStart: Number.isFinite(startOfDayMs)
      ? minutesBetween(startOfDayMs, args.nowMs)
      : 0,
    minutesUntilDayBoundaryEnd: Number.isFinite(endOfDayMs)
      ? Math.max(0, Math.round((endOfDayMs - args.nowMs) / 60_000))
      : 0,
    confidence: roundConfidence(
      Math.max(
        awakeProbability.pAwake,
        awakeProbability.pAsleep,
        args.schedule.sleepConfidence,
        sourceConfidence(wakeAnchorSource),
        sourceConfidence(bedtimeTargetSource),
      ),
    ),
  };
}

export function refreshLifeOpsRelativeTime<
  T extends RelativeTimeScheduleFields & { timezone: string },
>(state: T, now: Date): T & { relativeTime: LifeOpsRelativeTime } {
  return {
    ...state,
    relativeTime: resolveLifeOpsRelativeTime({
      nowMs: now.getTime(),
      timezone: state.timezone,
      schedule: state,
    }),
  };
}
