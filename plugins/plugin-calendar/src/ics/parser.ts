/**
 * Strict RFC 5545 ingestion for subscription feeds.
 *
 * Structural corruption fails the whole source; malformed VEVENTs become
 * explicit per-event issues so one bad school entry cannot erase a prior good
 * snapshot or make the source look authoritatively empty.
 */

import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { normalizeCalendarDateTimeInTimeZone } from "../internal/calendar-normalize.js";
import { addDaysToLocalDate, getZonedDateParts } from "../internal/time.js";
import type {
  IcsAttendee,
  IcsParsedCalendar,
  IcsParsedEvent,
  IcsParseIssue,
} from "./types.js";
import { resolveIcsTimeZoneId } from "./windows-timezones.js";

const MAX_UNFOLDED_LINES = 50_000;
const MAX_UNFOLDED_LINE_LENGTH = 32_768;
const CONTENT_LINE_NAME = /^[A-Z0-9-]+$/;
const DATE_VALUE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_VALUE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/;
const DURATION_VALUE =
  /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

interface IcsContentLine {
  name: string;
  params: Map<string, string[]>;
  value: string;
  serializedName: string;
}

interface IcsComponent {
  properties: Map<string, IcsContentLine[]>;
}

interface ParsedDateValue {
  instant: string;
  isDate: boolean;
  timezone: string;
  localDate: { year: number; month: number; day: number };
}

function invalidFeed(
  code: string,
  message: string,
  context?: Record<string, unknown>,
): never {
  throw new ElizaError(message, {
    code,
    context,
    severity: "fatal",
  });
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === separator && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted) {
    invalidFeed(
      "ICS_UNTERMINATED_PARAMETER_QUOTE",
      "Calendar feed contains an unterminated quoted parameter.",
    );
  }
  parts.push(current);
  return parts;
}

function indexOfValueDelimiter(line: string): number {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ":" && !quoted) {
      return index;
    }
  }
  return -1;
}

function unquoteParameter(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replaceAll("\\,", ",").replaceAll('\\"', '"');
}

function parseContentLine(line: string): IcsContentLine {
  const delimiter = indexOfValueDelimiter(line);
  if (delimiter <= 0) {
    invalidFeed(
      "ICS_INVALID_CONTENT_LINE",
      "Calendar feed contains a content line without a property delimiter.",
    );
  }
  const left = line.slice(0, delimiter);
  const value = line.slice(delimiter + 1);
  const segments = splitOutsideQuotes(left, ";");
  const name = segments[0].trim().toUpperCase();
  if (!CONTENT_LINE_NAME.test(name)) {
    invalidFeed(
      "ICS_INVALID_PROPERTY_NAME",
      "Invalid calendar property name.",
      {
        property: name,
      },
    );
  }
  const params = new Map<string, string[]>();
  for (const rawParameter of segments.slice(1)) {
    const equals = rawParameter.indexOf("=");
    if (equals <= 0) {
      invalidFeed(
        "ICS_INVALID_PARAMETER",
        `Calendar property ${name} contains an invalid parameter.`,
      );
    }
    const parameterName = rawParameter.slice(0, equals).trim().toUpperCase();
    if (!CONTENT_LINE_NAME.test(parameterName)) {
      invalidFeed(
        "ICS_INVALID_PARAMETER_NAME",
        `Calendar property ${name} contains an invalid parameter name.`,
      );
    }
    const parameterValues = splitOutsideQuotes(
      rawParameter.slice(equals + 1),
      ",",
    )
      .map(unquoteParameter)
      .filter((entry) => entry.length > 0);
    if (parameterValues.length === 0) {
      invalidFeed(
        "ICS_EMPTY_PARAMETER",
        `Calendar property ${name} contains an empty parameter.`,
      );
    }
    params.set(parameterName, parameterValues);
  }
  return {
    name,
    params,
    value,
    serializedName: left,
  };
}

