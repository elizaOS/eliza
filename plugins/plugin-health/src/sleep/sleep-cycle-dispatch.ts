import type {
  LifeOpsCircadianState,
  LifeOpsPersonalBaseline,
  LifeOpsRegularityClass,
  LifeOpsScheduleRegularity,
} from "@elizaos/shared";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "../util/time.js";
import { parseIsoMs } from "../util/time-util.js";
import type { SleepRecap } from "./sleep-recap.js";

export const MORNING_CHECKIN_WINDOW_MINUTES = 6 * 60;
export const NIGHT_CHECKIN_LEAD_MINUTES = 3 * 60;
// Default bedtime when an irregular-schedule owner has not configured a
// `nightCheckinTime` profile field. Matches the documented night-summary
// expectation in the lifeops T9f plan.
export const DEFAULT_IRREGULAR_BEDTIME_LOCAL = "23:00";

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

export interface CheckinSleepCycleState {
  readonly circadianState: LifeOpsCircadianState;
  readonly wakeAt: string | null;
  readonly timezone?: string;
  readonly regularity?: {
    readonly regularityClass: LifeOpsRegularityClass;
  };
  readonly relativeTime: {
    readonly minutesUntilBedtimeTarget: number | null;
  };
}

function parseHHMM(value: string | null | undefined): {
  hour: number;
  minute: number;
} | null {
  if (typeof value !== "string") return null;
  const match = HHMM_RE.exec(value.trim());
  if (!match) return null;
  const [, rawHour = "", rawMinute = ""] = match;
  const hour = Number.parseInt(rawHour, 10);
  const minute = Number.parseInt(rawMinute, 10);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * For owners whose schedule is `irregular` / `very_irregular`, the relative
 * time resolver leaves `bedtimeTargetAt` null because no projection is
 * trustworthy. Without a fallback the night summary never fires for these
 * users. Compute "minutes until the next occurrence of `localBedtime`
 * (local-time HH:MM) in `timezone`" — today if still upcoming, otherwise
 * tomorrow.
 *
 * Returns null when inputs are missing or invalid; callers fall back to the
 * normal bedtime-projection path in that case.
 */
export function minutesUntilLocalBedtime(args: {
  readonly now: Date;
  readonly timezone: string;
  readonly localBedtime: string;
}): number | null {
  const parts = parseHHMM(args.localBedtime);
  if (!parts) return null;
  const nowParts = getZonedDateParts(args.now, args.timezone);
  const todayInstant = buildUtcDateFromLocalParts(args.timezone, {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: 0,
  }).getTime();
  const nowMs = args.now.getTime();
  const candidateMs =
    todayInstant >= nowMs
      ? todayInstant
      : buildUtcDateFromLocalParts(args.timezone, {
          year: nowParts.year,
          month: nowParts.month,
          day: nowParts.day + 1,
          hour: parts.hour,
          minute: parts.minute,
          second: 0,
        }).getTime();
  return Math.round((candidateMs - nowMs) / 60_000);
}

function isIrregular(
  regularityClass: LifeOpsRegularityClass | undefined,
): boolean {
  return (
    regularityClass === "irregular" || regularityClass === "very_irregular"
  );
}

export function shouldRunMorningCheckinFromSleepCycle(args: {
  readonly state: CheckinSleepCycleState | null;
  readonly now: Date;
}): boolean {
  if (!args.state || args.state.circadianState !== "awake") {
    return false;
  }
  const wakeAtMs = parseIsoMs(args.state.wakeAt);
  if (wakeAtMs === null) {
    return false;
  }
  const minutesSinceWake = (args.now.getTime() - wakeAtMs) / 60_000;
  return (
    minutesSinceWake >= 0 && minutesSinceWake <= MORNING_CHECKIN_WINDOW_MINUTES
  );
}

/**
 * Decide whether the night summary should fire on this scheduler tick.
 *
 * Triggers (any one is sufficient):
 * 1. `circadianState === "winding_down"` (early signal from HID-idle / lock).
 * 2. `circadianState` is `awake` or `waking` AND
 *    `minutesUntilBedtimeTarget` is inside `NIGHT_CHECKIN_LEAD_MINUTES`.
 * 3. Irregular-owner fallback: `regularityClass` is `irregular` /
 *    `very_irregular`, `minutesUntilBedtimeTarget` is null, and the owner's
 *    `nightFallbackBedtimeLocal` (or 23:00 default) is inside the lead window.
 *
 * `nightFallbackBedtimeLocal` is read from the owner's `nightCheckinTime`
 * profile field by `processSleepCycleCheckins` and threaded in here. It is
 * not consulted for `regular` / `very_regular` owners — those flow through
 * the schedule's bedtime projection exclusively.
 */
export function shouldRunNightCheckinFromSleepCycle(args: {
  readonly state: CheckinSleepCycleState | null;
  readonly now?: Date;
  readonly nightFallbackBedtimeLocal?: string | null;
}): boolean {
  if (!args.state) {
    return false;
  }
  // `winding_down` is the circadian-rules answer for "user is winding down":
  // HID idle >=20m or session locked >=30m outside the overnight window. Treat
  // it as an immediate night-summary trigger so an irregular-schedule owner
  // who winds down at an unusual time still gets the night check-in even when
  // the bedtime-window proximity check below would not fire.
  if (args.state.circadianState === "winding_down") {
    return true;
  }
  if (
    args.state.circadianState !== "awake" &&
    args.state.circadianState !== "waking"
  ) {
    return false;
  }
  const minutes = args.state.relativeTime.minutesUntilBedtimeTarget;
  if (
    typeof minutes === "number" &&
    Number.isFinite(minutes) &&
    minutes >= 0 &&
    minutes <= NIGHT_CHECKIN_LEAD_MINUTES
  ) {
    return true;
  }
  // Irregular-owner fallback: relative-time leaves `bedtimeTargetAt` null
  // because there's no trustworthy projection. Use the owner's configured
  // `nightCheckinTime` (or the 23:00 default) so the night summary still
  // fires inside the same NIGHT_CHECKIN_LEAD_MINUTES lead.
  if (
    isIrregular(args.state.regularity?.regularityClass) &&
    args.state.timezone &&
    args.now
  ) {
    const fallbackHHMM =
      args.nightFallbackBedtimeLocal ?? DEFAULT_IRREGULAR_BEDTIME_LOCAL;
    const fallbackMinutes = minutesUntilLocalBedtime({
      now: args.now,
      timezone: args.state.timezone,
      localBedtime: fallbackHHMM,
    });
    if (
      fallbackMinutes !== null &&
      fallbackMinutes >= 0 &&
      fallbackMinutes <= NIGHT_CHECKIN_LEAD_MINUTES
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Project the four sleep-recap fields out of a merged schedule-state record
 * (or any object exposing the same `baseline` / `regularity` shape) so the
 * night-summary prompt can surface them. Returns null when neither a baseline
 * nor a regularity reading is available — the prompt drops the recap
 * section entirely in that case rather than printing "0/100" placeholders.
 *
 * Intentional design: `medianBedtimeLocalHour` and `medianSleepDurationMin`
 * land as null when the baseline is null (fewer than 5 episodes recorded);
 * `sri` and `regularityClass` always have defaults from the regularity
 * scorer (`insufficient_data` + 0) so we surface them when we have anything
 * to show.
 */
export function buildSleepRecapFromSchedule(
  schedule: {
    readonly baseline: LifeOpsPersonalBaseline | null;
    readonly regularity: LifeOpsScheduleRegularity;
  } | null,
): SleepRecap | null {
  if (!schedule) {
    return null;
  }
  return {
    medianBedtimeLocalHour: schedule.baseline?.medianBedtimeLocalHour ?? null,
    medianSleepDurationMin: schedule.baseline?.medianSleepDurationMin ?? null,
    sri: schedule.regularity.sri,
    regularityClass: schedule.regularity.regularityClass,
  };
}
