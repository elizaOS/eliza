/** Maps canonical feed events to visible civil days without shifting all-day dates through the viewer's timezone. */
import type { LifeOpsCalendarEvent } from "@elizaos/shared";

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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(event.startAt));
  const value = (type: "year" | "month" | "day") => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Calendar date is missing ${type}.`);
    return part.value;
  };
  return day === `${value("year")}-${value("month")}-${value("day")}`;
}