function unfoldLines(content: string): string[] {
  if (content.includes("\0")) {
    invalidFeed("ICS_NUL_BYTE", "Calendar feed contains a forbidden NUL byte.");
  }
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const physicalLines = normalized.split("\n");
  const unfolded: string[] = [];
  for (const physicalLine of physicalLines) {
    if (physicalLine.startsWith(" ") || physicalLine.startsWith("\t")) {
      const previousIndex = unfolded.length - 1;
      if (previousIndex < 0) {
        invalidFeed(
          "ICS_ORPHAN_CONTINUATION",
          "Calendar feed begins with a folded continuation line.",
        );
      }
      unfolded[previousIndex] += physicalLine.slice(1);
      if (unfolded[previousIndex].length > MAX_UNFOLDED_LINE_LENGTH) {
        invalidFeed(
          "ICS_LINE_TOO_LONG",
          "Calendar feed contains an unfolded line above the safety limit.",
          { limit: MAX_UNFOLDED_LINE_LENGTH },
        );
      }
      continue;
    }
    if (physicalLine.length === 0) continue;
    if (physicalLine.length > MAX_UNFOLDED_LINE_LENGTH) {
      invalidFeed(
        "ICS_LINE_TOO_LONG",
        "Calendar feed contains a line above the safety limit.",
        { limit: MAX_UNFOLDED_LINE_LENGTH },
      );
    }
    unfolded.push(physicalLine);
    if (unfolded.length > MAX_UNFOLDED_LINES) {
      invalidFeed(
        "ICS_TOO_MANY_LINES",
        "Calendar feed exceeds the structural line limit.",
        { limit: MAX_UNFOLDED_LINES },
      );
    }
  }
  return unfolded;
}

function collectComponents(lines: readonly string[]): {
  calendar: IcsComponent;
  events: IcsComponent[];
} {
  const stack: string[] = [];
  const calendar: IcsComponent = { properties: new Map() };
  const events: IcsComponent[] = [];
  let currentEvent: IcsComponent | null = null;
  let sawCalendar = false;

  for (const rawLine of lines) {
    const line = parseContentLine(rawLine);
    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      if (!CONTENT_LINE_NAME.test(component)) {
        invalidFeed(
          "ICS_INVALID_COMPONENT",
          "Calendar feed contains an invalid component name.",
        );
      }
      if (component === "VCALENDAR") {
        if (stack.length > 0 || sawCalendar) {
          invalidFeed(
            "ICS_MULTIPLE_CALENDARS",
            "Calendar feed must contain exactly one top-level VCALENDAR.",
          );
        }
        sawCalendar = true;
      } else if (stack.length === 0) {
        invalidFeed(
          "ICS_COMPONENT_OUTSIDE_CALENDAR",
          `${component} appears outside VCALENDAR.`,
        );
      }
      stack.push(component);
      if (component === "VEVENT") {
        if (stack.length !== 2 || stack[0] !== "VCALENDAR") {
          invalidFeed(
            "ICS_NESTED_EVENT",
            "VEVENT must be a direct child of VCALENDAR.",
          );
        }
        currentEvent = { properties: new Map() };
      }
      continue;
    }
    if (line.name === "END") {
      const component = line.value.trim().toUpperCase();
      const expected = stack.pop();
      if (!expected || expected !== component) {
        invalidFeed(
          "ICS_COMPONENT_MISMATCH",
          "Calendar feed contains mismatched BEGIN and END components.",
          { expected: expected ?? null, actual: component },
        );
      }
      if (component === "VEVENT") {
        if (!currentEvent) {
          invalidFeed(
            "ICS_EVENT_STATE",
            "Calendar feed ended a VEVENT that was not open.",
          );
        }
        events.push(currentEvent);
        currentEvent = null;
      }
      continue;
    }
    if (stack[0] !== "VCALENDAR") {
      invalidFeed(
        "ICS_PROPERTY_OUTSIDE_CALENDAR",
        "Calendar property appears outside VCALENDAR.",
      );
    }
    const target =
      currentEvent && stack.at(-1) === "VEVENT" ? currentEvent : calendar;
    if (currentEvent && stack.at(-1) !== "VEVENT") {
      continue;
    }
    const existing = target.properties.get(line.name) ?? [];
    existing.push(line);
    target.properties.set(line.name, existing);
  }

  if (stack.length > 0) {
    invalidFeed(
      "ICS_UNCLOSED_COMPONENT",
      "Calendar feed ends before all components are closed.",
      { openComponents: stack },
    );
  }
  if (!sawCalendar) {
    invalidFeed(
      "ICS_MISSING_CALENDAR",
      "Calendar feed does not contain VCALENDAR.",
    );
  }
  return { calendar, events };
}

