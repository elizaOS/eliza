/**
 * Deterministic calendar availability and conflict evaluation.
 *
 * Provider adapters supply source health and privacy level alongside normalized
 * event intervals. This module applies the calendar rules without an LLM:
 * cancelled, declined, and transparent events do not block; stale or missing
 * sources prevent a definitive “free”; and private free/busy data leaves this
 * boundary as anonymous busy intervals.
 */

import { ElizaError } from "@elizaos/core";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../internal/time.js";

export type CalendarAvailabilitySourceStatus =
  | "fresh"
  | "stale"
  | "error"
  | "disconnected";

export type CalendarAvailabilityVisibility = "details" | "busy_only";

export type CalendarAvailabilityCompleteness =
  | "complete"
  | "partial"
  | "unavailable";

export type CalendarConflictSeverity = "warning" | "hard";

export type CalendarAvailabilityEventKind =
  | "event"
  | "guest_busy"
  | "travel"
  | "hold";

export interface CalendarAvailabilityAttendee {
  readonly email: string | null;
  readonly responseStatus?: string | null;
  readonly self?: boolean;
  readonly organizer?: boolean;
  readonly optional?: boolean;
}

export interface CalendarAvailabilityEvent {
  readonly id: string;
  readonly title?: string;
  /** RFC 3339 instant. Offset-less local timestamps are rejected as ambiguous. */
  readonly startISO?: string;
  /** RFC 3339 instant. Offset-less local timestamps are rejected as ambiguous. */
  readonly endISO?: string;
  /** Local date for an all-day event. */
  readonly startDate?: string;
  /** Exclusive local end date for an all-day event. */
  readonly endDate?: string;
  readonly timeZone?: string | null;
  readonly isAllDay?: boolean;
  readonly status?: string | null;
  readonly transparency?: string | null;
  readonly kind?: CalendarAvailabilityEventKind;
  readonly attendees?: readonly (string | CalendarAvailabilityAttendee)[];
}

export interface CalendarAvailabilitySource {
  readonly id: string;
  readonly status: CalendarAvailabilitySourceStatus;
  readonly visibility: CalendarAvailabilityVisibility;
  readonly events: readonly CalendarAvailabilityEvent[];
  readonly error?: string;
}

export interface CalendarAvailabilityRange {
  readonly start: string;
  readonly end: string;
}

export interface CalendarAvailabilityProposal {
  readonly startISO: string;
  readonly endISO: string;
  /**
   * Attendee identities participate only in conflicts already visible in the
   * owner's feed. They never authorize an external free/busy lookup.
   */
  readonly attendees?: readonly string[];
  /**
   * Opaque host-issued references for external guest availability. The host
   * resolves provider/account/calendar coordinates after authenticating the
   * principal and validating purpose, consent, and expiry.
   */
  readonly guestAvailabilityGrantIds?: readonly string[];
}

export interface CalendarAvailabilityPolicy {
  /**
   * Tentative events still reserve time by default, but produce warning-level
   * conflicts. Callers may explicitly ignore them for a looser search.
   */
  readonly tentative?: "block" | "ignore";
  /**
   * Opaque all-day events reserve their local date by default. Transparent
   * all-day annotations never block.
   */
  readonly allDay?: "block" | "ignore";
}

export type CalendarConflictReason =
  | "time_overlap"
  | "shared_attendee"
  | "guest_busy"
  | "tentative"
  | "all_day"
  | "travel";

export interface CalendarConflictEvent {
  readonly id: string;
  readonly title: string;
  readonly startISO: string;
  readonly endISO: string;
  readonly isAllDay: boolean;
  readonly status: string;
  readonly kind: CalendarAvailabilityEventKind;
  readonly attendees: readonly string[];
}

export interface CalendarAvailabilityConflict {
  readonly eventA: CalendarConflictEvent;
  readonly eventB: CalendarConflictEvent;
  readonly severity: CalendarConflictSeverity;
  readonly reasons: readonly CalendarConflictReason[];
  readonly suggestion: string;
}

export interface CalendarAvailabilitySourceSummary {
  readonly id: string;
  readonly status: CalendarAvailabilitySourceStatus;
  readonly visibility: CalendarAvailabilityVisibility;
  readonly eventCount: number;
  readonly error?: string;
}

