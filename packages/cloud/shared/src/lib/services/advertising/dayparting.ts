/**
 * Dayparting window evaluation (#11599).
 *
 * `daysOfWeek` uses 0=Sunday..6=Saturday (the JS `Date#getDay` / Meta
 * `adset_schedule` convention). Window times are `HH:mm` in the schedule's own
 * IANA timezone — evaluation converts the instant into that timezone via Intl,
 * never the server's local time.
 */

import type { CampaignDaypartingSchedule } from "./types";

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localTimeToMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Day-of-week (0=Sun) and minute-of-day of `at` in `timeZone`. */
function localDayMinute(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  let day: number | undefined;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "weekday") day = WEEKDAY_TO_INDEX[part.value];
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  if (day === undefined) {
    throw new Error(`Could not resolve local weekday for timezone ${timeZone}`);
  }
  return { day, minute: hour * 60 + minute };
}

/**
 * True when `at` falls inside one of the schedule's windows. Window bounds are
 * half-open local intervals: [startTime, endTime).
 */
export function isWithinDayparting(schedule: CampaignDaypartingSchedule, at: Date): boolean {
  const { day, minute } = localDayMinute(at, schedule.timezone);
  return schedule.windows.some(
    (window) =>
      window.daysOfWeek.includes(day) &&
      minute >= localTimeToMinute(window.startTime) &&
      minute < localTimeToMinute(window.endTime),
  );
}
