import type {
  LifeOpsRegularityClass,
  LifeOpsWorkflowSchedule,
} from "@elizaos/shared";
import type { LifeOpsScheduleMergedStateRecord } from "./repository.js";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "./time.js";
import { parseIsoMs } from "./time-util.js";

const REGULARITY_RANK: Record<LifeOpsRegularityClass, number> = {
  insufficient_data: 0,
  very_irregular: 1,
  irregular: 2,
  regular: 3,
  very_regular: 4,
};

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

type RelativeScheduleKind = Extract<
  LifeOpsWorkflowSchedule,
  {
    kind:
      | "relative_to_wake"
      | "relative_to_bedtime"
      | "during_morning"
      | "during_night";
  }
>;

function isAnchorKind(
  schedule: RelativeScheduleKind,
): schedule is Extract<
  LifeOpsWorkflowSchedule,
  { kind: "relative_to_wake" | "during_morning" }
> {
  return (
    schedule.kind === "relative_to_wake" || schedule.kind === "during_morning"
  );
}

function offsetMinutesFor(schedule: RelativeScheduleKind): number {
  if (
    schedule.kind === "relative_to_wake" ||
    schedule.kind === "relative_to_bedtime"
  ) {
    return schedule.offsetMinutes;
  }
  if (schedule.kind === "during_morning") {
    return 0;
  }
  // during_night: fires at (bedtimeTarget - windowMinutesBeforeSleepTarget).
  return -(schedule.windowMinutesBeforeSleepTarget ?? 120);
}

export function resolveNextRelativeScheduleInstant(args: {
  schedule: RelativeScheduleKind;
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

  const anchorIso = isAnchorKind(args.schedule)
    ? state.wakeAt
    : state.relativeTime.bedtimeTargetAt;
  const anchorMs = parseIsoMs(anchorIso);
  const offsetMinutes = offsetMinutesFor(args.schedule);

  // relative_to_wake with stabilityWindowMinutes requires `wake.confirmed`,
  // which is signalled by the merged-state circadianState having advanced
  // past `waking` (i.e. `awake`). When the stability condition is not met,
  // defer to the event-workflow path — return null rather than project.
  if (
    args.schedule.kind === "relative_to_wake" &&
    typeof args.schedule.stabilityWindowMinutes === "number" &&
    state.circadianState !== "awake"
  ) {
    return null;
  }

  if (anchorMs !== null) {
    const targetMs = anchorMs + offsetMinutes * 60_000;
    if (
      targetMs > cursorMs &&
      weekdayMatches(targetMs, state.timezone, args.schedule.onDays)
    ) {
      return new Date(targetMs).toISOString();
    }
  }

  const baseline = state.baseline;
  if (baseline === null) {
    return null;
  }
  const projectedHour = isAnchorKind(args.schedule)
    ? baseline.medianWakeLocalHour
    : baseline.medianBedtimeLocalHour;
  if (!Number.isFinite(projectedHour)) {
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
  return new Date(projectedAnchorMs + offsetMinutes * 60_000).toISOString();
}