function firstProperty(
  component: IcsComponent,
  name: string,
): IcsContentLine | null {
  return component.properties.get(name)?.[0] ?? null;
}

function propertyValue(component: IcsComponent, name: string): string | null {
  return firstProperty(component, name)?.value.trim() || null;
}

function decodeIcsText(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      decoded += "\\";
      continue;
    }
    index += 1;
    if (escaped === "n" || escaped === "N") decoded += "\n";
    else if (escaped === "," || escaped === ";" || escaped === "\\")
      decoded += escaped;
    else decoded += escaped;
  }
  return decoded;
}

function validateDateParts(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}): void {
  const d = new Date(0);
  d.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  d.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, 0);
  const candidate = d;
  if (
    candidate.getUTCFullYear() !== parts.year ||
    candidate.getUTCMonth() + 1 !== parts.month ||
    candidate.getUTCDate() !== parts.day ||
    candidate.getUTCHours() !== (parts.hour ?? 0) ||
    candidate.getUTCMinutes() !== (parts.minute ?? 0) ||
    candidate.getUTCSeconds() !== (parts.second ?? 0)
  ) {
    throw new Error("Calendar property contains an impossible date or time.");
  }
}

// Outlook/Exchange feeds carry Windows display names in TZID, so raw zone ids
// go through the CLDR windowsZones table before the Intl-backed date math. An
// unresolvable zone throws here and quarantines only that event via the
// per-event issue handler in parseIcsCalendar.
function resolveEventTimeZone(raw: string, field: string): string {
  const resolved = resolveIcsTimeZoneId(raw);
  if (!resolved) {
    throw new Error(
      `${field} time zone "${raw.trim()}" is not a recognized IANA or Windows time zone.`,
    );
  }
  return resolved;
}

