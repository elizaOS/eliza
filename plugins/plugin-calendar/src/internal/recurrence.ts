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
 *      per local day, never a double-fire or a skip.
 *   3. **Human-readable descriptions** — "weekly on Monday", "every 2 weeks on
 *      Mon and Wed, 10 times" for grounded action replies.
 *
 * Weekday and month arithmetic build on the timezone-safe primitives in
 * `./time.js` (the same care as the scheduled-task cron DST fix).
 */

import { CalendarServiceError } from "./errors.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
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
  /** Days of month (1..31 or -31..-1 counting from month end). MONTHLY only. */
  byMonthDay?: number[];
  /** Total occurrence count including the first occurrence (DTSTART). */
  count?: number;
  /** Inclusive UTC cutoff for occurrences. */
  untilMs?: number;
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

function parseUntilValue(value: string): number {
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    // Date-only UNTIL: inclusive through the end of that UTC day.
    const ms = Date.UTC(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      23,
      59,
      59,
    );
    if (!Number.isFinite(ms)) invalidRecurrence(`UNTIL=${value}`);
    return ms;
  }
  const dateTime = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (dateTime) {
    const ms = Date.UTC(
      Number(dateTime[1]),
      Number(dateTime[2]) - 1,
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5]),
      Number(dateTime[6]),
    );
    if (!Number.isFinite(ms)) invalidRecurrence(`UNTIL=${value}`);
    return ms;
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
 * outside the local expansion subset (ordinal BYDAY, BYSETPOS, BYMONTH, WKST,
 * BYHOUR, BYMINUTE) still validate — they are provider-supported RFC 5545 —
 * and come back flagged `beyondExpansionSubset`.
 */
