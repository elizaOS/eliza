/** Resolves next-month family packet periods and calendar query instants using the household timezone. */
import type { FamilyPacketPeriod } from "../family-coordination/index.js";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "../time.js";

export function nextFamilyPacketPeriod(
  now: Date,
  timeZone = "America/New_York",
): FamilyPacketPeriod {
  const local = getZonedDateParts(now, timeZone);
  const start = new Date(Date.UTC(local.year, local.month, 1));
  const end = new Date(Date.UTC(local.year, local.month + 1, 1));
  const startsOn = start.toISOString().split("T")[0];
  return {
    key: startsOn.substring(0, 7),
    startsOn,
    endsOnExclusive: end.toISOString().split("T")[0],
    timeZone,
  };
}

export function familyPacketCalendarWindow(period: FamilyPacketPeriod): {
  timeMin: string;
  timeMax: string;
  timeZone: string;
} {
  const midnight = (date: string): string => {
    const [year, month, day] = date.split("-").map(Number);
    return buildUtcDateFromLocalParts(period.timeZone, {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
    }).toISOString();
  };
  return {
    timeMin: midnight(period.startsOn),
    timeMax: midnight(period.endsOnExclusive),
    timeZone: period.timeZone,
  };
}
