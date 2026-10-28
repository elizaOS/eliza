/**
 * Maps private ICS source records and untrusted VEVENTs onto the public
 * calendar contract. Subscription URLs and secret references never cross this
 * boundary; feed-authored text is marked as evidence rather than authority.
 */

import { createHash } from "node:crypto";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSummary,
  LifeOpsIcsCalendarSource,
} from "@elizaos/contracts";
import { CalendarServiceError } from "../internal/errors.js";
import {
  expandRecurrenceOccurrences,
  firstRecurrenceRule,
  MAX_EXPANDED_RECURRENCE_OCCURRENCES,
} from "../internal/recurrence.js";
import { getZonedDateParts } from "../internal/time.js";
import type { IcsCalendarSourceRecord } from "../service/CalendarRepository.js";
import {
  endAtFromIcsDuration,
  readIcsExceptionDates,
  startAtBeforeIcsDurationEnd,
} from "./parser.js";
import type { IcsParsedEvent } from "./types.js";

export function publicIcsCalendarSource(
  source: IcsCalendarSourceRecord,
): LifeOpsIcsCalendarSource {
  return {
    id: source.id,
    provider: "ics",
    name: source.name,
    enabled: source.enabled,
    origin: source.origin,
    urlFingerprint: source.urlFingerprint,
    syncStatus: source.syncStatus,
    lastSyncedAt: source.lastSyncedAt,
    lastAttemptedAt: source.lastAttemptedAt,
    error: source.error,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function icsCalendarSummary(
  source: IcsCalendarSourceRecord,
): LifeOpsCalendarSummary {
  return {
    provider: "ics",
    side: "owner",
    grantId: source.id,
    connectorAccountId: source.id,
    accountEmail: null,
    calendarId: source.id,
    summary: source.name,
    description: `Subscribed calendar from ${source.origin}`,
    primary: false,
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: source.enabled,
    includeInFeed: source.enabled,
    selectionVersion: 0,
  };
}

export function icsEventIdentity(event: IcsParsedEvent): string {
  return createHash("sha256")
    .update(event.uid)
    .update("\0")
    .update(event.recurrenceId ?? "")
    .digest("hex");
}

/**
 * One copy per event identity. A feed can repeat a VEVENT (merged or
 * re-exported calendars), and the snapshot upsert can write each id only
 * once. Keep the newest copy by the order the upsert uses: SEQUENCE, then
 * revision time; on a full tie the first copy stays.
 */
export function newestIcsEventPerIdentity(
  events: readonly IcsParsedEvent[],
): IcsParsedEvent[] {
  const byIdentity = new Map<string, IcsParsedEvent>();
  for (const event of events) {
    const identity = icsEventIdentity(event);
    const kept = byIdentity.get(identity);
    if (
      !kept ||
      event.sequence > kept.sequence ||
      (event.sequence === kept.sequence &&
        (event.revisionAt ?? "") > (kept.revisionAt ?? ""))
    ) {
      byIdentity.set(identity, event);
    }
  }
  return [...byIdentity.values()];
}

export function lifeOpsCalendarEventFromIcs(args: {
  event: IcsParsedEvent;
  source: IcsCalendarSourceRecord;
  syncedAt: string;
}): LifeOpsCalendarEvent {
  const identity = icsEventIdentity(args.event);
  const eventId = `ics:${identity}`;
  return {
    id: `${args.source.agentId}:ics:${args.source.id}:${identity}`,
    externalId: eventId,
    agentId: args.source.agentId,
    provider: "ics",
    side: "owner",
    calendarId: args.source.id,
    connectorAccountId: args.source.id,
    grantId: args.source.id,
    title: args.event.title,
    description: args.event.description,
    location: args.event.location,
    status: args.event.status,
    startAt: args.event.startAt,
    endAt: args.event.endAt,
    isAllDay: args.event.isAllDay,
    timezone: args.event.timezone || null,
    htmlLink: null,
    conferenceLink: null,
    organizer: args.event.organizer
      ? {
          email: args.event.organizer.email,
          displayName: args.event.organizer.displayName,
        }
      : null,
    attendees: args.event.attendees.map((attendee) => ({
      ...attendee,
      self: false,
    })),
    recurrence: args.event.recurrence,
    recurringEventId: null,
    metadata: {
      sourceKind: "ics_subscription",
      sourceId: args.source.id,
      sourceOrigin: args.source.origin,
      sourceTextTrusted: false,
      untrustedSource: true,
      icsUid: args.event.uid,
      icsRecurrenceId: args.event.recurrenceId,
      icsSequence: args.event.sequence,
      icsRevisionAt: args.event.revisionAt,
      icsDuration: args.event.duration,
      icsTransparency: args.event.transparency,
      icsClassification: args.event.classification,
      icsEventUrl: args.event.url,
      recurrence: args.event.recurrence,
    },
    syncedAt: args.syncedAt,
    updatedAt: args.event.revisionAt ?? args.syncedAt,
  };
}

/**
 * A subscribed feed stores each recurring VEVENT once, at DTSTART. Expand
 * every series into its occurrences inside [timeMin, timeMax), minus EXDATEs
 * and instances replaced by a RECURRENCE-ID override. An all-day event is a
 * civil date that the caller places on local days, so its window is the wider
 * [allDayTimeMin, allDayTimeMax). A series this module
 * cannot expand exactly (RDATE, rule parts outside the local subset, the
 * generator cap) keeps its stored event and makes the result incomplete.
 */
export function expandIcsCalendarEvents(args: {
  events: readonly LifeOpsCalendarEvent[];
  timeMin: string;
  timeMax: string;
  allDayTimeMin: string;
  allDayTimeMax: string;
}): {
  events: LifeOpsCalendarEvent[];
  complete: boolean;
  diagnostics: Array<
    "CALENDAR_ICS_EXDATE_INVALID" | "CALENDAR_RECURRENCE_EXPANSION_INVALID_DATE"
  >;
} {
  const timedWindow = {
    minMs: Date.parse(args.timeMin),
    maxMs: Date.parse(args.timeMax),
  };
  const allDayWindow = {
    minMs: Date.parse(args.allDayTimeMin),
    maxMs: Date.parse(args.allDayTimeMax),
  };
  const overridden = new Set<string>();
  for (const event of args.events) {
    const recurrenceId = event.metadata.icsRecurrenceId;
    if (typeof recurrenceId === "string") {
      overridden.add(`${event.metadata.icsUid}\0${Date.parse(recurrenceId)}`);
    }
  }
  let complete = true;
  const diagnostics = new Set<
    "CALENDAR_ICS_EXDATE_INVALID" | "CALENDAR_RECURRENCE_EXPANSION_INVALID_DATE"
  >();
  const expanded: LifeOpsCalendarEvent[] = [];
  for (const event of args.events) {
    const startMs = Date.parse(event.startAt);
    const endMs = Date.parse(event.endAt);
    const { minMs, maxMs } = event.isAllDay ? allDayWindow : timedWindow;
    // RFC 5545 permits a timed VEVENT with no DTEND/DURATION: an instant.
    const overlaps = (overlapStartMs: number, overlapEndMs: number) =>
      (overlapEndMs > minMs ||
        (overlapEndMs === overlapStartMs && overlapStartMs >= minMs)) &&
      overlapStartMs < maxMs;
    const recurrence = event.recurrence ?? [];
    const ruleLineCount = recurrence.filter((line) =>
      /^RRULE[:;]/i.test(line),
    ).length;
    const hasRdate = recurrence.some((line) => /^RDATE[:;]/i.test(line));
    if (
      typeof event.metadata.icsRecurrenceId === "string" ||
      (ruleLineCount === 0 && !hasRdate)
    ) {
      if (overlaps(startMs, endMs)) expanded.push(event);
      continue;
    }
    // The event repeats. A rule that does not parse (FREQ=HOURLY, COUNT with
    // UNTIL), a second RRULE line, an RDATE, or a rule outside the local
    // subset all leave occurrences this module cannot produce.
    // A feed can give UNTIL as a local date and time (RFC 5545 requires that
    // form for a local DTSTART); it ends the series in the series time zone.
    const rule =
      ruleLineCount === 1
        ? firstRecurrenceRule(recurrence, {
            localUntil: true,
            monthlyByDay: true,
            yearlyByMonth: true,
            bySetPos: true,
            dailyByDay: true,
          })
        : null;
    if (!rule || rule.beyondExpansionSubset || hasRdate) {
      complete = false;
      if (overlaps(startMs, endMs)) expanded.push(event);
      continue;
    }
    const durationMs = endMs - startMs;
    const icsDuration =
      typeof event.metadata.icsDuration === "string"
        ? event.metadata.icsDuration
        : null;
    const excluded = readIcsExceptionDates(recurrence, event.timezone);
    if (excluded.invalidValueCount > 0) {
      complete = false;
      diagnostics.add("CALENDAR_ICS_EXDATE_INVALID");
    }
    const seriesTimeZone = event.isAllDay ? "UTC" : (event.timezone ?? "UTC");
    let starts: Date[];
    try {
      starts = expandRecurrenceOccurrences({
        rule,
        startAt: new Date(startMs),
        timeZone: seriesTimeZone,
        rangeStart: new Date(
          icsDuration
            ? Date.parse(
                startAtBeforeIcsDurationEnd({
                  endAt: new Date(minMs).toISOString(),
                  timezone: seriesTimeZone,
                  isAllDay: event.isAllDay,
                  duration: icsDuration,
                }),
              ) + 1
            : minMs - durationMs + (durationMs === 0 ? 0 : 1),
        ),
        rangeEnd: new Date(maxMs),
        // RFC 5545 §3.3.10: a feed occurrence at a nonexistent local time
        // is ignored and does not count toward COUNT.
        nonexistentLocalTime: "skip",
      });
    } catch (error) {
      if (
        error instanceof CalendarServiceError &&
        error.code === "CALENDAR_RECURRENCE_EXPANSION_INVALID_DATE"
      ) {
        complete = false;
        diagnostics.add("CALENDAR_RECURRENCE_EXPANSION_INVALID_DATE");
        if (overlaps(startMs, endMs)) expanded.push(event);
        continue;
      }
      throw error;
    }
    if (starts.length >= MAX_EXPANDED_RECURRENCE_OCCURRENCES) {
      complete = false;
    }
    for (const start of starts) {
      const occurrenceMs = start.getTime();
      const occurrenceEndAt = icsDuration
        ? endAtFromIcsDuration({
            startAt: start.toISOString(),
            timezone: seriesTimeZone,
            isAllDay: event.isAllDay,
            duration: icsDuration,
          })
        : new Date(occurrenceMs + durationMs).toISOString();
      const occurrenceEndMs = Date.parse(occurrenceEndAt);
      if (!overlaps(occurrenceMs, occurrenceEndMs)) continue;
      if (excluded.instants.has(occurrenceMs)) continue;
      // A DATE EXDATE names a day. It excludes the occurrence that starts on
      // that day in the series time zone (UTC for an all-day series).
      if (excluded.dates.size > 0) {
        const day = getZonedDateParts(start, seriesTimeZone);
        if (excluded.dates.has(Date.UTC(day.year, day.month - 1, day.day))) {
          continue;
        }
      }
      if (overridden.has(`${event.metadata.icsUid}\0${occurrenceMs}`)) continue;
      const occurrenceStart = start.toISOString();
      if (occurrenceMs === startMs) {
        expanded.push({
          ...event,
          recurringEventId: event.id,
          metadata: { ...event.metadata, originalStartTime: occurrenceStart },
        });
        continue;
      }
      expanded.push({
        ...event,
        id: `${event.id}:${occurrenceStart}`,
        startAt: occurrenceStart,
        endAt: occurrenceEndAt,
        recurringEventId: event.id,
        metadata: { ...event.metadata, originalStartTime: occurrenceStart },
      });
    }
  }
  expanded.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  return { events: expanded, complete, diagnostics: [...diagnostics] };
}
