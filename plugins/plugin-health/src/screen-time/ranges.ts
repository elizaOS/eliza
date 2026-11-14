/**
 * Screen-time range helpers: label formatting, current and prior window
 * computation, and history-day enumeration for a given range key.
 */
import type { LifeOpsScreenTimeRangeKey } from "../contracts/lifeops.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "../util/time.js";

export interface ScreenTimeWindow {
  since: string;
  until: string;
}

export interface ScreenTimeHistoryDay extends ScreenTimeWindow {
  date: string;
  label: string;
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// The day key must come from the LOCAL calendar date, not toISOString():
// local midnight in any UTC+ timezone maps to the previous UTC date, which
// would shift every history bucket back a day (e.g. Tokyo 2026-06-01T00:00
// local is 2026-05-31T15:00Z).
function localDateKey(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(
    date.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}

/**
 * Day arithmetic in one zone. With `timeZone` the days are that zone's civil
 * days (a server reporting for its owner); without one they are the host's,
 * which is the user's own zone when this runs in their app.
 */
interface DayCalendar {
  startOfDay(date: Date): Date;
  addDays(date: Date, days: number): Date;
  weekday(date: Date): number;
  dateKey(date: Date): string;
  label(date: Date): string;
}

const hostCalendar: DayCalendar = {
  startOfDay: startOfLocalDay,
  addDays,
  weekday: (date) => date.getDay(),
  dateKey: localDateKey,
  label: (date) =>
    new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(date),
};

function zonedCalendar(timeZone: string): DayCalendar {
  const midnight = { hour: 0, minute: 0, second: 0 };
  const day = (date: Date) => {
    const { year, month, day } = getZonedDateParts(date, timeZone);
    return { year, month, day };
  };
  return {
    startOfDay: (date) =>
      buildUtcDateFromLocalParts(timeZone, { ...day(date), ...midnight }),
    addDays: (date, days) =>
      buildUtcDateFromLocalParts(timeZone, {
        ...addDaysToLocalDate(day(date), days),
        ...midnight,
      }),
    weekday: (date) => getWeekdayForLocalDate(day(date)),
    dateKey: (date) => getLocalDateKey(day(date)),
    label: (date) =>
      new Intl.DateTimeFormat(undefined, {
        month: "numeric",
        day: "numeric",
        timeZone,
      }).format(date),
  };
}

function calendarFor(timeZone: string | undefined): DayCalendar {
  return timeZone ? zonedCalendar(timeZone) : hostCalendar;
}

export function screenTimeRangeLabel(range: LifeOpsScreenTimeRangeKey): string {
  switch (range) {
    case "today":
      return "Today";
    case "this-week":
      return "This Week";
    case "7d":
      return "Last 7d";
    case "30d":
      return "Last 30d";
  }
}

export function computeScreenTimeRange(
  range: LifeOpsScreenTimeRangeKey,
  now = new Date(),
  timeZone?: string,
): ScreenTimeWindow {
  const calendar = calendarFor(timeZone);
  const until = now.toISOString();
  const startToday = calendar.startOfDay(now);
  if (range === "today") {
    return { since: startToday.toISOString(), until };
  }
  if (range === "this-week") {
    const dayOfWeek = calendar.weekday(startToday);
    return {
      since: calendar.addDays(startToday, -dayOfWeek).toISOString(),
      until,
    };
  }
  if (range === "7d") {
    return { since: calendar.addDays(startToday, -6).toISOString(), until };
  }
  return { since: calendar.addDays(startToday, -29).toISOString(), until };
}

export function computePriorScreenTimeRange(
  range: LifeOpsScreenTimeRangeKey,
  current: ScreenTimeWindow,
): ScreenTimeWindow | null {
  if (range === "today") {
    return null;
  }
  const sinceMs = Date.parse(current.since);
  const untilMs = Date.parse(current.until);
  const spanMs = untilMs - sinceMs;
  return {
    since: new Date(sinceMs - spanMs).toISOString(),
    until: current.since,
  };
}

export function enumerateScreenTimeHistoryDays(
  period: ScreenTimeWindow,
  timeZone?: string,
): ScreenTimeHistoryDay[] {
  const calendar = calendarFor(timeZone);
  const days: ScreenTimeHistoryDay[] = [];
  const endMs = Date.parse(period.until);
  let cursor = calendar.startOfDay(new Date(Date.parse(period.since)));
  while (cursor.getTime() <= endMs) {
    const dayStart = cursor;
    const dayEnd = calendar.addDays(dayStart, 1);
    days.push({
      date: calendar.dateKey(dayStart),
      since: dayStart.toISOString(),
      until: new Date(Math.min(dayEnd.getTime(), endMs)).toISOString(),
      label: calendar.label(dayStart),
    });
    cursor = dayEnd;
  }
  return days;
}