export function parseRecurrenceRule(
  value: string,
): ParsedCalendarRecurrenceRule {
  const body = value.trim().replace(/^RRULE:/i, "");
  if (body.length === 0) invalidRecurrence("empty rule");

  let freq: CalendarRecurrenceFrequency | undefined;
  let interval = 1;
  let byDay: number[] | undefined;
  let byMonthDay: number[] | undefined;
  let count: number | undefined;
  let untilMs: number | undefined;
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
      case "UNTIL":
        untilMs = parseUntilValue(raw);
        break;
      case "BYDAY": {
        const days: number[] = [];
        for (const token of raw.split(",")) {
          const match = token
            .trim()
            .match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
          if (!match) invalidRecurrence(`BYDAY token "${token}"`);
          if (match[1]) {
            // Ordinal weekday (e.g. 2MO = second Monday): provider-valid,
            // outside the local expansion subset.
            beyondExpansionSubset = true;
          }
          const weekdayToken = match[2];
          if (!weekdayToken) invalidRecurrence(`BYDAY token "${token}"`);
          const weekday = BYDAY_TOKEN_TO_WEEKDAY[weekdayToken];
          if (weekday === undefined)
            invalidRecurrence(`BYDAY token "${token}"`);
          if (!days.includes(weekday)) days.push(weekday);
        }
        if (days.length === 0) invalidRecurrence("BYDAY has no days");
        byDay = days;
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
      case "BYMONTH":
      case "BYSETPOS":
      case "WKST":
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
  if (byDay && freq !== "WEEKLY") beyondExpansionSubset = true;
  if (byMonthDay && freq !== "MONTHLY") beyondExpansionSubset = true;

  return {
    freq,
    interval,
    byDay,
    byMonthDay,
    count,
    untilMs,
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
): ParsedCalendarRecurrenceRule | null {
  if (!recurrence) return null;
  for (const line of recurrence) {
    if (NON_RRULE_RECURRENCE_LINE.test(line.trim())) continue;
    try {
      return parseRecurrenceRule(line);
    } catch {
      return null;
    }
  }
  return null;
}

type LocalDateOnly = Pick<ZonedDateParts, "year" | "month" | "day">;

function daysBetweenLocalDates(from: LocalDateOnly, to: LocalDateOnly): number {
  const fromMs = Date.UTC(from.year, from.month - 1, from.day, 12);
  const toMs = Date.UTC(to.year, to.month - 1, to.day, 12);
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
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
}

const MAX_GENERATED_OCCURRENCES = 1000;

/**
 * Generate occurrence instants for a rule, DST-correct: every occurrence keeps
 * the DTSTART wall-clock time in `timeZone`. DTSTART itself is always the
 * first occurrence (RFC 5545) and counts toward COUNT.
 */
function* generateOccurrences(args: {
  rule: ParsedCalendarRecurrenceRule;
  startAt: Date;
  timeZone: string;
}): Generator<Date> {
  const { rule, startAt, timeZone } = args;
  if (rule.beyondExpansionSubset) {
    throw new CalendarServiceError(
      400,
      "Recurrence rule uses parts outside the local expansion subset",
      "CALENDAR_RECURRENCE_EXPANSION_UNSUPPORTED",
    );
  }
  const anchor = getZonedDateParts(startAt, timeZone);
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
  const startMs = startAt.getTime();

  let emitted = 0;
  const emitBudget = Math.min(
    rule.count ?? MAX_GENERATED_OCCURRENCES,
    MAX_GENERATED_OCCURRENCES,
  );

  function toInstant(date: LocalDateOnly): Date {
    return buildUtcDateFromLocalParts(timeZone, { ...date, ...timeOfDay });
  }

  function* localDates(): Generator<LocalDateOnly> {
    switch (rule.freq) {
      case "DAILY": {
        for (let index = 0; ; index += 1) {
          yield addDaysToLocalDate(anchorDate, index * rule.interval);
        }
      }
      case "WEEKLY": {
        const byDay = [...(rule.byDay ?? [getWeekdayForLocalDate(anchorDate)])];
        // Monday-based week start (RFC 5545 default WKST=MO).
        const mondayOffset = (getWeekdayForLocalDate(anchorDate) + 6) % 7;
        const anchorWeekStart = addDaysToLocalDate(anchorDate, -mondayOffset);
        const dayOffsets = byDay
          .map((weekday) => (weekday + 6) % 7)
          .sort((a, b) => a - b);
        for (let week = 0; ; week += rule.interval) {
          for (const offset of dayOffsets) {
            yield addDaysToLocalDate(anchorWeekStart, week * 7 + offset);
          }
        }
      }
      case "MONTHLY": {
        const byMonthDay = rule.byMonthDay ?? [anchorDate.day];
        for (let step = 0; ; step += rule.interval) {
          const { year, month } = addMonthsToLocalMonth(anchorDate, step);
          const monthLength = daysInMonth(year, month);
          const days = byMonthDay
            .map((day) => (day < 0 ? monthLength + day + 1 : day))
            .filter((day) => day >= 1 && day <= monthLength)
            .sort((a, b) => a - b);
          for (const day of days) {
            yield { year, month, day };
          }
        }
      }
      case "YEARLY": {
        for (let step = 0; ; step += rule.interval) {
          const year = anchorDate.year + step;
          // Skip invalid anniversaries (Feb 29 in non-leap years) per RFC 5545.
          if (anchorDate.day > daysInMonth(year, anchorDate.month)) continue;
          yield { year, month: anchorDate.month, day: anchorDate.day };
        }
      }
    }
  }

  // DTSTART is always the first occurrence.
  if (rule.untilMs !== undefined && startMs > rule.untilMs) return;
  yield new Date(startMs);
  emitted += 1;
  if (emitted >= emitBudget) return;

  for (const date of localDates()) {
    if (daysBetweenLocalDates(anchorDate, date) < 0) continue;
    const instant = toInstant(date);
    if (instant.getTime() <= startMs) continue;
    if (rule.untilMs !== undefined && instant.getTime() > rule.untilMs) return;
    yield instant;
    emitted += 1;
    if (emitted >= emitBudget) return;
  }
}

/**
 * Expand a rule's occurrences from DTSTART up to `rangeEnd` (exclusive),
 * honoring COUNT/UNTIL termination. DST-correct: occurrences keep the DTSTART
 * wall-clock time in `timeZone` across transitions.
 */
export function expandRecurrenceOccurrences(args: {
  rule: ParsedCalendarRecurrenceRule;
  startAt: Date;
  timeZone: string;
  rangeEnd: Date;
  maxOccurrences?: number;
}): Date[] {
  const cap = Math.min(
    args.maxOccurrences ?? MAX_GENERATED_OCCURRENCES,
    MAX_GENERATED_OCCURRENCES,
  );
  const occurrences: Date[] = [];
  for (const instant of generateOccurrences(args)) {
    if (instant.getTime() >= args.rangeEnd.getTime()) break;
    occurrences.push(instant);
    if (occurrences.length >= cap) break;
  }
  return occurrences;
}

/**
 * First occurrence strictly after `after`; null when the series has terminated
 * (COUNT/UNTIL) or the rule is outside the local expansion subset.
 */
export function nextRecurrenceOccurrence(args: {
  rule: ParsedCalendarRecurrenceRule;
  startAt: Date;
  timeZone: string;
  after: Date;
}): Date | null {
  if (args.rule.beyondExpansionSubset) return null;
  for (const instant of generateOccurrences(args)) {
    if (instant.getTime() > args.after.getTime()) return instant;
  }
  return null;
}

function formatUntilLabel(untilMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(untilMs));
}

/**
 * Human-readable summary of a recurrence line set for action replies, e.g.
 * "weekly on Monday", "every 2 weeks on Monday and Wednesday, 10 times".
 * Falls back to the raw first rule body for provider-valid rules outside the
 * describable subset.
 */
export function describeRecurrence(
  recurrence: readonly string[] | null | undefined,
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
    base += ` until ${formatUntilLabel(rule.untilMs)}`;
  }
  return base;
}

export type LifeOpsCalendarRecurrenceScopeValue = "instance" | "series";

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
    if (normalized === "series" || normalized === "all") return "series";
  }
  throw new CalendarServiceError(
    400,
    `recurrenceScope must be "instance" or "series", got ${JSON.stringify(value)}`,
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
