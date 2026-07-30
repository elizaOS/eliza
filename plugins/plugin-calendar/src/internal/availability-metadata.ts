/**
 * Structural metadata and event construction for calendar-owned availability
 * reservations. Travel and hold semantics are encoded as typed fields so
 * conflict behavior never depends on titles, descriptions, or prompt text.
 */

import { ElizaError } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";

export const CALENDAR_AVAILABILITY_KINDS = ["travel", "hold"] as const;
export type CalendarOwnedAvailabilityKind =
  (typeof CALENDAR_AVAILABILITY_KINDS)[number];

const LOCAL_AVAILABILITY_FLAG = "locallyManagedAvailability";
const AVAILABILITY_KIND_KEY = "availabilityKind";
const PARENT_EVENT_ID_KEY = "parentEventId";
const IDEMPOTENCY_KEY = "idempotencyKey";

function invalidReservation(
  message: string,
  context: Record<string, unknown>,
): never {
  throw new ElizaError(message, {
    code: "CALENDAR_AVAILABILITY_RESERVATION_INVALID",
    context,
    severity: "fatal",
  });
}

export function calendarAvailabilityKindFromMetadata(
  metadata: Record<string, unknown>,
): CalendarOwnedAvailabilityKind | null {
  const value = metadata[AVAILABILITY_KIND_KEY];
  return value === "travel" || value === "hold" ? value : null;
}

export function isLocallyManagedAvailabilityEvent(
  event: Pick<LifeOpsCalendarEvent, "metadata">,
): boolean {
  return (
    event.metadata[LOCAL_AVAILABILITY_FLAG] === true &&
    calendarAvailabilityKindFromMetadata(event.metadata) !== null
  );
}

export function availabilityReservationParentEventId(
  event: Pick<LifeOpsCalendarEvent, "metadata">,
): string | null {
  if (!isLocallyManagedAvailabilityEvent(event)) return null;
  const value = event.metadata[PARENT_EVENT_ID_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createCalendarAvailabilityReservation(args: {
  parent: LifeOpsCalendarEvent;
  kind: CalendarOwnedAvailabilityKind;
  startAt: string;
  endAt: string;
  idempotencyKey: string;
  now?: Date;
}): LifeOpsCalendarEvent {
  if (isLocallyManagedAvailabilityEvent(args.parent)) {
    return invalidReservation(
      "Availability reservations cannot own children.",
      {
        parentEventId: args.parent.id,
      },
    );
  }
  const start = Date.parse(args.startAt);
  const end = Date.parse(args.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return invalidReservation(
      "Availability reservations require a valid, increasing time window.",
      { startAt: args.startAt, endAt: args.endAt },
    );
  }
  const idempotencyKey = args.idempotencyKey.trim();
  if (!idempotencyKey) {
    return invalidReservation(
      "Availability reservations need an idempotency key.",
      {
        parentEventId: args.parent.id,
        kind: args.kind,
      },
    );
  }
  const timestamp = (args.now ?? new Date()).toISOString();
  const suffix = `${args.kind}:${idempotencyKey}`;
  return {
    id: `${args.parent.id}:availability:${suffix}`,
    externalId: `eliza-availability:${args.parent.externalId}:${suffix}`,
    agentId: args.parent.agentId,
    provider: args.parent.provider,
    side: args.parent.side,
    calendarId: args.parent.calendarId,
    title: args.kind === "travel" ? "Travel buffer" : "Calendar hold",
    description: "",
    location: "",
    status: "confirmed",
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    isAllDay: false,
    timezone: args.parent.timezone,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {
      [LOCAL_AVAILABILITY_FLAG]: true,
      [AVAILABILITY_KIND_KEY]: args.kind,
      [PARENT_EVENT_ID_KEY]: args.parent.id,
      [IDEMPOTENCY_KEY]: idempotencyKey,
    },
    recurrence: null,
    recurringEventId: null,
    syncedAt: timestamp,
    updatedAt: timestamp,
    calendarSummary: args.parent.calendarSummary,
    connectorAccountId: args.parent.connectorAccountId,
    grantId: args.parent.grantId,
    accountEmail: args.parent.accountEmail,
  };
}