export interface CalendarAvailabilityEvaluation {
  readonly range: CalendarAvailabilityRange;
  readonly conflicts: readonly CalendarAvailabilityConflict[];
  readonly completeness: CalendarAvailabilityCompleteness;
  readonly definitive: boolean;
  readonly checkedEvents: number;
  readonly ignoredEvents: number;
  readonly sources: readonly CalendarAvailabilitySourceSummary[];
  readonly summary: string;
}

export interface EvaluateCalendarAvailabilityInput {
  readonly range: CalendarAvailabilityRange;
  readonly timeZone: string;
  readonly sources: readonly CalendarAvailabilitySource[];
  readonly proposal?: CalendarAvailabilityProposal;
  readonly policy?: CalendarAvailabilityPolicy;
}

interface NormalizedAvailabilityEvent {
  readonly id: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startISO: string;
  readonly endISO: string;
  readonly isAllDay: boolean;
  readonly status: string;
  readonly kind: CalendarAvailabilityEventKind;
  readonly tentative: boolean;
  readonly attendeeEmails: readonly string[];
  readonly sourceId: string;
  readonly visibility: CalendarAvailabilityVisibility;
}

const DEFAULT_POLICY: Required<CalendarAvailabilityPolicy> = {
  tentative: "block",
  allDay: "block",
};

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function hasExplicitOffset(value: string): boolean {
  // RFC 3339 permits a lowercase time separator (`2026-01-01t10:00:00z`).
  const timeSeparator = value.toUpperCase().indexOf("T");
  if (timeSeparator < 0 || timeSeparator >= value.length - 1) return false;
  if (value.endsWith("Z") || value.endsWith("z")) {
    return value.length - 1 > timeSeparator + 1;
  }
  const compactStart = value.length - 5;
  const colonStart = value.length - 6;
  const offsetStart = value[colonStart + 3] === ":" ? colonStart : compactStart;
  if (offsetStart <= timeSeparator + 1) return false;
  const sign = value[offsetStart];
  if (sign !== "+" && sign !== "-") return false;
  const digits =
    offsetStart === colonStart
      ? `${value.slice(offsetStart + 1, offsetStart + 3)}${value.slice(offsetStart + 4)}`
      : value.slice(offsetStart + 1);
  return (
    digits.length === 4 &&
    [...digits].every((digit) => digit >= "0" && digit <= "9")
  );
}

function invalidAvailabilityInput(
  message: string,
  context: Record<string, unknown>,
): never {
  throw new ElizaError(message, {
    code: "CALENDAR_AVAILABILITY_INVALID_INPUT",
    context,
    severity: "fatal",
  });
}

