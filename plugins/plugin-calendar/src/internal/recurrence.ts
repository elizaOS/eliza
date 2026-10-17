/**
 * RFC 5545 recurrence (RRULE) support for the calendar domain.
 *
 * Google Calendar consumes raw RFC 5545 `recurrence` lines and expands them
 * server-side (`events.list` with `singleEvents: true` returns flattened
 * instances), so this module does NOT re-implement a full recurrence engine.
 * It owns the three things the provider cannot do for us:
 *
 *   1. **Validation** — normalize/validate recurrence input (from structured
 *      action params or LLM extraction) before it reaches a provider, so an
 *      invalid rule fails closed instead of silently creating a one-off event.
 *   2. **Local expansion / next-occurrence** — DST-correct occurrence math for
 *      the supported subset (DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL,
 *      BYDAY, BYMONTHDAY, COUNT, UNTIL). Occurrences keep the event's local
 *      wall-clock time in its IANA timezone across DST transitions — one fire
 *      per local day, never a double-fire. A wall-clock time inside a
 *      spring-forward gap shifts past it or is skipped, as the caller chooses.
 *   3. **Human-readable descriptions** — "weekly on Monday", "every 2 weeks on
 *      Mon and Wed, 10 times" for grounded action replies.
 *
 * Weekday and month arithmetic build on the timezone-safe primitives in
 * `./time.js` (the same care as the scheduled-task cron DST fix).
 */

import { isValidTimeZone } from "./constants.js";
import { CalendarServiceError } from "./errors.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  CalendarLocalTimeError,
  getWeekdayForLocalDate,
  getZonedDateParts,
  type ZonedDateParts,
} from "./time.js";

export type CalendarRecurrenceFrequency =
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "YEARLY";

const RECURRENCE_FREQUENCIES: readonly CalendarRecurrenceFrequency[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

/** RRULE weekday token → JS weekday index (0 = Sunday … 6 = Saturday). */
const BYDAY_TOKEN_TO_WEEKDAY: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface ParsedCalendarRecurrenceRule {
  freq: CalendarRecurrenceFrequency;
  interval: number;
  /** JS weekday indexes (0 = Sunday … 6 = Saturday). WEEKLY rules only. */
  byDay?: number[];
  /**
   * WKST as a JS weekday index. It sets the day that starts a week, which
   * selects the weeks of a WEEKLY rule with INTERVAL above 1. Absent means
   * Monday (RFC 5545 default).
   */
  weekStart?: number;
  /** Days of month (1..31 or -31..-1 counting from month end). MONTHLY only. */
  byMonthDay?: number[];
  /**
   * BYDAY of a MONTHLY rule, or of a YEARLY rule that has BYMONTH, set only
   * when the caller asks for it: `2TU` is the second Tuesday of the month,
   * `-1FR` the last Friday, and `TU` (null ordinal) each Tuesday of the month.
   */
  byDayOfMonth?: Array<{ ordinal: number | null; weekday: number }>;
  /**
   * BYMONTH of a YEARLY rule (1..12, ascending), set only when the caller
   * asks for it. The series has an occurrence in each listed month: on the
   * BYDAY weekdays, on the BYMONTHDAY days, or on the day of DTSTART.
   */
  byMonthOfYear?: number[];
  /**
   * BYSETPOS of a MONTHLY rule, or of a YEARLY rule that has BYMONTH, set
   * only when the caller asks for it. Each value selects one date from the
   * dates of one month (MONTHLY) or one year (YEARLY): `1` is the first
   * date and `-1` the last.
   */
  bySetPos?: number[];
  /** Total occurrence count including the first occurrence (DTSTART). */
  count?: number;
  /** Inclusive UTC cutoff for occurrences. */
  untilMs?: number;
  /**
   * Set when UNTIL is a DATE (`UNTIL=20261215`). A DATE names a calendar day,
   * so the series ends with that day in the series time zone. `untilMs` is
   * then the end of that day in UTC, for a caller that needs an instant.
   */
  untilDate?: { year: number; month: number; day: number };
  /**
   * Set with `untilDate` when UNTIL is a local date and time
   * (`UNTIL=20261215T180000`, the form RFC 5545 requires for a local
   * DTSTART). The series ends at this clock time of that day in the series
   * time zone.
   */
  untilTime?: { hour: number; minute: number; second: number };
  /**
   * True when the rule uses RFC 5545 parts that are valid for the provider but
   * outside this module's local expansion subset (ordinal BYDAY like `2MO`,
   * BYSETPOS, BYMONTH, …). Such rules pass validation and flow to the provider
   * untouched; local expansion/description falls back gracefully.
   */
  beyondExpansionSubset: boolean;
}

function invalidRecurrence(detail: string): never {
  throw new CalendarServiceError(
    400,
    `Invalid recurrence rule: ${detail}`,
    "CALENDAR_INVALID_RECURRENCE",
  );
}

function parseUntilValue(
  value: string,
  allowLocalTime: boolean,
): {
  ms: number;
  date?: { year: number; month: number; day: number };
  time?: { hour: number; minute: number; second: number };
} {
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const mo = Number(dateOnly[2]);
    const d0 = Number(dateOnly[3]);
    const d = new Date(0);
    d.setUTCFullYear(y, mo - 1, d0);
    d.setUTCHours(23, 59, 59, 0);
    const ms = d.getTime();
    const date = d;
    if (
      !Number.isFinite(ms) ||
      date.getUTCFullYear() !== Number(dateOnly[1]) ||
      date.getUTCMonth() !== Number(dateOnly[2]) - 1 ||
      date.getUTCDate() !== Number(dateOnly[3])
    ) {
      invalidRecurrence(`UNTIL=${value}`);
    }
    return { ms, date: { year: y, month: mo, day: d0 } };
  }
  const dateTime = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/,
  );
  if (dateTime && (dateTime[7] || allowLocalTime)) {
    const second = Number(dateTime[6]);
    // ECMAScript cannot represent leap seconds. RFC 5545 directs
    // implementations without that support to interpret second 60 as 59.
    const representedSecond = second === 60 ? 59 : second;
    const dtY = Number(dateTime[1]);
    const dtMo = Number(dateTime[2]);
    const dtD = Number(dateTime[3]);
    const dtH = Number(dateTime[4]);
    const dtMi = Number(dateTime[5]);
    const d2 = new Date(0);
    d2.setUTCFullYear(dtY, dtMo - 1, dtD);
    d2.setUTCHours(dtH, dtMi, representedSecond, 0);
    const ms = d2.getTime();
    const date = d2;
    if (
      !Number.isFinite(ms) ||
      date.getUTCFullYear() !== Number(dateTime[1]) ||
      date.getUTCMonth() !== Number(dateTime[2]) - 1 ||
      date.getUTCDate() !== Number(dateTime[3]) ||
      date.getUTCHours() !== Number(dateTime[4]) ||
      date.getUTCMinutes() !== Number(dateTime[5]) ||
      date.getUTCSeconds() !== representedSecond
    ) {
      invalidRecurrence(`UNTIL=${value}`);
    }
    if (dateTime[7]) return { ms };
    return {
      ms,
      date: { year: dtY, month: dtMo, day: dtD },
      time: { hour: dtH, minute: dtMi, second: representedSecond },
    };
  }
  invalidRecurrence(
    `UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ, got "${value}"`,
  );
}

