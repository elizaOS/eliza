/**
 * Timezone-aware date primitives for the calendar domain: zoned date-part
 * extraction, offset lookup, and local-date arithmetic built on cached
 * `Intl.DateTimeFormat` instances, so event windows compute correctly across
 * DST transitions.
 */
export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cacheKey = `parts:${timeZone}`;
  const cached = zonedFormatterCache.get(cacheKey);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  zonedFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cacheKey = `offset:${timeZone}`;
  const cached = offsetFormatterCache.get(cacheKey);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  offsetFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function getZonedDateParts(
  date: Date,
  timeZone: string,
): ZonedDateParts {
  const parts = getZonedFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) {
      throw new Error(`missing zoned date part: ${type}`);
    }
    return Number(part);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = getOffsetFormatter(timeZone).formatToParts(date);
  const token =
    parts.find((part) => part.type === "timeZoneName")?.value?.trim() ?? "GMT";
  if (token === "GMT" || token === "UTC") return 0;
  const match = token.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    throw new Error(`unsupported offset token: ${token}`);
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

function localPartsToEpochMs(parts: ZonedDateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

export function buildUtcDateFromLocalParts(
  timeZone: string,
  parts: ZonedDateParts,
): Date {
  const baseUtcMs = localPartsToEpochMs(parts);
  let candidate = new Date(baseUtcMs);
  for (let index = 0; index < 6; index += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(candidate, timeZone);
    const adjusted = new Date(baseUtcMs - offsetMinutes * 60_000);
    const actualParts = getZonedDateParts(adjusted, timeZone);
    const deltaMinutes = Math.round(
      (localPartsToEpochMs(parts) - localPartsToEpochMs(actualParts)) / 60_000,
    );
    if (deltaMinutes === 0) {
      return adjusted;
    }
    candidate = new Date(adjusted.getTime() + deltaMinutes * 60_000);
  }
  return candidate;
}

export function addDaysToLocalDate(
  dateOnly: Pick<ZonedDateParts, "year" | "month" | "day">,
  dayDelta: number,
): Pick<ZonedDateParts, "year" | "month" | "day"> {
  const utcDate = new Date(
    Date.UTC(
      dateOnly.year,
      dateOnly.month - 1,
      dateOnly.day + dayDelta,
      12,
      0,
      0,
    ),
  );
  return {
    year: utcDate.getUTCFullYear(),
    month: utcDate.getUTCMonth() + 1,
    day: utcDate.getUTCDate(),
  };
}

export function getWeekdayForLocalDate(
  dateOnly: Pick<ZonedDateParts, "year" | "month" | "day">,
): number {
  return new Date(
    Date.UTC(dateOnly.year, dateOnly.month - 1, dateOnly.day, 12, 0, 0),
  ).getUTCDay();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