function parseInstant(value: string, field: string, eventId?: string): number {
  if (!hasExplicitOffset(value)) {
    return invalidAvailabilityInput(
      `${field} must be an RFC 3339 instant with an explicit offset.`,
      { field, value, ...(eventId ? { eventId } : {}) },
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return invalidAvailabilityInput(`${field} is not a valid instant.`, {
      field,
      value,
      ...(eventId ? { eventId } : {}),
    });
  }
  return parsed;
}

function parseLocalDate(
  value: string,
  field: string,
  eventId: string,
): { year: number; month: number; day: number } {
  const match = value.match(LOCAL_DATE_PATTERN);
  if (!match) {
    return invalidAvailabilityInput(`${field} must use YYYY-MM-DD.`, {
      field,
      value,
      eventId,
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return invalidAvailabilityInput(`${field} is not a real calendar date.`, {
      field,
      value,
      eventId,
    });
  }
  return { year, month, day };
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch (error) {
    // error-policy:J2 preserve the Intl failure while adding calendar context.
    throw new ElizaError(`Invalid IANA timezone: ${timeZone}`, {
      code: "CALENDAR_AVAILABILITY_INVALID_TIMEZONE",
      context: { timeZone },
      cause: error,
      severity: "fatal",
    });
  }
}

function localDateStartMs(
  value: string,
  timeZone: string,
  field: string,
  eventId: string,
): number {
  const date = parseLocalDate(value, field, eventId);
  return buildUtcDateFromLocalParts(timeZone, {
    ...date,
    hour: 0,
    minute: 0,
    second: 0,
  }).getTime();
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAttendees(
  attendees: CalendarAvailabilityEvent["attendees"],
): {
  emails: readonly string[];
  selfDeclined: boolean;
} {
  const emails = new Set<string>();
  let selfDeclined = false;
  for (const attendee of attendees ?? []) {
    if (typeof attendee === "string") {
      const email = normalizeEmail(attendee);
      if (email) emails.add(email);
      continue;
    }
    if (attendee.self === true) {
      const response = attendee.responseStatus?.trim().toLowerCase();
      if (response === "declined") {
        selfDeclined = true;
      }
    }
    if (attendee.email) {
      const email = normalizeEmail(attendee.email);
      if (email) emails.add(email);
    }
  }
  return { emails: [...emails].sort(), selfDeclined };
}

function normalizeStatus(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || "confirmed";
}

function isTransparent(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "transparent" || normalized === "free";
}

function resolveEventBounds(
  event: CalendarAvailabilityEvent,
  fallbackTimeZone: string,
): {
  startMs: number;
  endMs: number;
  startISO: string;
  endISO: string;
} {
  if (event.isAllDay && event.startDate) {
    const timeZone = event.timeZone?.trim() || fallbackTimeZone;
    validateTimeZone(timeZone);
    const startDate = parseLocalDate(event.startDate, "startDate", event.id);
    const endDate =
      event.endDate ??
      (() => {
        const next = addDaysToLocalDate(startDate, 1);
        return `${String(next.year).padStart(4, "0")}-${String(
          next.month,
        ).padStart(2, "0")}-${String(next.day).padStart(2, "0")}`;
      })();
    const startMs = localDateStartMs(
      event.startDate,
      timeZone,
      "startDate",
      event.id,
    );
    const endMs = localDateStartMs(endDate, timeZone, "endDate", event.id);
    if (endMs < startMs) {
      return invalidAvailabilityInput(
        "All-day event endDate must not precede startDate.",
        { eventId: event.id, startDate: event.startDate, endDate },
      );
    }
    return {
      startMs,
      endMs,
      startISO: new Date(startMs).toISOString(),
      endISO: new Date(endMs).toISOString(),
    };
  }

  if (!event.startISO || !event.endISO) {
    return invalidAvailabilityInput(
      "Timed availability events require startISO and endISO.",
      { eventId: event.id },
    );
  }
  const startMs = parseInstant(event.startISO, "startISO", event.id);
  const endMs = parseInstant(event.endISO, "endISO", event.id);
  // Google caches endTimeUnspecified events with end == start, so an
  // instantaneous event is valid provider data, not corruption. Only a
  // reversed interval fails the scan.
  if (endMs < startMs) {
    return invalidAvailabilityInput(
      "Availability event endISO must not precede startISO.",
      { eventId: event.id, startISO: event.startISO, endISO: event.endISO },
    );
  }
  return {
    startMs,
    endMs,
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(endMs).toISOString(),
  };
}

function intervalsOverlap(
  left: Pick<NormalizedAvailabilityEvent, "startMs" | "endMs">,
  right: Pick<NormalizedAvailabilityEvent, "startMs" | "endMs">,
): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function compareEvents(
  left: NormalizedAvailabilityEvent,
  right: NormalizedAvailabilityEvent,
): number {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeSourceEvents(args: {
  source: CalendarAvailabilitySource;
  rangeStartMs: number;
  rangeEndMs: number;
  timeZone: string;
  policy: Required<CalendarAvailabilityPolicy>;
}): {
  blockers: NormalizedAvailabilityEvent[];
  ignored: number;
} {
  if (args.source.status === "error" || args.source.status === "disconnected") {
    return { blockers: [], ignored: args.source.events.length };
  }

  const blockers: NormalizedAvailabilityEvent[] = [];
  let ignored = 0;
  for (const event of args.source.events) {
    const privateBusy = args.source.visibility === "busy_only";
    const status = privateBusy ? "busy" : normalizeStatus(event.status);
    const attendees = privateBusy
      ? { emails: [] as string[], selfDeclined: false }
      : normalizeAttendees(event.attendees);
    const tentative = !privateBusy && status === "tentative";
    if (
      !privateBusy &&
      (status === "cancelled" ||
        attendees.selfDeclined ||
        isTransparent(event.transparency) ||
        (tentative && args.policy.tentative === "ignore") ||
        (event.isAllDay === true && args.policy.allDay === "ignore"))
    ) {
      ignored += 1;
      continue;
    }

    const bounds = resolveEventBounds(event, args.timeZone);
    // An instantaneous event is an empty half-open interval: it reserves no
    // time, so it can never double-book a window. It must not enter the
    // blocker set because the pairwise overlap formula assumes non-empty
    // intervals and would report a phantom conflict for any window spanning it.
    if (
      bounds.endMs === bounds.startMs ||
      bounds.startMs >= args.rangeEndMs ||
      bounds.endMs <= args.rangeStartMs
    ) {
      ignored += 1;
      continue;
    }

    blockers.push({
      id: event.id,
      title: event.title?.trim() || "(untitled)",
      ...bounds,
      isAllDay: event.isAllDay === true,
      status,
      kind:
        args.source.visibility === "busy_only"
          ? "guest_busy"
          : (event.kind ?? "event"),
      tentative,
      attendeeEmails: attendees.emails,
      sourceId: args.source.id,
      visibility: args.source.visibility,
    });
  }
  blockers.sort(compareEvents);
  return { blockers, ignored };
}

function evaluateCompleteness(
  sources: readonly CalendarAvailabilitySource[],
): CalendarAvailabilityCompleteness {
  if (sources.length === 0) return "unavailable";
  const usable = sources.filter(
    (source) => source.status === "fresh" || source.status === "stale",
  );
  if (usable.length === 0) return "unavailable";
  if (sources.every((source) => source.status === "fresh")) return "complete";
  return "partial";
}

function sourceSummaries(
  sources: readonly CalendarAvailabilitySource[],
): CalendarAvailabilitySourceSummary[] {
  let privateIndex = 0;
  return sources.map((source) => {
    if (source.visibility === "busy_only") privateIndex += 1;
    const id =
      source.visibility === "busy_only"
        ? `private-busy-${privateIndex}`
        : source.id;
    return {
      id,
      status: source.status,
      visibility: source.visibility,
      eventCount: source.events.length,
      ...(source.error
        ? {
            error:
              source.visibility === "busy_only"
                ? "Private availability source unavailable."
                : source.error,
          }
        : {}),
    };
  });
}

function privateEventIds(
  events: readonly NormalizedAvailabilityEvent[],
): ReadonlyMap<NormalizedAvailabilityEvent, string> {
  let index = 0;
  const ids = new Map<NormalizedAvailabilityEvent, string>();
  for (const event of events) {
    if (event.visibility === "busy_only") {
      index += 1;
      ids.set(event, `private-busy-${index}`);
    }
  }
  return ids;
}

function publicEvent(
  event: NormalizedAvailabilityEvent,
  privateIds: ReadonlyMap<NormalizedAvailabilityEvent, string>,
): CalendarConflictEvent {
  const privateBusy = event.visibility === "busy_only";
  return {
    id: privateBusy ? (privateIds.get(event) ?? "private-busy") : event.id,
    title: privateBusy ? "Busy" : event.title,
    startISO: event.startISO,
    endISO: event.endISO,
    isAllDay: event.isAllDay,
    status: event.status,
    kind: event.kind,
    attendees: privateBusy ? [] : event.attendeeEmails,
  };
}

function sharedAttendee(
  left: NormalizedAvailabilityEvent,
  right: NormalizedAvailabilityEvent,
): boolean {
  const rightEmails = new Set(right.attendeeEmails);
  return left.attendeeEmails.some((email) => rightEmails.has(email));
}

function conflictReasons(
  left: NormalizedAvailabilityEvent,
  right: NormalizedAvailabilityEvent,
): CalendarConflictReason[] {
  const reasons: CalendarConflictReason[] = ["time_overlap"];
  if (
    left.visibility === "busy_only" ||
    right.visibility === "busy_only" ||
    left.kind === "guest_busy" ||
    right.kind === "guest_busy"
  ) {
    reasons.push("guest_busy");
  }
  if (left.tentative || right.tentative) reasons.push("tentative");
  if (left.isAllDay || right.isAllDay) reasons.push("all_day");
  if (left.kind === "travel" || right.kind === "travel") reasons.push("travel");
  if (sharedAttendee(left, right)) reasons.push("shared_attendee");
  return reasons;
}

function severityFor(
  reasons: readonly CalendarConflictReason[],
): CalendarConflictSeverity {
  if (
    reasons.some((reason) =>
      ["guest_busy", "travel", "shared_attendee"].includes(reason),
    )
  ) {
    return "hard";
  }
  return reasons.includes("tentative") || reasons.includes("all_day")
    ? "warning"
    : "hard";
}

function suggestionFor(
  left: CalendarConflictEvent,
  right: CalendarConflictEvent,
  reasons: readonly CalendarConflictReason[],
): string {
  if (reasons.includes("guest_busy")) {
    return "Choose another time — a guest has a private busy block in that window.";
  }
  if (reasons.includes("travel")) {
    return "Move the event or its travel block so the required travel time remains protected.";
  }
  if (reasons.includes("all_day")) {
    return `Review "${left.title}" and "${right.title}" — an opaque all-day commitment covers this window.`;
  }
  if (reasons.includes("shared_attendee")) {
    return `Move "${right.title}" — it shares attendees with "${left.title}".`;
  }
  return `Buffer between "${left.title}" and "${right.title}" — their reserved times overlap.`;
}

function buildConflict(
  left: NormalizedAvailabilityEvent,
  right: NormalizedAvailabilityEvent,
  privateIds: ReadonlyMap<NormalizedAvailabilityEvent, string>,
): CalendarAvailabilityConflict {
  const reasons = conflictReasons(left, right);
  const eventA = publicEvent(left, privateIds);
  const eventB = publicEvent(right, privateIds);
  return {
    eventA,
    eventB,
    severity: severityFor(reasons),
    reasons,
    suggestion: suggestionFor(eventA, eventB, reasons),
  };
}

function summarize(
  conflicts: readonly CalendarAvailabilityConflict[],
  completeness: CalendarAvailabilityCompleteness,
): string {
  if (completeness === "unavailable") {
    return "Calendar availability is unavailable; no definitive conflict scan was possible.";
  }
  if (conflicts.length === 0) {
    return completeness === "complete"
      ? "No conflicts detected."
      : "No conflicts found in available calendar data, but availability is incomplete.";
  }
  const hard = conflicts.filter(
    (conflict) => conflict.severity === "hard",
  ).length;
  const warning = conflicts.length - hard;
  const conflictSummary =
    hard > 0 && warning > 0
      ? `${hard} hard conflict(s) and ${warning} warning(s) detected.`
      : hard > 0
        ? `${hard} hard conflict(s) detected.`
        : `${warning} warning(s) detected.`;
  return completeness === "complete"
    ? conflictSummary
    : `${conflictSummary} Calendar availability is incomplete; recheck stale or unavailable sources before committing.`;
}

function normalizeRange(range: CalendarAvailabilityRange): {
  startMs: number;
  endMs: number;
  normalized: CalendarAvailabilityRange;
} {
  const startMs = parseInstant(range.start, "range.start");
  const endMs = parseInstant(range.end, "range.end");
  if (endMs <= startMs) {
    return invalidAvailabilityInput(
      "Availability range end must be after its start.",
      { start: range.start, end: range.end },
    );
  }
  return {
    startMs,
    endMs,
    normalized: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    },
  };
}

function proposalEvent(
  proposal: CalendarAvailabilityProposal,
): NormalizedAvailabilityEvent {
  const startMs = parseInstant(proposal.startISO, "proposal.startISO");
  const endMs = parseInstant(proposal.endISO, "proposal.endISO");
  if (endMs <= startMs) {
    return invalidAvailabilityInput("Proposal endISO must be after startISO.", {
      startISO: proposal.startISO,
      endISO: proposal.endISO,
      attendees: proposal.attendees ? [...proposal.attendees] : undefined,
    });
  }
  const attendees = (proposal.attendees ?? [])
    .map(normalizeEmail)
    .filter((email): email is string => email !== null)
    .sort();
  return {
    id: "proposal",
    title: "Proposed event",
    startMs,
    endMs,
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(endMs).toISOString(),
    isAllDay: false,
    status: "confirmed",
    kind: "event",
    tentative: false,
    attendeeEmails: attendees,
    sourceId: "proposal",
    visibility: "details",
  };
}

/**
 * Evaluate one calendar window. The result is safe to expose to an action:
 * private sources are redacted and incomplete coverage cannot produce a
 * definitive zero-conflict answer.
 */
export function evaluateCalendarAvailability(
  input: EvaluateCalendarAvailabilityInput,
): CalendarAvailabilityEvaluation {
  validateTimeZone(input.timeZone);
  const range = normalizeRange(input.range);
  const policy = { ...DEFAULT_POLICY, ...input.policy };
  const completeness = evaluateCompleteness(input.sources);
  const proposal = input.proposal ? proposalEvent(input.proposal) : null;
  if (
    proposal &&
    (proposal.startMs < range.startMs || proposal.endMs > range.endMs)
  ) {
    return invalidAvailabilityInput(
      "Proposal must fall entirely inside the availability range.",
      {
        range: range.normalized,
        proposal: {
          startISO: proposal.startISO,
          endISO: proposal.endISO,
        },
      },
    );
  }

  const blockers: NormalizedAvailabilityEvent[] = [];
  let ignoredEvents = 0;
  for (const source of input.sources) {
    const normalized = normalizeSourceEvents({
      source,
      rangeStartMs: range.startMs,
      rangeEndMs: range.endMs,
      timeZone: input.timeZone,
      policy,
    });
    blockers.push(...normalized.blockers);
    ignoredEvents += normalized.ignored;
  }
  blockers.sort(compareEvents);
  const privateIds = privateEventIds(blockers);

  const conflicts: CalendarAvailabilityConflict[] = [];
  if (proposal) {
    for (const blocker of blockers) {
      if (intervalsOverlap(proposal, blocker)) {
        conflicts.push(buildConflict(proposal, blocker, privateIds));
      }
    }
  } else {
    for (let leftIndex = 0; leftIndex < blockers.length; leftIndex += 1) {
      const left = blockers[leftIndex];
      if (!left) continue;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < blockers.length;
        rightIndex += 1
      ) {
        const right = blockers[rightIndex];
        if (!right) continue;
        if (right.startMs >= left.endMs) break;
        if (intervalsOverlap(left, right)) {
          conflicts.push(buildConflict(left, right, privateIds));
        }
      }
    }
  }

  return {
    range: range.normalized,
    conflicts,
    completeness,
    definitive: completeness === "complete",
    checkedEvents: blockers.length,
    ignoredEvents,
    sources: sourceSummaries(input.sources),
    summary: summarize(conflicts, completeness),
  };
}

function formatLocalDate(date: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(
    2,
    "0",
  )}-${String(date.day).padStart(2, "0")}`;
}

/**
 * Build an exclusive local-day range. Because each boundary is resolved in the
 * requested IANA zone, spring-forward days are 23 hours and fall-back days are
 * 25 hours without special-case arithmetic.
 */
export function buildZonedCalendarRange(args: {
  now: Date;
  timeZone: string;
  days: number;
}): CalendarAvailabilityRange {
  validateTimeZone(args.timeZone);
  if (!Number.isInteger(args.days) || args.days < 1) {
    return invalidAvailabilityInput("days must be a positive integer.", {
      days: args.days,
    });
  }
  const localNow = getZonedDateParts(args.now, args.timeZone);
  const localStart = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
  const localEnd = addDaysToLocalDate(localStart, args.days);
  return {
    start: new Date(
      localDateStartMs(
        formatLocalDate(localStart),
        args.timeZone,
        "range.startDate",
        "range",
      ),
    ).toISOString(),
    end: new Date(
      localDateStartMs(
        formatLocalDate(localEnd),
        args.timeZone,
        "range.endDate",
        "range",
      ),
    ).toISOString(),
  };
}
