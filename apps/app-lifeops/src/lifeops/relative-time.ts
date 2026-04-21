import type {
  LifeOpsDayBoundary,
  LifeOpsRelativeTime,
  LifeOpsRelativeTimeAnchorSource,
  LifeOpsScheduleInsight,
} from "@elizaos/shared/contracts/lifeops";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  formatInstantAsRfc3339InTimeZone,
  getZonedDateParts,
} from "./time.js";

type RelativeTimeScheduleFields = Pick<
  LifeOpsScheduleInsight,
  | "phase"
  | "isProbablySleeping"
  | "sleepConfidence"
  | "currentSleepStartedAt"
  | "lastSleepStartedAt"
  | "lastSleepEndedAt"
  | "typicalSleepHour"
  | "wakeAt"
  | "firstActiveAt"
>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundConfidence(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100) / 100;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function localHourInstantMs(args: {
  timezone: string;
  nowMs: number;
  normalizedHour: number;
}): number | null {
  if (!Number.isFinite(args.normalizedHour)) {
    return null;
  }
  const nowParts = getZonedDateParts(new Date(args.nowMs), args.timezone);
  const wholeMinutes = Math.round(args.normalizedHour * 60);
  const dayDelta = Math.floor(wholeMinutes / (24 * 60));
  const minuteOfDay = ((wholeMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  for (let extraDays = 0; extraDays <= 2; extraDays += 1) {
    const date = addDaysToLocalDate(nowParts, dayDelta + extraDays);
    const candidate = buildUtcDateFromLocalParts(args.timezone, {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    }).getTime();
    if (candidate >= args.nowMs - 60_000) {
      return candidate;
    }
  }
  return null;
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
  const dayBoundary =
    args.dayBoundary ??
    localDayBoundary({ nowMs: args.nowMs, timezone: args.timezone });
  const wakeAnchorAt =
    args.schedule.wakeAt ??
    args.schedule.lastSleepEndedAt ??
    args.schedule.firstActiveAt ??
    null;
  const wakeAnchorSource: LifeOpsRelativeTimeAnchorSource | null =
    args.schedule.wakeAt || args.schedule.lastSleepEndedAt
      ? "sleep_cycle"
      : args.schedule.firstActiveAt
        ? "activity"
        : null;
  const wakeAnchorMs = parseIsoMs(wakeAnchorAt);
  const currentSleepStartedMs = parseIsoMs(args.schedule.currentSleepStartedAt);
  const lastSleepStartedMs = parseIsoMs(args.schedule.lastSleepStartedAt);
  const typicalBedtimeMs =
    args.schedule.typicalSleepHour !== null
      ? localHourInstantMs({
          timezone: args.timezone,
          nowMs: args.nowMs,
          normalizedHour: args.schedule.typicalSleepHour,
        })
      : null;
  const fallbackBedtimeMs =
    typicalBedtimeMs === null && lastSleepStartedMs !== null
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
        })
      : null;
  const bedtimeTargetMs =
    args.schedule.isProbablySleeping && currentSleepStartedMs !== null
      ? currentSleepStartedMs
      : (typicalBedtimeMs ?? fallbackBedtimeMs);
  const bedtimeTargetSource: LifeOpsRelativeTimeAnchorSource | null =
    args.schedule.isProbablySleeping && currentSleepStartedMs !== null
      ? "sleep_cycle"
      : typicalBedtimeMs !== null
        ? "typical_sleep"
        : fallbackBedtimeMs !== null
          ? "sleep_cycle"
          : null;
  const startOfDayMs = Date.parse(dayBoundary.startOfDayAt);
  const endOfDayMs = Date.parse(dayBoundary.endOfDayAt);
  const minutesUntilBedtimeTarget =
    bedtimeTargetMs === null || bedtimeTargetMs < args.nowMs
      ? null
      : Math.round((bedtimeTargetMs - args.nowMs) / 60_000);
  const minutesSinceBedtimeTarget =
    bedtimeTargetMs === null || bedtimeTargetMs > args.nowMs
      ? null
      : minutesBetween(bedtimeTargetMs, args.nowMs);
  return {
    localNowAt: formatInstantAsRfc3339InTimeZone(
      new Date(args.nowMs),
      args.timezone,
    ),
    phase: args.schedule.phase,
    isProbablySleeping: args.schedule.isProbablySleeping,
    wakeAnchorAt,
    wakeAnchorSource,
    minutesSinceWake:
      wakeAnchorMs !== null && wakeAnchorMs <= args.nowMs
        ? minutesBetween(wakeAnchorMs, args.nowMs)
        : null,
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
