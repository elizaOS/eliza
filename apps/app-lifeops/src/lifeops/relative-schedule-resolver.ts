import type {
  LifeOpsRegularityClass,
  LifeOpsWorkflowSchedule,
} from "@elizaos/shared/contracts/lifeops";
import type { LifeOpsScheduleMergedStateRecord } from "./repository.js";
import {
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "./time.js";

const REGULARITY_RANK: Record<LifeOpsRegularityClass, number> = {
  insufficient_data: 0,
  very_irregular: 1,
  irregular: 2,
  regular: 3,
  very_regular: 4,
};

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function zonedWeekday(ms: number, timezone: string): number {
  return new Date(
    new Date(ms).toLocaleString("en-US", { timeZone: timezone }),
  ).getDay();
}

function regularitySatisfied(
  actual: LifeOpsRegularityClass,
  required: LifeOpsRegularityClass | undefined,
): boolean {
  if (!required) {
    return true;
  }
  return REGULARITY_RANK[actual] >= REGULARITY_RANK[required];
}

function weekdayMatches(
  targetMs: number,
  timezone: string,
  allowedWeekdays: number[] | undefined,
): boolean {
  if (!allowedWeekdays || allowedWeekdays.length === 0) {
    return true;
  }
  return allowedWeekdays.includes(zonedWeekday(targetMs, timezone));
}

function nextProjectedLocalInstant(args: {
  timezone: string;
  cursorMs: number;
  localHour: number;
  allowedWeekdays?: number[];
}): number | null {
  const parts = getZonedDateParts(new Date(args.cursorMs), args.timezone);
  const totalMinutes = Math.round(args.localHour * 60);
  const minuteOfDay = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    const candidate = buildUtcDateFromLocalParts(args.timezone, {
      year: parts.year,
      month: parts.month,
      day: parts.day + dayOffset,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    }).getTime();
    if (candidate <= args.cursorMs) {
      continue;
    }
    if (weekdayMatches(candidate, args.timezone, args.allowedWeekdays)) {
      return candidate;
    }
  }
  return null;
}

export function resolveNextRelativeScheduleInstant(args: {
  schedule:
    | Extract<LifeOpsWorkflowSchedule, { kind: "relative_to_wake" }>
    | Extract<LifeOpsWorkflowSchedule, { kind: "relative_to_bedtime" }>;
  state: LifeOpsScheduleMergedStateRecord | null;
  cursorIso?: string | null;
  nowMs: number;
}): string | null {
  const cursorMs = args.cursorIso ? Date.parse(args.cursorIso) : args.nowMs;
  const state = args.state;
  if (!state) {
    return null;
  }
  if (
    !regularitySatisfied(
      state.regularity.regularityClass,
      args.schedule.requireRegularityAtLeast,
    )
  ) {
    return null;
  }

  const anchorIso =
    args.schedule.kind === "relative_to_wake"
      ? state.wakeAt
      : state.relativeTime.bedtimeTargetAt;
  const anchorMs = parseIsoMs(anchorIso);
  if (anchorMs !== null) {
    const targetMs = anchorMs + args.schedule.offsetMinutes * 60_000;
    if (
      targetMs > cursorMs &&
      weekdayMatches(targetMs, state.timezone, args.schedule.onDays)
    ) {
      return new Date(targetMs).toISOString();
    }
  }

  const projectedHour =
    args.schedule.kind === "relative_to_wake"
      ? state.typicalWakeHour
      : state.typicalSleepHour;
  if (projectedHour === null) {
    return null;
  }
  const projectedAnchorMs = nextProjectedLocalInstant({
    timezone: state.timezone,
    cursorMs,
    localHour: projectedHour,
    allowedWeekdays: args.schedule.onDays,
  });
  if (projectedAnchorMs === null) {
    return null;
  }
  return new Date(
    projectedAnchorMs + args.schedule.offsetMinutes * 60_000,
  ).toISOString();
}