function parsePositiveInt(value: string, part: string): number {
  if (!/^\d+$/.test(value)) invalidRecurrence(`${part}=${value}`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    invalidRecurrence(`${part} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Parse and validate one RRULE line (with or without the `RRULE:` prefix).
 * Throws `CalendarServiceError(400)` on anything malformed. Rules using parts
 * outside the local expansion subset (ordinal BYDAY, BYSETPOS, BYMONTH,
 * BYHOUR, BYMINUTE) still validate — they are provider-supported RFC 5545 —
 * and come back flagged `beyondExpansionSubset`.
 */
export function parseRecurrenceRule(
  value: string,
  options: {
    localUntil?: boolean;
    monthlyByDay?: boolean;
    yearlyByMonth?: boolean;
    bySetPos?: boolean;
    dailyByDay?: boolean;
  } = {},
): ParsedCalendarRecurrenceRule {
  const body = value.trim().replace(/^RRULE:/i, "");
  if (body.length === 0) invalidRecurrence("empty rule");

  let freq: CalendarRecurrenceFrequency | undefined;
  let interval = 1;
  let byDay: number[] | undefined;
  let byDayTokens: ParsedCalendarRecurrenceRule["byDayOfMonth"];
  let byMonthDay: number[] | undefined;
  let byMonthRaw: string | undefined;
  let bySetPosRaw: string | undefined;
  let weekStart: number | undefined;
  let count: number | undefined;
  let untilMs: number | undefined;
  let untilDate: ParsedCalendarRecurrenceRule["untilDate"];
  let untilTime: ParsedCalendarRecurrenceRule["untilTime"];
  let beyondExpansionSubset = false;

  for (const segment of body.split(";")) {
    if (segment.trim().length === 0) invalidRecurrence("empty part");
    const eq = segment.indexOf("=");
    if (eq <= 0) invalidRecurrence(`malformed part "${segment}"`);
    const key = segment.slice(0, eq).trim().toUpperCase();
    const raw = segment
      .slice(eq + 1)
      .trim()
      .toUpperCase();
    if (raw.length === 0) invalidRecurrence(`empty value for ${key}`);

    switch (key) {
      case "FREQ": {
        if (
          !RECURRENCE_FREQUENCIES.includes(raw as CalendarRecurrenceFrequency)
        ) {
          invalidRecurrence(`unsupported FREQ "${raw}"`);
        }
        freq = raw as CalendarRecurrenceFrequency;
        break;
      }
      case "INTERVAL":
        interval = parsePositiveInt(raw, "INTERVAL");
        break;
      case "COUNT":
        count = parsePositiveInt(raw, "COUNT");
        break;
      case "UNTIL": {
        const until = parseUntilValue(raw, options.localUntil === true);
        untilMs = until.ms;
        untilDate = until.date;
        untilTime = until.time;
        break;
      }
      case "BYDAY": {
        const days: number[] = [];
        const tokens: NonNullable<typeof byDayTokens> = [];
        for (const token of raw.split(",")) {
          const match = token
            .trim()
            .match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
          if (!match) invalidRecurrence(`BYDAY token "${token}"`);
          const weekdayToken = match[2];
          if (!weekdayToken) invalidRecurrence(`BYDAY token "${token}"`);
          const weekday = BYDAY_TOKEN_TO_WEEKDAY[weekdayToken];
          if (weekday === undefined)
            invalidRecurrence(`BYDAY token "${token}"`);
          // An ordinal weekday (2MO = second Monday) is provider-valid.
          tokens.push({ ordinal: match[1] ? Number(match[1]) : null, weekday });
          if (!days.includes(weekday)) days.push(weekday);
        }
        if (days.length === 0) invalidRecurrence("BYDAY has no days");
        byDay = days;
        byDayTokens = tokens;
        break;
      }
      case "BYMONTHDAY": {
        const days: number[] = [];
        for (const token of raw.split(",")) {
          if (!/^-?\d{1,2}$/.test(token.trim())) {
            invalidRecurrence(`BYMONTHDAY token "${token}"`);
          }
          const day = Number(token.trim());
          if (day === 0 || day < -31 || day > 31) {
            invalidRecurrence(`BYMONTHDAY out of range "${token}"`);
          }
          if (!days.includes(day)) days.push(day);
        }
        byMonthDay = days;
        break;
      }
      case "WKST":
        // WKST has an effect only on a WEEKLY rule (and on BYWEEKNO, which
        // stays outside the subset), so a rule that has it can be expanded.
        weekStart = BYDAY_TOKEN_TO_WEEKDAY[raw];
        if (weekStart === undefined) invalidRecurrence(`WKST=${raw}`);
        break;
      case "BYMONTH":
        byMonthRaw = raw;
        break;
      case "BYSETPOS":
        bySetPosRaw = raw;
        break;
      case "BYHOUR":
      case "BYMINUTE":
      case "BYSECOND":
      case "BYWEEKNO":
      case "BYYEARDAY":
        beyondExpansionSubset = true;
        break;
      default:
        invalidRecurrence(`unknown part "${key}"`);
    }
  }

  if (!freq) invalidRecurrence("missing FREQ");
  if (count !== undefined && untilMs !== undefined) {
    invalidRecurrence("COUNT and UNTIL are mutually exclusive");
  }
  // BYMONTH of a YEARLY rule lists the months of the year that have an
  // occurrence. Other uses of BYMONTH stay outside the subset.
  const months = /^\d{1,2}(?:,\d{1,2})*$/.test(byMonthRaw ?? "")
    ? [...new Set((byMonthRaw ?? "").split(",").map(Number))]
    : [];
  const byMonthOfYear =
    options.yearlyByMonth === true &&
    freq === "YEARLY" &&
    months.length > 0 &&
    months.every((month) => month >= 1 && month <= 12)
      ? months.sort((a, b) => a - b)
      : undefined;
  // BYDAY of a MONTHLY rule, or of a YEARLY rule that has BYMONTH, names
  // weekdays of the month. A month has at most five of one weekday. Other
  // ordinal weekdays stay outside the subset.
  const byDayOfMonth =
    ((options.monthlyByDay === true && freq === "MONTHLY") || byMonthOfYear) &&
    byMonthDay === undefined &&
    byDayTokens?.every(
      ({ ordinal }) =>
        ordinal === null || (ordinal !== 0 && Math.abs(ordinal) <= 5),
    )
      ? byDayTokens
      : undefined;
  if (!byDayOfMonth) {
    if (byDayTokens?.some(({ ordinal }) => ordinal !== null)) {
      beyondExpansionSubset = true;
    }
    // BYDAY of a DAILY rule keeps the days that are on the listed weekdays
    // ("every weekday"), when the caller asks for it.
    const dailyByDay = options.dailyByDay === true && freq === "DAILY";
    if (byDay && freq !== "WEEKLY" && !dailyByDay) {
      beyondExpansionSubset = true;
    }
  }
  if (byMonthRaw !== undefined && !byMonthOfYear) beyondExpansionSubset = true;
  // BYSETPOS selects dates from the dates of one month or one year. The
  // dates of other periods (a week, a day) stay outside the subset.
  const setPositions = /^[+-]?\d{1,3}(?:,[+-]?\d{1,3})*$/.test(
    bySetPosRaw ?? "",
  )
    ? [...new Set((bySetPosRaw ?? "").split(",").map(Number))]
    : [];
  const bySetPos =
    options.bySetPos === true &&
    (freq === "MONTHLY" || byMonthOfYear) &&
    setPositions.length > 0 &&
    setPositions.every(
      (position) => position !== 0 && Math.abs(position) <= 366,
    )
      ? setPositions
      : undefined;
  if (bySetPosRaw !== undefined && !bySetPos) beyondExpansionSubset = true;
  if (byMonthDay && freq !== "MONTHLY" && !byMonthOfYear) {
    beyondExpansionSubset = true;
  }

  return {
    freq,
    interval,
    byDay,
    byMonthDay,
    byDayOfMonth,
    byMonthOfYear,
    bySetPos,
    weekStart,
    count,
    untilMs,
    untilDate,
    untilTime,
    beyondExpansionSubset,
  };
}

function canonicalizeRuleLine(value: string): string {
  const body = value
    .trim()
    .replace(/^RRULE:/i, "")
    .replace(/\s+/g, "");
  return `RRULE:${body.toUpperCase()}`;
}

const NON_RRULE_RECURRENCE_LINE = /^(EXDATE|RDATE|EXRULE)([;:])/i;

/**
 * Normalize recurrence input into canonical RFC 5545 lines for the provider.
 *
 * Accepts a single rule string or an array of recurrence lines. RRULE lines are
 * strictly parsed/validated; EXDATE/RDATE/EXRULE lines (readback from a
 * provider round-trip) pass through with a shape check only. Anything else
 * throws `CalendarServiceError(400)` — never silently dropped.
 */
export function normalizeRecurrence(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const rawLines = Array.isArray(value) ? value : [value];
  const lines: string[] = [];
  for (const raw of rawLines) {
    if (typeof raw !== "string") {
      invalidRecurrence("recurrence entries must be strings");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (NON_RRULE_RECURRENCE_LINE.test(trimmed)) {
      lines.push(trimmed);
      continue;
    }
    parseRecurrenceRule(trimmed);
    lines.push(canonicalizeRuleLine(trimmed));
  }
  return lines.length > 0 ? lines : undefined;
}

/** First RRULE line from a recurrence line set, parsed; null when none. */
export function firstRecurrenceRule(
  recurrence: readonly string[] | null | undefined,
  options: {
    localUntil?: boolean;
    monthlyByDay?: boolean;
    yearlyByMonth?: boolean;
    bySetPos?: boolean;
    dailyByDay?: boolean;
  } = {},
): ParsedCalendarRecurrenceRule | null {
  if (!recurrence) return null;
  for (const line of recurrence) {
    if (NON_RRULE_RECURRENCE_LINE.test(line.trim())) continue;
    try {
      return parseRecurrenceRule(line, options);
    } catch {
      // error-policy:J3 unparseable RRULE line -> "no usable rule" (null).
      return null;
    }
  }
  return null;
}

type LocalDateOnly = Pick<ZonedDateParts, "year" | "month" | "day">;

function daysBetweenLocalDates(from: LocalDateOnly, to: LocalDateOnly): number {
  const dFrom = new Date(0);
  dFrom.setUTCFullYear(from.year, from.month - 1, from.day);
  dFrom.setUTCHours(12, 0, 0, 0);
  const fromMs = dFrom.getTime();
  const dTo = new Date(0);
  dTo.setUTCFullYear(to.year, to.month - 1, to.day);
  dTo.setUTCHours(12, 0, 0, 0);
  const toMs = dTo.getTime();
  return Math.round((toMs - fromMs) / 86_400_000);
}

function addMonthsToLocalMonth(
  yearMonth: { year: number; month: number },
  monthDelta: number,
): { year: number; month: number } {
  const zeroBased = yearMonth.year * 12 + (yearMonth.month - 1) + monthDelta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  d.setUTCHours(12, 0, 0, 0);
  return d.getUTCDate();
}

/** Days of one month that a MONTHLY BYDAY list names, in ascending order. */
function daysOfMonthForWeekdays(
  year: number,
  month: number,
  byDayOfMonth: NonNullable<ParsedCalendarRecurrenceRule["byDayOfMonth"]>,
): number[] {
  const monthLength = daysInMonth(year, month);
  const firstWeekday = getWeekdayForLocalDate({ year, month, day: 1 });
  const days = new Set<number>();
  for (const { ordinal, weekday } of byDayOfMonth) {
    const matches: number[] = [];
    const first = 1 + ((weekday - firstWeekday + 7) % 7);
    for (let day = first; day <= monthLength; day += 7) matches.push(day);
    // A month without a fifth such weekday has no occurrence for 5 or -5.
    const picked =
      ordinal === null
        ? matches
        : [matches.at(ordinal > 0 ? ordinal - 1 : ordinal)];
    for (const day of picked) {
      if (day !== undefined) days.add(day);
    }
  }
  return [...days].sort((a, b) => a - b);
}

export const MAX_EXPANDED_RECURRENCE_OCCURRENCES = 1000;
const MAX_ICS_RECURRENCE_INSTANT = new Date("9999-12-31T23:59:59.999Z");

function invalidExpansionDate(detail: string, cause?: unknown): never {
  throw new CalendarServiceError(
    400,
    `Recurrence expansion produced an invalid date: ${detail}`,
    "CALENDAR_RECURRENCE_EXPANSION_INVALID_DATE",
    cause === undefined ? undefined : { cause },
  );
}

function assertValidLocalDate(date: LocalDateOnly): void {
  if (
    !Number.isSafeInteger(date.year) ||
    !Number.isSafeInteger(date.month) ||
    !Number.isSafeInteger(date.day) ||
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1 ||
    date.day > 31
  ) {
    invalidExpansionDate(
      "the candidate local date is outside the supported range",
    );
  }
  const probe = new Date(0);
  probe.setUTCFullYear(date.year, date.month - 1, date.day);
  probe.setUTCHours(12, 0, 0, 0);
  if (
    !Number.isFinite(probe.getTime()) ||
    probe.getUTCFullYear() !== date.year ||
    probe.getUTCMonth() !== date.month - 1 ||
    probe.getUTCDate() !== date.day
  ) {
    invalidExpansionDate("the candidate local date cannot be represented");
  }
}

function compareLocalDates(left: LocalDateOnly, right: LocalDateOnly): number {
  return (
    left.year - right.year || left.month - right.month || left.day - right.day
  );
}

/**
 * How a generated occurrence whose DTSTART wall-clock time does not exist on
 * its date (a spring-forward gap) is handled.
 *
 * - `"shift-forward"`: the occurrence keeps its date and moves past the gap
 *   (02:30 becomes 03:30), and it counts toward COUNT. This is RFC 5545
 *   §3.3.5 DATE-TIME resolution, as libical and provider calendars expand
 *   series, so provider-backed series (split plans) use it to keep
 *   occurrence indexes aligned with the provider's instances.
 * - `"skip"`: RFC 5545 §3.3.10 — the occurrence is ignored and does not count
 *   toward COUNT, so the series gains one occurrence at its end instead.
 */
export type NonexistentLocalTimePolicy = "shift-forward" | "skip";

/**
 * Generate occurrence instants for a rule, DST-correct: every occurrence keeps
 * the DTSTART wall-clock time in `timeZone`. DTSTART itself is always the
 * first occurrence (RFC 5545) and counts toward COUNT.
 */
function* generateOccurrences(args: {
  rule: ParsedCalendarRecurrenceRule;
  startAt: Date;
  timeZone: string;
  rangeStart?: Date;
  rangeEnd: Date;
  nonexistentLocalTime?: NonexistentLocalTimePolicy;
}): Generator<Date> {
  const { rule, startAt, timeZone, rangeStart, rangeEnd } = args;
  const skipNonexistent = args.nonexistentLocalTime === "skip";
  if (rule.beyondExpansionSubset) {
    throw new CalendarServiceError(
      400,
      "Recurrence rule uses parts outside the local expansion subset",
      "CALENDAR_RECURRENCE_EXPANSION_UNSUPPORTED",
    );
  }
  const startMs = startAt.getTime();
  const rangeEndMs = rangeEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(rangeEndMs)) {
    invalidExpansionDate("DTSTART or the expansion boundary is invalid");
  }
  let anchor: ZonedDateParts;
  let rangeEndParts: ZonedDateParts;
  let rangeStartParts: ZonedDateParts | undefined;
  try {
    anchor = getZonedDateParts(startAt, timeZone);
    rangeEndParts = getZonedDateParts(rangeEnd, timeZone);
    if (rangeStart) rangeStartParts = getZonedDateParts(rangeStart, timeZone);
  } catch (error) {
    invalidExpansionDate("the timezone boundary cannot be resolved", error);
  }
  const anchorDate: LocalDateOnly = {
    year: anchor.year,
    month: anchor.month,
    day: anchor.day,
  };
  const timeOfDay = {
    hour: anchor.hour,
    minute: anchor.minute,
    second: anchor.second,
  };
  const rangeEndDate: LocalDateOnly = {
    year: rangeEndParts.year,
    month: rangeEndParts.month,
    day: rangeEndParts.day,
  };
  // An occurrence on a local date before this one ends more than a day before
  // `rangeStart`, so the caller discards it. Such dates still count toward
  // COUNT, but their instant is never resolved: an old daily series costs
  // date arithmetic only, not one time zone lookup per past day. When
  // nonexistent local times are skipped, a COUNT rule must resolve every
  // date, because a skipped gap date does not count toward COUNT.
  const skipBeforeDate = rangeStartParts
    ? addDaysToLocalDate(
        {
          year: rangeStartParts.year,
          month: rangeStartParts.month,
          day: rangeStartParts.day,
        },
        -1,
      )
    : undefined;

  let emitted = 0;
  const emitBudget = rule.count ?? Number.POSITIVE_INFINITY;

  // Null when the DTSTART wall-clock time does not exist on `date` and the
  // policy skips such occurrences.
  function toInstant(date: LocalDateOnly): Date | null {
    assertValidLocalDate(date);
    const parts = { ...date, ...timeOfDay };
    try {
      let instant: Date;
      if (skipNonexistent) {
        try {
          instant = buildUtcDateFromLocalParts(timeZone, parts, "reject");
        } catch (error) {
          if (!(error instanceof CalendarLocalTimeError)) throw error;
          if (error.code === "CALENDAR_LOCAL_TIME_NONEXISTENT") return null;
          // A repeated fall-back time is a real occurrence; it resolves to
          // the earlier instant exactly as the shift-forward policy does.
          instant = buildUtcDateFromLocalParts(timeZone, parts);
        }
      } else {
        instant = buildUtcDateFromLocalParts(timeZone, parts);
      }
      if (!Number.isFinite(instant.getTime())) {
        invalidExpansionDate("the candidate instant cannot be represented");
      }
      return instant;
    } catch (error) {
      if (error instanceof CalendarServiceError) throw error;
      invalidExpansionDate("the candidate instant cannot be resolved", error);
    }
  }

  function beyondRangeEnd(date: LocalDateOnly): boolean {
    assertValidLocalDate(date);
    return compareLocalDates(date, rangeEndDate) > 0;
  }

  // Days of one month in ascending order: the weekdays that BYDAY names, or
  // the BYMONTHDAY days. A day that the month does not have is skipped per
  // RFC 5545 (Feb 29 in non-leap years). A positive day and a negative day
  // can name the same date (31 and -1 in a 31-day month); it is emitted once.
  function daysOfMonth(
    year: number,
    month: number,
    byMonthDay: number[],
  ): number[] {
    if (rule.byDayOfMonth) {
      return daysOfMonthForWeekdays(year, month, rule.byDayOfMonth);
    }
    const monthLength = daysInMonth(year, month);
    return [
      ...new Set(
        byMonthDay
          .map((day) => (day < 0 ? monthLength + day + 1 : day))
          .filter((day) => day >= 1 && day <= monthLength),
      ),
    ].sort((a, b) => a - b);
  }

  // The dates of one month or one year that BYSETPOS selects, in ascending
  // order. Without BYSETPOS, all the dates.
  function selectSetPositions(dates: LocalDateOnly[]): LocalDateOnly[] {
    const positions = rule.bySetPos;
    if (!positions) return dates;
    const selected = new Set(
      positions.map((position) =>
        position > 0 ? position - 1 : dates.length + position,
      ),
    );
    return dates.filter((_, index) => selected.has(index));
  }

  function* localDates(): Generator<LocalDateOnly> {
    switch (rule.freq) {
      case "DAILY": {
        for (let index = 0; ; index += 1) {
          const dayDelta = index * rule.interval;
          if (!Number.isSafeInteger(dayDelta)) {
            invalidExpansionDate("the DAILY interval exceeds date arithmetic");
          }
          const date = addDaysToLocalDate(anchorDate, dayDelta);
          if (beyondRangeEnd(date)) return;
          if (
            rule.byDay &&
            !rule.byDay.includes(getWeekdayForLocalDate(date))
          ) {
            continue;
          }
          yield date;
        }
      }
      case "WEEKLY": {
        const byDay = [...(rule.byDay ?? [getWeekdayForLocalDate(anchorDate)])];
        // Weeks start on WKST (RFC 5545 default MO). With INTERVAL above 1,
        // this day decides which days are in the same week as DTSTART.
        const weekStart = rule.weekStart ?? 1;
        const offsetInWeek = (weekday: number) => (weekday - weekStart + 7) % 7;
        const anchorWeekStart = addDaysToLocalDate(
          anchorDate,
          -offsetInWeek(getWeekdayForLocalDate(anchorDate)),
        );
        const dayOffsets = byDay.map(offsetInWeek).sort((a, b) => a - b);
        for (let week = 0; ; week += rule.interval) {
          for (const offset of dayOffsets) {
            const dayDelta = week * 7 + offset;
            if (!Number.isSafeInteger(dayDelta)) {
              invalidExpansionDate(
                "the WEEKLY interval exceeds date arithmetic",
              );
            }
            const date = addDaysToLocalDate(anchorWeekStart, dayDelta);
            if (beyondRangeEnd(date)) return;
            yield date;
          }
        }
      }
      case "MONTHLY": {
        const byMonthDay = rule.byMonthDay ?? [anchorDate.day];
        for (let step = 0; ; step += rule.interval) {
          const { year, month } = addMonthsToLocalMonth(anchorDate, step);
          const monthStart = { year, month, day: 1 };
          if (beyondRangeEnd(monthStart)) return;
          yield* selectSetPositions(
            daysOfMonth(year, month, byMonthDay).map((day) => ({
              year,
              month,
              day,
            })),
          );
        }
      }
      case "YEARLY": {
        const months = rule.byMonthOfYear ?? [anchorDate.month];
        const byMonthDay =
          rule.byMonthOfYear && rule.byMonthDay
            ? rule.byMonthDay
            : [anchorDate.day];
        for (let step = 0; ; step += rule.interval) {
          const year = anchorDate.year + step;
          const yearStart = { year, month: 1, day: 1 };
          if (beyondRangeEnd(yearStart)) return;
          yield* selectSetPositions(
            months.flatMap((month) =>
              daysOfMonth(year, month, byMonthDay).map((day) => ({
                year,
                month,
                day,
              })),
            ),
          );
        }
      }
    }
  }

  // A DATE UNTIL ends with its calendar day in the series time zone. A
  // comparison of instants ends it with that day in UTC, which drops the last
  // evening occurrence west of UTC and adds a morning one east of UTC.
  const untilDate = rule.untilDate;
  const untilTime = rule.untilTime;
  const pastUntil = (instantMs: number, date: LocalDateOnly): boolean => {
    if (!untilDate) {
      return rule.untilMs !== undefined && instantMs > rule.untilMs;
    }
    const days = compareLocalDates(date, untilDate);
    if (days !== 0 || !untilTime) return days > 0;
    // A local UNTIL also has a clock time. Each occurrence has the clock
    // time of DTSTART, so that time decides the last day.
    return (
      (timeOfDay.hour - untilTime.hour ||
        timeOfDay.minute - untilTime.minute ||
        timeOfDay.second - untilTime.second) > 0
    );
  };

  // DTSTART is always the first occurrence.
  if (pastUntil(startMs, anchorDate)) return;
  if (startMs >= rangeEndMs) return;
  yield new Date(startMs);
  emitted += 1;
  if (emitted >= emitBudget) return;

  for (const date of localDates()) {
    const daysAfterAnchor = daysBetweenLocalDates(anchorDate, date);
    if (daysAfterAnchor < 0) continue;
    if (
      skipBeforeDate &&
      daysAfterAnchor > 0 &&
      compareLocalDates(date, skipBeforeDate) < 0
    ) {
      // A skipped gap date before the range does not count toward COUNT.
      const counts =
        !skipNonexistent ||
        rule.count === undefined ||
        toInstant(date) !== null;
      if (counts) {
        emitted += 1;
        if (emitted >= emitBudget) return;
      }
      continue;
    }
    const instant = toInstant(date);
    // RFC 5545 §3.3.10: a nonexistent local time is ignored, not counted.
    if (instant === null) continue;
    if (instant.getTime() >= rangeEndMs) return;
    if (instant.getTime() <= startMs) continue;
    if (pastUntil(instant.getTime(), date)) return;
    yield instant;
    emitted += 1;
    if (emitted >= emitBudget) return;
  }
}

/**
 * Expand a rule's occurrences from DTSTART up to `rangeEnd` (exclusive),
 * honoring COUNT/UNTIL termination. With `rangeStart`, earlier occurrences
 * count toward COUNT but are not returned and do not use the output cap.
 * DST-correct: occurrences keep the DTSTART wall-clock time in `timeZone`
 * across transitions. `nonexistentLocalTime` decides whether an occurrence in
 * a spring-forward gap shifts past it or is skipped without counting.
 */
export function expandRecurrenceOccurrences(args: {
  rule: ParsedCalendarRecurrenceRule;
  startAt: Date;
  timeZone: string;
  rangeStart?: Date;
  rangeEnd: Date;
  maxOccurrences?: number;
  nonexistentLocalTime: NonexistentLocalTimePolicy;
}): Date[] {
  const cap = Math.min(
    args.maxOccurrences ?? MAX_EXPANDED_RECURRENCE_OCCURRENCES,
    MAX_EXPANDED_RECURRENCE_OCCURRENCES,
  );
  const rangeStartMs = args.rangeStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  const occurrences: Date[] = [];
  for (const instant of generateOccurrences(args)) {
    if (instant.getTime() < rangeStartMs) continue;
    occurrences.push(instant);
    if (occurrences.length >= cap) break;
  }
  return occurrences;
}

/**
 * First occurrence strictly after `after`; null when the series has terminated
 * (COUNT/UNTIL) or the rule is outside the local expansion subset. A
 * spring-forward gap occurrence shifts past the gap unless
 * `nonexistentLocalTime` is `"skip"`.
 */
export function nextRecurrenceOccurrence(args: {
  rule: ParsedCalendarRecurrenceRule;
  startAt: Date;
  timeZone: string;
  after: Date;
  nonexistentLocalTime?: NonexistentLocalTimePolicy;
}): Date | null {
  if (args.rule.beyondExpansionSubset) return null;
  const ruleEnd =
    args.rule.untilMs === undefined
      ? MAX_ICS_RECURRENCE_INSTANT
      : new Date(
          Math.min(args.rule.untilMs + 1, MAX_ICS_RECURRENCE_INSTANT.getTime()),
        );
  for (const instant of generateOccurrences({
    ...args,
    rangeStart: args.after,
    rangeEnd: ruleEnd,
  })) {
    if (instant.getTime() > args.after.getTime()) return instant;
  }
  return null;
}

export interface CalendarRecurrenceSplitPlan {
  /** Null only when the target is the first occurrence. */
  readonly truncatedRecurrence: string[] | null;
  readonly followingRecurrence: string[];
  /** Zero-based position of the target in the original series. */
  readonly targetOccurrenceIndex: number;
  /** Google documents that the split resets exceptions at and after target. */
  readonly futureExceptionsReset: true;
}

function invalidRecurrenceSplit(
  detail: string,
  code = "CALENDAR_RECURRENCE_SPLIT_UNSUPPORTED",
): never {
  throw new CalendarServiceError(400, detail, code);
}

function requireSplittableRule(
  recurrence: readonly string[] | null | undefined,
  label: string,
): { line: string; rule: ParsedCalendarRecurrenceRule } {
  const normalized = normalizeRecurrence(recurrence);
  if (normalized?.length !== 1 || !normalized[0]?.startsWith("RRULE:")) {
    invalidRecurrenceSplit(
      `${label} must contain exactly one RRULE and no EXDATE, RDATE, or EXRULE lines so the split cannot silently lose recurrence state.`,
    );
  }
  const line = normalized[0];
  if (!line) {
    invalidRecurrenceSplit(`${label} does not contain a recurrence rule.`);
  }
  const keys = line
    .slice("RRULE:".length)
    .split(";")
    .map((segment) => segment.slice(0, segment.indexOf("=")));
  if (new Set(keys).size !== keys.length) {
    invalidRecurrenceSplit(
      `${label} contains duplicate RRULE parts that cannot be split losslessly.`,
    );
  }
  const rule = parseRecurrenceRule(line);
  if (rule.beyondExpansionSubset) {
    invalidRecurrenceSplit(
      `${label} uses recurrence parts outside the verified local split subset.`,
    );
  }
  return { line, rule };
}

/**
 * Fails before a provider mutation when DTSTART is outside the RRULE set.
 * RFC 5545 leaves such recurrence sets undefined, so silently reusing the
 * former rule after moving a following series would create provider-specific
 * behavior.
 */
export function assertRecurrenceStartMatchesRule(args: {
  recurrence: readonly string[] | null | undefined;
  startAt: Date;
  timeZone: string;
  label?: string;
}): void {
  const { rule } = requireSplittableRule(
    args.recurrence,
    args.label ?? "Recurrence",
  );
  const startMs = args.startAt.getTime();
  if (!Number.isFinite(startMs)) {
    invalidRecurrenceSplit(
      "The recurring series start is invalid.",
      "CALENDAR_RECURRENCE_START_MISMATCH",
    );
  }
  const local = getZonedDateParts(args.startAt, args.timeZone);
  const localDate = {
    year: local.year,
    month: local.month,
    day: local.day,
  };
  const weekday = getWeekdayForLocalDate(localDate);
  const monthLength = daysInMonth(local.year, local.month);
  const byMonthDayMatches =
    rule.byMonthDay === undefined ||
    rule.byMonthDay.some((day) =>
      day < 0 ? monthLength + day + 1 === local.day : day === local.day,
    );
  // BYDAY with an ordinal (2TU, -1FR) names a specific occurrence in the
  // month, not just a weekday: verify the day matches the ordinal pattern.
  // A YEARLY rule with BYMONTH must also start in a listed month.
  let byDayMatches: boolean;
  if (rule.byDayOfMonth) {
    const monthDays = daysOfMonthForWeekdays(
      local.year,
      local.month,
      rule.byDayOfMonth,
    );
    byDayMatches = monthDays.includes(local.day);
    if (rule.freq === "YEARLY" && rule.byMonthOfYear) {
      byDayMatches = byDayMatches && rule.byMonthOfYear.includes(local.month);
    }
  } else {
    byDayMatches = rule.byDay === undefined || rule.byDay.includes(weekday);
    if (rule.freq === "YEARLY" && rule.byMonthOfYear) {
      byDayMatches = byDayMatches && rule.byMonthOfYear.includes(local.month);
    }
  }
  const untilMatches = rule.untilDate
    ? compareLocalDates(localDate, rule.untilDate) <= 0
    : rule.untilMs === undefined || startMs <= rule.untilMs;
  if (!byMonthDayMatches || !byDayMatches || !untilMatches) {
    invalidRecurrenceSplit(
      "The following series start does not satisfy its recurrence rule. Supply a replacement RRULE aligned with the new start.",
      "CALENDAR_RECURRENCE_START_MISMATCH",
    );
  }
}

function formatRecurrenceUntil(untilMs: number): string {
  return new Date(Math.floor(untilMs / 1000) * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function replaceRuleTermination(
  line: string,
  termination: { readonly count: number } | { readonly untilMs: number } | null,
): string {
  const parts = line
    .slice("RRULE:".length)
    .split(";")
    .filter((part) => {
      const key = part.slice(0, part.indexOf("="));
      return key !== "COUNT" && key !== "UNTIL";
    });
  if (termination && "count" in termination) {
    parts.push(`COUNT=${termination.count}`);
  } else if (termination) {
    parts.push(`UNTIL=${formatRecurrenceUntil(termination.untilMs)}`);
  }
  return `RRULE:${parts.join(";")}`;
}

/**
 * Build Google's documented split transformation without touching a provider.
 * The accepted subset is deliberately narrower than provider validation:
 * rules whose later exception state or expansion cannot be reproduced are
 * rejected before the original series is trimmed.
 */
export function buildRecurrenceSplitPlan(args: {
  recurrence: readonly string[] | null | undefined;
  replacementRecurrence?: readonly string[] | null;
  seriesStartAt: Date;
  targetStartAt: Date;
  timeZone: string;
}): CalendarRecurrenceSplitPlan {
  const original = requireSplittableRule(
    args.recurrence,
    "Original recurrence",
  );
  const seriesStartMs = args.seriesStartAt.getTime();
  const targetStartMs = args.targetStartAt.getTime();
  if (
    !Number.isFinite(seriesStartMs) ||
    !Number.isFinite(targetStartMs) ||
    targetStartMs < seriesStartMs
  ) {
    invalidRecurrenceSplit(
      "The selected occurrence is outside the recurring series.",
      "CALENDAR_RECURRENCE_SPLIT_TARGET_INVALID",
    );
  }
  const occurrences = expandRecurrenceOccurrences({
    rule: original.rule,
    startAt: args.seriesStartAt,
    timeZone: args.timeZone,
    rangeEnd: new Date(targetStartMs + 1),
    maxOccurrences: MAX_EXPANDED_RECURRENCE_OCCURRENCES,
    // The provider series keeps a spring-forward gap occurrence and moves it
    // past the gap (RFC 5545 §3.3.5); the split index must count it the same
    // way or the truncated and following COUNTs drop or add an occurrence.
    nonexistentLocalTime: "shift-forward",
  });
  const targetOccurrenceIndex = occurrences.findIndex(
    (occurrence) => occurrence.getTime() === targetStartMs,
  );
  if (targetOccurrenceIndex < 0) {
    invalidRecurrenceSplit(
      occurrences.length >= MAX_EXPANDED_RECURRENCE_OCCURRENCES
        ? `The selected occurrence is beyond the ${MAX_EXPANDED_RECURRENCE_OCCURRENCES}-occurrence verified split horizon.`
        : "The selected time is not an occurrence generated by the series rule.",
      "CALENDAR_RECURRENCE_SPLIT_TARGET_INVALID",
    );
  }

  const truncatedRecurrence =
    targetOccurrenceIndex === 0
      ? null
      : [
          original.rule.count !== undefined
            ? replaceRuleTermination(original.line, {
                count: targetOccurrenceIndex,
              })
            : replaceRuleTermination(original.line, {
                untilMs: targetStartMs - 1000,
              }),
        ];
  let followingRecurrence: string[];
  if (args.replacementRecurrence !== undefined) {
    followingRecurrence = [
      requireSplittableRule(
        args.replacementRecurrence,
        "Replacement recurrence",
      ).line,
    ];
  } else if (original.rule.count !== undefined) {
    followingRecurrence = [
      replaceRuleTermination(original.line, {
        count: original.rule.count - targetOccurrenceIndex,
      }),
    ];
  } else {
    followingRecurrence = [original.line];
  }

  return {
    truncatedRecurrence,
    followingRecurrence,
    targetOccurrenceIndex,
    futureExceptionsReset: true,
  };
}

const DATE_ONLY_UNTIL = /(?:^|[;:])\s*UNTIL\s*=\s*\d{8}\s*(?:;|$)/i;

function formatUntilLabel(untilMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(untilMs));
}

/**
 * Human-readable summary of a recurrence line set for action replies, e.g.
 * "weekly on Monday", "every 2 weeks on Monday and Wednesday, 10 times".
 * Falls back to the raw first rule body for provider-valid rules outside the
 * describable subset. `timeZone` is the event's IANA zone: a date-time UNTIL
 * is a UTC instant (Google stores "ends Jun 16" in Los Angeles as
 * `20110617T065959Z`), so its date is read in that zone.
 */
export function describeRecurrence(
  recurrence: readonly string[] | null | undefined,
  timeZone?: string | null,
): string | null {
  if (!recurrence || recurrence.length === 0) return null;
  const firstLine = recurrence.find(
    (line) => !NON_RRULE_RECURRENCE_LINE.test(line.trim()),
  );
  if (!firstLine) return null;
  let rule: ParsedCalendarRecurrenceRule;
  try {
    rule = parseRecurrenceRule(firstLine);
  } catch {
    // error-policy:J3 unparseable RRULE line -> "no usable rule" (null).
    return null;
  }
  if (rule.beyondExpansionSubset) {
    return firstLine
      .trim()
      .replace(/^RRULE:/i, "")
      .toLowerCase();
  }

  const every = (unit: string) =>
    rule.interval === 1
      ? unit
      : `every ${rule.interval} ${unit.replace(/ly$/, "")}s`;
  let base: string;
  switch (rule.freq) {
    case "DAILY":
      base = rule.interval === 1 ? "daily" : `every ${rule.interval} days`;
      break;
    case "WEEKLY": {
      base = every("weekly");
      if (rule.byDay && rule.byDay.length > 0) {
        const labels = [...rule.byDay]
          .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          .map((weekday) => WEEKDAY_LABELS[weekday]);
        base += ` on ${labels.join(labels.length === 2 ? " and " : ", ")}`;
      }
      break;
    }
    case "MONTHLY": {
      base = every("monthly");
      if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        base += ` on day ${rule.byMonthDay.join(", ")}`;
      }
      break;
    }
    case "YEARLY":
      base = every("yearly");
      break;
  }
  if (rule.count !== undefined) {
    base += `, ${rule.count} times`;
  } else if (rule.untilMs !== undefined) {
    // A date-only UNTIL already names a calendar date (parsed as 23:59:59Z).
    const untilZone =
      !DATE_ONLY_UNTIL.test(firstLine) && timeZone && isValidTimeZone(timeZone)
        ? timeZone
        : "UTC";
    base += ` until ${formatUntilLabel(rule.untilMs, untilZone)}`;
  }
  return base;
}

export type LifeOpsCalendarRecurrenceScopeValue =
  | "instance"
  | "this_and_following"
  | "series";

/**
 * Normalize a recurrence mutation scope. Fail-closed: a present-but-invalid
 * scope is a 400, never a silent instance-only mutation.
 */
export function normalizeRecurrenceScope(
  value: unknown,
): LifeOpsCalendarRecurrenceScopeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) return undefined;
    if (normalized === "instance" || normalized === "occurrence") {
      return "instance";
    }
    if (
      normalized === "this_and_following" ||
      normalized === "this-and-following" ||
      normalized === "this and following" ||
      normalized === "this_and_future" ||
      normalized === "following" ||
      normalized === "future"
    ) {
      return "this_and_following";
    }
    if (normalized === "series" || normalized === "all") return "series";
  }
  throw new CalendarServiceError(
    400,
    `recurrenceScope must be "instance", "this_and_following", or "series", got ${JSON.stringify(value)}`,
    "CALENDAR_INVALID_RECURRENCE_SCOPE",
  );
}

/** Series master event id recorded on a flattened recurring instance. */
export function recurringEventIdFrom(
  event: {
    recurringEventId?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null,
): string | null {
  if (!event) return null;
  if (
    typeof event.recurringEventId === "string" &&
    event.recurringEventId.length > 0
  ) {
    return event.recurringEventId;
  }
  const fromMetadata = event.metadata?.recurringEventId;
  return typeof fromMetadata === "string" && fromMetadata.length > 0
    ? fromMetadata
    : null;
}

/** Recurrence lines recorded on an event (first-class field or metadata). */
export function recurrenceLinesFrom(
  event: {
    recurrence?: string[] | null;
    metadata?: Record<string, unknown> | null;
  } | null,
): string[] | null {
  if (!event) return null;
  if (Array.isArray(event.recurrence) && event.recurrence.length > 0) {
    return event.recurrence;
  }
  const fromMetadata = event.metadata?.recurrence;
  if (Array.isArray(fromMetadata)) {
    const lines = fromMetadata.filter(
      (line): line is string => typeof line === "string" && line.length > 0,
    );
    return lines.length > 0 ? lines : null;
  }
  return null;
}

/** Original rule-derived occurrence start, including moved-instance identity. */
export function recurrenceOriginalStartAtFrom(
  event: {
    startAt?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null,
): string | null {
  if (!event) return null;
  const original = event.metadata?.originalStartTime;
  if (typeof original === "string" && Number.isFinite(Date.parse(original))) {
    return new Date(original).toISOString();
  }
  return typeof event.startAt === "string" &&
    Number.isFinite(Date.parse(event.startAt))
    ? new Date(event.startAt).toISOString()
    : null;
}
