/**
 * Timezone-aware date primitives for the calendar domain: zoned date-part
 * extraction, offset lookup, and local-date arithmetic built on cached
 * `Intl.DateTimeFormat` instances. Local-to-instant conversion follows
 * Temporal-compatible disambiguation so repeated and skipped wall times remain
 * deterministic across DST and date-line transitions.
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
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OFFSET_SAMPLE_HOURS = [-48, -36, -24, -12, 0, 12, 24, 36, 48];

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
  const d = new Date(0);
  d.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  d.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return d.getTime();
}

function sameZonedParts(left: ZonedDateParts, right: ZonedDateParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

export function buildUtcDateFromLocalParts(
  timeZone: string,
  parts: ZonedDateParts,
): Date {
  const baseUtcMs = localPartsToEpochMs(parts);
  if (!Number.isFinite(baseUtcMs)) {
    throw new RangeError(
      `Local date-time cannot be resolved in timezone ${timeZone}`,
    );
  }
  const offsets = new Set(
    OFFSET_SAMPLE_HOURS.map((hours) =>
      getTimeZoneOffsetMinutes(new Date(baseUtcMs + hours * HOUR_MS), timeZone),
    ),
  );
  const candidates = [...offsets]
    .map((offsetMinutes) => new Date(baseUtcMs - offsetMinutes * MINUTE_MS))
    .filter((candidate) => Number.isFinite(candidate.getTime()));
  const exact = candidates
    .filter((candidate) => {
      try {
        return sameZonedParts(getZonedDateParts(candidate, timeZone), parts);
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.getTime() - right.getTime());
  if (exact[0]) {
    // "Compatible" selects the earlier instant when a fall-back repeats time.
    return exact[0];
  }

  const shiftedForward = candidates
    .map((candidate) => {
      let wallDeltaMs: number;
      try {
        wallDeltaMs =
          localPartsToEpochMs(getZonedDateParts(candidate, timeZone)) -
          baseUtcMs;
      } catch {
        wallDeltaMs = Number.NaN;
      }
      return { candidate, wallDeltaMs };
    })
    .filter(
      ({ wallDeltaMs, candidate }) =>
        Number.isFinite(wallDeltaMs) &&
        wallDeltaMs > 0 &&
        Number.isFinite(candidate.getTime()),
    )
    .sort(
      (left, right) =>
        left.wallDeltaMs - right.wallDeltaMs ||
        left.candidate.getTime() - right.candidate.getTime(),
    );
  if (shiftedForward[0]) {
    // A nonexistent time advances by the timezone gap. This also handles a
    // jurisdiction that skips an entire local date at the international date
    // line; a fixed-point offset loop oscillates across either kind of gap.
    return shiftedForward[0].candidate;
  }

  throw new RangeError(
    `Local date-time cannot be resolved in timezone ${timeZone}`,
  );
}

export function addDaysToLocalDate(
  dateOnly: Pick<ZonedDateParts, "year" | "month" | "day">,
  dayDelta: number,
): Pick<ZonedDateParts, "year" | "month" | "day"> {
  const utcDate = new Date(0);
  utcDate.setUTCFullYear(
    dateOnly.year,
    dateOnly.month - 1,
    dateOnly.day + dayDelta,
  );
  utcDate.setUTCHours(12, 0, 0, 0);
  return {
    year: utcDate.getUTCFullYear(),
    month: utcDate.getUTCMonth() + 1,
    day: utcDate.getUTCDate(),
  };
}

export function getWeekdayForLocalDate(
  dateOnly: Pick<ZonedDateParts, "year" | "month" | "day">,
): number {
  const d = new Date(0);
  d.setUTCFullYear(dateOnly.year, dateOnly.month - 1, dateOnly.day);
  d.setUTCHours(12, 0, 0, 0);
  return d.getUTCDay();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
