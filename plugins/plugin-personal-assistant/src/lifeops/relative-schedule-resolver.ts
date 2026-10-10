/**
 * Resolves relative/regularity-based schedules into concrete next-run instants:
 * ranks the owner's schedule-regularity class and merged schedule state to place
 * the next workflow/reminder fire in the owner's local time zone.
 */

import {
  type LifeOpsRegularityClass,
  type LifeOpsWorkflowSchedule,
  parseIsoMs,
} from "@elizaos/contracts";
import type { LifeOpsScheduleMergedStateRecord } from "./repository.js";
import {
  addDaysToLocalDate,
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
  /**
   * Offset applied to the anchor to get the actual fire instant. The advance
   * condition must be evaluated on `anchor + offset`, not the anchor alone: a
   * negative offset (during_night, "before bedtime" offsets) can place the
   * fire instant behind the cursor even when the anchor is ahead of it, and
   * re-resolving from that fire instant would then return the SAME past
   * instant forever — the scheduler loop refires the workflow `limit` times
   * per tick instead of advancing to the next occurrence.
   */
  offsetMinutes: number;
  allowedWeekdays?: number[];
}): number | null {
  const parts = getZonedDateParts(new Date(args.cursorMs), args.timezone);
  const totalMinutes = Math.round(args.localHour * 60);
  // The local hour is canonical in [12, 36) for bedtime: whole days in it
  // are the after-midnight carry into the next civil day. That carry must
  // move the candidate date (as localHourInstantMs does for concrete
  // anchors); wrapping it away attributes the occurrence to the wrong
  // sleep-day.
  const dayDelta = Math.floor(totalMinutes / (24 * 60));
  const minuteOfDay = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const offsetMs = args.offsetMinutes * 60000;
  // After midnight, the previous sleep-day can still have a future bedtime.
  for (let dayOffset = -dayDelta; dayOffset < 14; dayOffset += 1) {
    const sleepDay = addDaysToLocalDate(parts, dayOffset);
    const date = addDaysToLocalDate(parts, dayOffset + dayDelta);
    const candidate = buildUtcDateFromLocalParts(args.timezone, {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    }).getTime();
    if (candidate + offsetMs <= args.cursorMs) {
      continue;
    }
    // Weekday restrictions apply to the anchor's local day (the sleep-day the
    // occurrence belongs to), not the offsetted fire instant — and not the
    // civil day the after-midnight carry lands on.
    const sleepDayMs = buildUtcDateFromLocalParts(args.timezone, {
      year: sleepDay.year,
      month: sleepDay.month,
      day: sleepDay.day,
      hour: 12,
      minute: 0,
      second: 0,
    }).getTime();
    if (weekdayMatches(sleepDayMs, args.timezone, args.allowedWeekdays)) {
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
function isAnchorKind(schedule: RelativeScheduleKind): schedule is Extract<
  LifeOpsWorkflowSchedule,
  {
    kind: "relative_to_wake" | "during_morning";
  }
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
    const targetMs = anchorMs + offsetMinutes * 60000;
    // Weekday restrictions apply to the anchor's local day (the sleep-day the
    // occurrence belongs to), not the offsetted fire instant. A negative
    // offset (relative_to_bedtime / during_night) can push the fire instant
    // across local midnight onto the previous weekday; gating on `targetMs`
    // there fires on a day the owner did not request or silently drops a day
    // they did. This mirrors the anchor-day rule in `nextProjectedLocalInstant`.
    // A bedtime is canonical in local hours [12, 36), so one before noon
    // belongs to the previous civil day's sleep-day.
    let anchorDayMs = anchorMs;
    if (!isAnchorKind(args.schedule)) {
      const local = getZonedDateParts(new Date(anchorMs), state.timezone);
      const sleepDay = addDaysToLocalDate(local, local.hour < 12 ? -1 : 0);
      anchorDayMs = buildUtcDateFromLocalParts(state.timezone, {
        ...sleepDay,
        hour: 12,
        minute: 0,
        second: 0,
      }).getTime();
    }
    if (
      targetMs > cursorMs &&
      weekdayMatches(anchorDayMs, state.timezone, args.schedule.onDays)
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
    offsetMinutes,
    allowedWeekdays: args.schedule.onDays,
  });
  if (projectedAnchorMs === null) {
    return null;
  }
  return new Date(projectedAnchorMs + offsetMinutes * 60000).toISOString();
}
