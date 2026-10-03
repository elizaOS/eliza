/** Validates persisted reschedules without treating model proposals or action text as receipts. */
import { isDeepStrictEqual } from "node:util";
import type { LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";

const preservedFields = [
  "id",
  "externalId",
  "agentId",
  "provider",
  "side",
  "calendarId",
  "connectorAccountId",
  "grantId",
  "accountEmail",
  "title",
  "description",
  "location",
  "status",
  "isAllDay",
  "timezone",
  "attendees",
  "organizer",
  "conferenceLink",
  "htmlLink",
  "recurrence",
  "recurringEventId",
] as const satisfies readonly (keyof LifeOpsCalendarEvent)[];

function instant(value: string): number {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : Number.NaN;
}

export function inspectCalendarReschedule(
  before: readonly LifeOpsCalendarEvent[],
  after: readonly LifeOpsCalendarEvent[],
  expected: { eventId: string; startAt: string; endAt: string },
): string | undefined {
  const originals = before.filter((event) => event.id === expected.eventId);
  const targets = after.filter((event) => event.id === expected.eventId);
  const original = originals[0];
  const target = targets[0];
  if (!original || !target || originals.length !== 1 || targets.length !== 1) {
    return "exact seeded event is missing or duplicated";
  }
  if (
    instant(target.startAt) !== instant(expected.startAt) ||
    instant(target.endAt) !== instant(expected.endAt)
  ) {
    return "persisted target does not match the requested start and end instants";
  }
  for (const field of preservedFields) {
    if (!isDeepStrictEqual(target[field], original[field])) {
      return `reschedule changed the target's ${field}`;
    }
  }
  const unrelated = (rows: readonly LifeOpsCalendarEvent[]) =>
    rows
      .filter((event) => event.id !== expected.eventId)
      .sort((left, right) => left.id.localeCompare(right.id));
  if (!isDeepStrictEqual(unrelated(before), unrelated(after))) {
    return "reschedule added, removed or changed an unrelated event";
  }
  return undefined;
}
