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
} from "@elizaos/shared";
import type { IcsCalendarSourceRecord } from "../service/CalendarRepository.js";
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
