/** Maps canonical feed events to visible civil days without shifting all-day dates through the viewer's timezone. */
import { type LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";

interface ZonedCivilInstant {
  day: string;
  hour: number;
  minute: number;
  second: number;
}

function zonedCivilInstant(iso: string, timeZone: string): ZonedCivilInstant {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("Calendar event instant is invalid.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Calendar date is missing ${type}.`);
    return part.value;
  };
  let hour = Number(value("hour"));
  if (hour === 24) hour = 0;
  return {
    day: `${value("year")}-${value("month")}-${value("day")}`,
    hour,
    minute: Number(value("minute")),
    second: Number(value("second")),
  };
}

function isLocalMidnight(instant: ZonedCivilInstant): boolean {
  return instant.hour === 0 && instant.minute === 0 && instant.second === 0;
}

function previousCivilDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
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
  const start = zonedCivilInstant(event.startAt, timeZone);
  const end = zonedCivilInstant(event.endAt, timeZone);
  let lastDay = end.day;
  if (isLocalMidnight(end) && end.day > start.day) {
    lastDay = previousCivilDay(end.day);
  }
  if (lastDay < start.day) {
    return day === start.day;
  }
  return day >= start.day && day <= lastDay;
}