function parseDateProperty(
  property: IcsContentLine,
  calendarTimezone: string | null,
  field: string,
): ParsedDateValue {
  const valueKind = property.params.get("VALUE")?.[0]?.toUpperCase();
  const dateMatch = property.value.match(DATE_VALUE);
  if (valueKind === "DATE" || dateMatch) {
    if (!dateMatch) {
      throw new Error(`${field} VALUE=DATE must use YYYYMMDD.`);
    }
    const localDate = {
      year: Number(dateMatch[1]),
      month: Number(dateMatch[2]),
      day: Number(dateMatch[3]),
    };
    validateDateParts(localDate);
    const timezone = resolveEventTimeZone(
      property.params.get("TZID")?.[0] ?? calendarTimezone ?? "UTC",
      field,
    );
    // An all-day date is a civil date, not an instant: it is stored at UTC
    // midnight like Google all-day events, because calendar views place
    // all-day events by the date part of startAt/endAt. Local midnight east
    // of UTC would land on the previous date.
    const instant = normalizeCalendarDateTimeInTimeZone(
      `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00`,
      field,
      "UTC",
    );
    if (!instant) throw new Error(`${field} is required.`);
    return { instant, isDate: true, timezone, localDate };
  }

  const dateTimeMatch = property.value.match(DATE_TIME_VALUE);
  if (!dateTimeMatch) {
    throw new Error(
      `${field} must use RFC 5545 DATE or DATE-TIME basic format.`,
    );
  }
  const parts = {
    year: Number(dateTimeMatch[1]),
    month: Number(dateTimeMatch[2]),
    day: Number(dateTimeMatch[3]),
    hour: Number(dateTimeMatch[4]),
    minute: Number(dateTimeMatch[5]),
    second: Number(dateTimeMatch[6] ?? "0"),
  };
  validateDateParts(parts);
  const isUtc = dateTimeMatch[7] === "Z";
  const rawTimezone = isUtc
    ? "UTC"
    : (property.params.get("TZID")?.[0] ?? calendarTimezone);
  if (!rawTimezone) {
    throw new Error(
      `${field} is a floating DATE-TIME without TZID or X-WR-TIMEZONE.`,
    );
  }
  const timezone = resolveEventTimeZone(rawTimezone, field);
  const dUtc = new Date(0);
  dUtc.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  dUtc.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  const instant = isUtc
    ? dUtc.toISOString()
    : normalizeCalendarDateTimeInTimeZone(
        `${dateTimeMatch[1]}-${dateTimeMatch[2]}-${dateTimeMatch[3]}T${dateTimeMatch[4]}:${dateTimeMatch[5]}:${dateTimeMatch[6] ?? "00"}`,
        field,
        timezone,
      );
  if (!instant) throw new Error(`${field} is required.`);
  if (!isUtc) {
    const resolved = getZonedDateParts(new Date(instant), timezone);
    if (
      resolved.year !== parts.year ||
      resolved.month !== parts.month ||
      resolved.day !== parts.day ||
      resolved.hour !== parts.hour ||
      resolved.minute !== parts.minute ||
      resolved.second !== parts.second
    ) {
      throw new Error(
        `${field} resolves to a nonexistent local time in ${timezone}.`,
      );
    }
  }
  return {
    instant,
    isDate: false,
    timezone,
    localDate: {
      year: parts.year,
      month: parts.month,
      day: parts.day,
    },
  };
}

interface ParsedDuration {
  /** Nominal days (weeks folded in): calendar days in the event's zone. */
  days: number;
  /** Exact hours/minutes/seconds in milliseconds. */
  exactMs: number;
}

function parseDuration(value: string): ParsedDuration {
  const match = value.match(DURATION_VALUE);
  if (!match) throw new Error("DURATION is not a supported RFC 5545 duration.");
  const sign = match[1] === "-" ? -1 : 1;
  const weeks = Number(match[2] ?? "0");
  const days = Number(match[3] ?? "0");
  const hours = Number(match[4] ?? "0");
  const minutes = Number(match[5] ?? "0");
  const seconds = Number(match[6] ?? "0");
  const parsed = {
    days: weeks * 7 + days,
    exactMs: (hours * 60 * 60 + minutes * 60 + seconds) * 1000,
  };
  if ((parsed.days === 0 && parsed.exactMs === 0) || sign < 0) {
    throw new Error("DURATION must be a positive, non-zero duration.");
  }
  return parsed;
}

// RFC 5545 3.3.6: day and week durations are nominal, so "P1D" ends at the
// same local wall-clock time on the next day even across a DST change;
// hour/minute/second durations are exact.
function endFromDuration(
  start: ParsedDateValue,
  value: string,
): ParsedDateValue {
  const duration = parseDuration(value);
  let instant = start.instant;
  let localDate = start.localDate;
  if (duration.days > 0) {
    // All-day dates are stored at UTC midnight; timed starts keep their
    // wall-clock time in the event zone.
    const zone = start.isDate ? "UTC" : start.timezone;
    const clock = getZonedDateParts(new Date(start.instant), zone);
    localDate = addDaysToLocalDate(start.localDate, duration.days);
    const pad = (value: number, width = 2) =>
      String(value).padStart(width, "0");
    const resolved = normalizeCalendarDateTimeInTimeZone(
      `${pad(localDate.year, 4)}-${pad(localDate.month)}-${pad(localDate.day)}T${pad(clock.hour % 24)}:${pad(clock.minute)}:${pad(clock.second)}`,
      "DTEND",
      zone,
    );
    if (!resolved) throw new Error("DTEND could not be resolved.");
    instant = resolved;
  }
  return {
    instant: new Date(Date.parse(instant) + duration.exactMs).toISOString(),
    isDate: start.isDate,
    timezone: start.timezone,
    localDate,
  };
}

