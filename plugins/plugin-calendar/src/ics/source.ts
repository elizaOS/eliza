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
import {
  expandRecurrenceOccurrences,
  firstRecurrenceRule,
} from "../internal/recurrence.js";
import type { IcsCalendarSourceRecord } from "../service/CalendarRepository.js";
import { icsExceptionDateInstants } from "./parser.js";
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
 * and instances replaced by a RECURRENCE-ID override. A series this module
 * cannot expand exactly (RDATE, rule parts outside the local subset, the
 * generator cap) keeps its stored event and makes the result incomplete.
 */
export function expandIcsCalendarEvents(args: {
  events: readonly LifeOpsCalendarEvent[];
  timeMin: string;
  timeMax: string;
}): { events: LifeOpsCalendarEvent[]; complete: boolean } {
  const minMs = Date.parse(args.timeMin);
  const maxMs = Date.parse(args.timeMax);
  const overlaps = (startMs: number, endMs: number) =>
    endMs > minMs && startMs < maxMs;
  const overridden = new Set<string>();
  for (const event of args.events) {
    const recurrenceId = event.metadata.icsRecurrenceId;
    if (typeof recurrenceId === "string") {
      overridden.add(`${event.metadata.icsUid}\0${Date.parse(recurrenceId)}`);
    }
  }
  let complete = true;
  const expanded: LifeOpsCalendarEvent[] = [];
  for (const event of args.events) {
    const startMs = Date.parse(event.startAt);
    const endMs = Date.parse(event.endAt);
    const recurrence = event.recurrence ?? [];
    const rule = firstRecurrenceRule(recurrence);
    if (
      !rule ||
      typeof event.metadata.icsRecurrenceId === "string" ||
      !recurrence.some((line) => /^RRULE[:;]/i.test(line))
    ) {
      if (overlaps(startMs, endMs)) expanded.push(event);
      continue;
    }
    if (
      rule.beyondExpansionSubset ||
      recurrence.some((line) => /^RDATE[:;]/i.test(line))
    ) {
      complete = false;
      if (overlaps(startMs, endMs)) expanded.push(event);
      continue;
    }
    const durationMs = endMs - startMs;
    const excluded = icsExceptionDateInstants(recurrence, event.timezone);
    const starts = expandRecurrenceOccurrences({
      rule,
      startAt: new Date(startMs),
      timeZone: event.isAllDay ? "UTC" : (event.timezone ?? "UTC"),
      rangeEnd: new Date(maxMs),
    });
    if (starts.length >= 1000) complete = false;
    for (const start of starts) {
      const occurrenceMs = start.getTime();
      if (!overlaps(occurrenceMs, occurrenceMs + durationMs)) continue;
      if (excluded.has(occurrenceMs)) continue;
      if (overridden.has(`${event.metadata.icsUid}\0${occurrenceMs}`)) continue;
      if (occurrenceMs === startMs) {
        expanded.push(event);
        continue;
      }
      const occurrenceStart = start.toISOString();
      expanded.push({
        ...event,
        id: `${event.id}:${occurrenceStart}`,
        startAt: occurrenceStart,
        endAt: new Date(occurrenceMs + durationMs).toISOString(),
        recurringEventId: event.id,
        metadata: { ...event.metadata, originalStartTime: occurrenceStart },
      });
    }
  }
  expanded.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  return { events: expanded, complete };
}
