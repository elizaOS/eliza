/** Maps canonical feed events to visible civil days without shifting all-day dates through the viewer's timezone. */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";

function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: "year" | "month" | "day") => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Calendar date is missing ${type}.`);
    return part.value;
  };
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function calendarEventOccursOn(
  event: LifeOpsCalendarEvent,
  day: string,
  timeZone: string,
): boolean {
  if (event.isAllDay) {
    const start = event.startAt.split("T")[0];
    const end = event.endAt.split("T")[0];
    return day >= start && day < end;
  }
  const startInstant = new Date(event.startAt);
  // An unparseable timestamp must not throw out of a render-time day filter:
  // without a start the event has no day, and without an end it keeps its
  // start day, as the day grid and next-event line already treat it.
  if (!Number.isFinite(startInstant.getTime())) return false;
  const start = localDay(startInstant, timeZone);
  const endMs = Date.parse(event.endAt);
  if (!Number.isFinite(endMs)) return day === start;
  // The interval is end-exclusive. Subtracting one millisecond also handles
  // fractional-second midnight boundaries and DST without civil-date math.
  const lastInstant = new Date(Math.max(startInstant.getTime(), endMs - 1));
  return day >= start && day <= localDay(lastInstant, timeZone);
}