function addOneLocalDay(
  start: ParsedDateValue,
  field: string,
): ParsedDateValue {
  const next = addDaysToLocalDate(start.localDate, 1);
  const instant = normalizeCalendarDateTimeInTimeZone(
    `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}-${String(next.day).padStart(2, "0")}T00:00:00`,
    field,
    "UTC",
  );
  if (!instant) throw new Error(`${field} could not be resolved.`);
  return {
    instant,
    isDate: true,
    timezone: start.timezone,
    localDate: next,
  };
}

function emailFromCalendarAddress(value: string): string | null {
  const decoded = decodeIcsText(value).trim();
  const withoutScheme = decoded.replace(/^mailto:/i, "");
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(withoutScheme)
    ? withoutScheme.toLowerCase()
    : null;
}

function attendeeFromProperty(
  property: IcsContentLine,
  organizer: boolean,
): IcsAttendee {
  const role = property.params.get("ROLE")?.[0]?.toUpperCase() ?? "";
  return {
    email: emailFromCalendarAddress(property.value),
    displayName: property.params.get("CN")?.[0] ?? null,
    responseStatus: property.params.get("PARTSTAT")?.[0]?.toLowerCase() ?? null,
    organizer,
    optional: role === "OPT-PARTICIPANT",
  };
}

function parseRevisionAt(component: IcsComponent): string | null {
  const property =
    firstProperty(component, "LAST-MODIFIED") ??
    firstProperty(component, "DTSTAMP");
  if (!property) return null;
  return parseDateProperty(property, "UTC", property.name).instant;
}

function recurrenceLines(component: IcsComponent): string[] {
  const lines: string[] = [];
  for (const name of ["RRULE", "RDATE", "EXDATE"] as const) {
    for (const property of component.properties.get(name) ?? []) {
      lines.push(`${property.serializedName}:${property.value}`);
    }
  }
  return lines;
}

/**
 * Instants named by the EXDATE lines of a stored recurrence line set, parsed
 * like DTSTART (TZID, floating values in `timezone`, all-day at UTC midnight).
 */
export function icsExceptionDateInstants(
  recurrence: readonly string[],
  timezone: string | null,
): Set<number> {
  return readIcsExceptionDates(recurrence, timezone).instants;
}

/** Parse every usable EXDATE while reporting whether any value was invalid. */
export function readIcsExceptionDates(
  recurrence: readonly string[],
  timezone: string | null,
): { instants: Set<number>; complete: boolean; invalidValueCount: number } {
  const instants = new Set<number>();
  let invalidValueCount = 0;
  for (const line of recurrence) {
    if (!/^EXDATE[:;]/i.test(line.trim())) continue;
    let property: IcsContentLine;
    try {
      property = parseContentLine(line);
    } catch {
      invalidValueCount += 1;
      continue;
    }
    for (const value of splitOutsideQuotes(property.value, ",")) {
      try {
        const parsed = parseDateProperty(
          { ...property, value: value.trim() },
          timezone,
          "EXDATE",
        );
        instants.add(Date.parse(parsed.instant));
      } catch {
        invalidValueCount += 1;
      }
    }
  }
  return {
    instants,
    complete: invalidValueCount === 0,
    invalidValueCount,
  };
}

