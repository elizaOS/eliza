/**
 * Screen-time range helpers: label formatting, current and prior window
 * computation, and history-day enumeration for a given range key.
 */
import type { LifeOpsScreenTimeRangeKey } from "../contracts/lifeops.js";

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
): ScreenTimeWindow {
  const until = now.toISOString();
  if (range === "today") {
    return { since: startOfLocalDay(now).toISOString(), until };
  }
  if (range === "this-week") {
    const startToday = startOfLocalDay(now);
    const dayOfWeek = startToday.getDay();
    return { since: addDays(startToday, -dayOfWeek).toISOString(), until };
  }
  if (range === "7d") {
    return { since: addDays(startOfLocalDay(now), -6).toISOString(), until };
  }
  return { since: addDays(startOfLocalDay(now), -29).toISOString(), until };
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
): ScreenTimeHistoryDay[] {
  const days: ScreenTimeHistoryDay[] = [];
  const endMs = Date.parse(period.until);
  let cursor = startOfLocalDay(new Date(Date.parse(period.since)));
  while (cursor.getTime() <= endMs) {
    const dayStart = cursor;
    const dayEnd = addDays(dayStart, 1);
    days.push({
      date: localDateKey(dayStart),
      since: dayStart.toISOString(),
      until: new Date(Math.min(dayEnd.getTime(), endMs)).toISOString(),
      label: new Intl.DateTimeFormat(undefined, {
        month: "numeric",
        day: "numeric",
      }).format(dayStart),
    });
    cursor = dayEnd;
  }
  return days;
}
