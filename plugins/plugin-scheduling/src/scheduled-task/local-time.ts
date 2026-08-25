/**
 * Resolves a local HH:MM on an owner's calendar date to one deterministic UTC
 * instant. Ambiguous fall-back times choose the earlier occurrence; skipped
 * spring-forward times move forward by the size of the timezone gap, matching
 * Temporal's compatible disambiguation and common calendar behavior.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OFFSET_SAMPLE_HOURS = [-48, -36, -24, -12, 0, 12, 24, 36, 48];

export type InvalidLocalTimeReason =
  | "malformed_hhmm"
  | "invalid_time_zone"
  | "unresolvable_local_time";

/**
 * A supplied local time is invalid or cannot be resolved in its timezone.
 * Absence is represented separately by `null`; callers must not turn malformed
 * owner facts into an absent value and silently apply a default.
 */
export class InvalidLocalTimeError extends Error {
  readonly code = "invalid_local_time";

  constructor(
    readonly reason: InvalidLocalTimeReason,
    readonly localTime: string | undefined,
    readonly timeZone?: string,
  ) {
    const detail =
      reason === "malformed_hhmm"
        ? `invalid local time ${JSON.stringify(localTime)}; expected HH:MM`
        : reason === "invalid_time_zone"
          ? `invalid timezone ${JSON.stringify(timeZone)}`
          : `local time ${JSON.stringify(localTime)} cannot be resolved in ${JSON.stringify(timeZone)}`;
    super(detail);
    this.name = "InvalidLocalTimeError";
  }
}

interface LocalMinuteParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = partsFormatterCache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = offsetFormatterCache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  offsetFormatterCache.set(timeZone, formatter);
  return formatter;
}

function localParts(date: Date, timeZone: string): LocalMinuteParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`missing timezone date part: ${type}`);
    return Number(value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function offsetMinutes(date: Date, timeZone: string): number {
  const token =
    offsetFormatter(timeZone)
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value.trim() ?? "GMT";
  if (token === "GMT" || token === "UTC") return 0;
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(token);
  if (!match) {
    throw new Error(`unsupported timezone offset token: ${token}`);
  }
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

function sameLocalMinute(
  candidate: Date,
  target: LocalMinuteParts,
  timeZone: string,
): boolean {
  const actual = localParts(candidate, timeZone);
  return (
    actual.year === target.year &&
    actual.month === target.month &&
    actual.day === target.day &&
    actual.hour === target.hour &&
    actual.minute === target.minute
  );
}

function addLocalDays(
  date: Pick<LocalMinuteParts, "year" | "month" | "day">,
  dayOffset: number,
): Pick<LocalMinuteParts, "year" | "month" | "day"> {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + dayOffset, 12),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function parseLocalHHMM(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new InvalidLocalTimeError("malformed_hhmm", value);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function resolveLocalHHMMToIso(
  now: Date,
  hhmm: string | undefined,
  timeZone: string,
  dayOffset = 0,
): string | null {
  const minuteOfDay = parseLocalHHMM(hhmm);
  if (minuteOfDay === null) return null;
  try {
    const current = localParts(now, timeZone);
    const date = addLocalDays(current, dayOffset);
    const target: LocalMinuteParts = {
      ...date,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
    };
    const wallClockAsUtc = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      target.hour,
      target.minute,
    );
    const offsets = new Set(
      OFFSET_SAMPLE_HOURS.map((hours) =>
        offsetMinutes(new Date(wallClockAsUtc + hours * HOUR_MS), timeZone),
      ),
    );
    const exactCandidates = [...offsets]
      .map((offset) => new Date(wallClockAsUtc - offset * MINUTE_MS))
      .filter((candidate) => sameLocalMinute(candidate, target, timeZone))
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.getTime()) ? left.getTime() : 0;
        const rightTime = Number.isFinite(right.getTime())
          ? right.getTime()
          : 0;
        return leftTime - rightTime;
      });
    if (exactCandidates.length > 0) {
      return exactCandidates[0].toISOString();
    }

    const offsetBefore = offsetMinutes(
      new Date(wallClockAsUtc - 48 * HOUR_MS),
      timeZone,
    );
    const offsetAfter = offsetMinutes(
      new Date(wallClockAsUtc + 48 * HOUR_MS),
      timeZone,
    );
    if (offsetAfter > offsetBefore) {
      return new Date(wallClockAsUtc - offsetBefore * MINUTE_MS).toISOString();
    }
  } catch (error) {
    // error-policy:J2 convert Intl's implementation-specific RangeError into
    // a stable error type that callers can handle without parsing text.
    if (error instanceof InvalidLocalTimeError) throw error;
    throw new InvalidLocalTimeError("invalid_time_zone", hhmm, timeZone);
  }
  throw new InvalidLocalTimeError("unresolvable_local_time", hhmm, timeZone);
}