function parseEvent(
  component: IcsComponent,
  calendarTimezone: string | null,
): IcsParsedEvent {
  const uid = propertyValue(component, "UID");
  if (!uid) throw new Error("VEVENT is missing UID.");
  const startProperty = firstProperty(component, "DTSTART");
  if (!startProperty) throw new Error("VEVENT is missing DTSTART.");
  const start = parseDateProperty(startProperty, calendarTimezone, "DTSTART");
  const endProperty = firstProperty(component, "DTEND");
  const duration = propertyValue(component, "DURATION");
  if (endProperty && duration) {
    throw new Error("VEVENT cannot contain both DTEND and DURATION.");
  }
  const end = endProperty
    ? parseDateProperty(endProperty, calendarTimezone, "DTEND")
    : duration
      ? endFromDuration(start, duration)
      : start.isDate
        ? addOneLocalDay(start, "DTEND")
        : start;
  if (Date.parse(end.instant) < Date.parse(start.instant)) {
    throw new Error("VEVENT DTEND precedes DTSTART.");
  }
  if (start.isDate !== end.isDate) {
    throw new Error("VEVENT DTSTART and DTEND value types must match.");
  }
  const recurrenceIdProperty = firstProperty(component, "RECURRENCE-ID");
  const recurrenceId = recurrenceIdProperty
    ? parseDateProperty(recurrenceIdProperty, calendarTimezone, "RECURRENCE-ID")
        .instant
    : null;
  const rawSequence = propertyValue(component, "SEQUENCE") ?? "0";
  if (!/^\d+$/.test(rawSequence)) {
    throw new Error("VEVENT SEQUENCE must be a non-negative integer.");
  }
  const classificationValue = propertyValue(component, "CLASS")?.toLowerCase();
  const classification =
    classificationValue === "public" ||
    classificationValue === "private" ||
    classificationValue === "confidential"
      ? classificationValue
      : null;
  const organizerProperty = firstProperty(component, "ORGANIZER");
  return {
    uid,
    recurrenceId,
    sequence: Number(rawSequence),
    revisionAt: parseRevisionAt(component),
    title: decodeIcsText(propertyValue(component, "SUMMARY") ?? ""),
    description: decodeIcsText(propertyValue(component, "DESCRIPTION") ?? ""),
    location: decodeIcsText(propertyValue(component, "LOCATION") ?? ""),
    status: propertyValue(component, "STATUS")?.toLowerCase() ?? "confirmed",
    startAt: start.instant,
    endAt: end.instant,
    isAllDay: start.isDate,
    timezone: start.timezone,
    url: propertyValue(component, "URL"),
    organizer: organizerProperty
      ? attendeeFromProperty(organizerProperty, true)
      : null,
    attendees: (component.properties.get("ATTENDEE") ?? []).map((property) =>
      attendeeFromProperty(property, false),
    ),
    recurrence: recurrenceLines(component),
    transparency:
      propertyValue(component, "TRANSP")?.toLowerCase() === "transparent"
        ? "transparent"
        : "opaque",
    classification,
    sourceTextTrusted: false,
  };
}

export function parseIcsCalendar(content: string): IcsParsedCalendar {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const lines = unfoldLines(content);
  const components = collectComponents(lines);
  const calendarTimezone =
    propertyValue(components.calendar, "X-WR-TIMEZONE") ?? null;
  const events: IcsParsedEvent[] = [];
  const issues: IcsParseIssue[] = [];
  for (const [eventIndex, component] of components.events.entries()) {
    try {
      events.push(parseEvent(component, calendarTimezone));
    } catch (error) {
      // error-policy:J3 A malformed untrusted VEVENT becomes an explicit issue;
      // valid siblings remain available, and state can never read as complete.
      issues.push({
        code: error instanceof ElizaError ? error.code : "ICS_INVALID_EVENT",
        message: error instanceof Error ? error.message : String(error),
        eventIndex,
        uid: propertyValue(component, "UID"),
      });
    }
  }
  return {
    name:
      propertyValue(components.calendar, "X-WR-CALNAME") ??
      propertyValue(components.calendar, "NAME"),
    timezone: calendarTimezone,
    method: propertyValue(components.calendar, "METHOD"),
    productId: propertyValue(components.calendar, "PRODID"),
    contentHash,
    state:
      issues.length === 0
        ? "complete"
        : events.length > 0
          ? "partial"
          : "error",
    events,
    issues,
  };
}
