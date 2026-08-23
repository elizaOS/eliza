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
    return ms;
  }
  const dateTime = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (dateTime) {
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
  const byDayMatches = rule.byDay === undefined || rule.byDay.includes(weekday);
  const untilMatches = rule.untilMs === undefined || startMs <= rule.untilMs;
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
    maxOccurrences: MAX_GENERATED_OCCURRENCES,
  });
  const targetOccurrenceIndex = occurrences.findIndex(
    (occurrence) => occurrence.getTime() === targetStartMs,
  );
  if (targetOccurrenceIndex < 0) {
    invalidRecurrenceSplit(
      occurrences.length >= MAX_GENERATED_OCCURRENCES
        ? `The selected occurrence is beyond the ${MAX_GENERATED_OCCURRENCES}-occurrence verified split horizon.`
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
    base += ` until ${formatUntilLabel(rule.untilMs)}`;
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
