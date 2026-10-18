/**
 * Civil dates of an all-day event. Google and ICS rows store all-day dates
 * at UTC midnight, so the date is the timestamp prefix. Apple Calendar rows
 * store real instants (local midnight to 23:59:59 on the last day), so the
 * dates are read in the event's zone, as feed reads already do.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";

function civilDate(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function nextCivilDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Start date and exclusive end date (YYYY-MM-DD). An Apple row without a
 * stored zone is read in `fallbackTimeZone` (the viewer's zone).
 */
export function allDayEventDates(
  event: Pick<LifeOpsCalendarEvent, "startAt"> &
    Partial<Pick<LifeOpsCalendarEvent, "provider" | "endAt" | "timezone">>,
  fallbackTimeZone?: string,
): { startDate: string; endDateExclusive: string } {
  const endAt = event.endAt ?? event.startAt;
  const zone =
    event.provider === "apple_calendar"
      ? event.timezone?.trim() || fallbackTimeZone
      : undefined;
  const startMs = Date.parse(event.startAt);
  const endMs = Date.parse(endAt);
  if (!zone || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return {
      startDate: event.startAt.slice(0, 10),
      endDateExclusive: endAt.slice(0, 10),
    };
  }
  return {
    startDate: civilDate(startMs, zone),
    endDateExclusive: nextCivilDate(
      civilDate(Math.max(startMs, endMs - 1), zone),
    ),
  };
}
