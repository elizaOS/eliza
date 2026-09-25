/** Exercises the persisted-state oracle used by both live DST scenarios with deterministic records. */
import type { LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";
import { expect, test } from "vitest";
import { inspectCalendarReschedule } from "./support/helpers/calendar-reschedule-check.js";

function event(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "target",
    externalId: "provider-target",
    agentId: "owner",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Board prep",
    description: "Quarterly plan",
    location: "Office",
    status: "confirmed",
    startAt: "2026-03-08T15:00:00.000Z",
    endAt: "2026-03-08T16:00:00.000Z",
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}
const expected = {
  eventId: "target",
  startAt: "2026-03-08T17:00:00.000Z",
  endAt: "2026-03-08T18:00:00.000Z",
};
const other = event({
  id: "unrelated",
  externalId: "provider-other",
  title: "Afternoon call",
});
const before = [event(), other];
const moved = event({ startAt: expected.startAt, endAt: expected.endAt });

test("accepts the exact persisted move with equivalent offsets and reordered rows", () => {
  expect(
    inspectCalendarReschedule(
      before,
      [
        other,
        {
          ...moved,
          startAt: "2026-03-08T10:00:00-07:00",
          endAt: "2026-03-08T11:00:00-07:00",
          updatedAt: "2026-03-08T12:00:00.000Z",
        },
      ],
      expected,
    ),
  ).toBeUndefined();
});

test.each([
  ["proposal without a persisted move", before],
  [
    "wrong target",
    [event(), { ...other, startAt: expected.startAt, endAt: expected.endAt }],
  ],
  [
    "same local hour on another date",
    [
      {
        ...moved,
        startAt: "2026-03-09T17:00:00Z",
        endAt: "2026-03-09T18:00:00Z",
      },
      other,
    ],
  ],
  ["changed duration", [{ ...moved, endAt: "2026-03-08T18:30:00Z" }, other]],
  ["missing UTC offset", [{ ...moved, startAt: "2026-03-08T17:00:00" }, other]],
  [
    "changed provider identity",
    [{ ...moved, externalId: "replacement" }, other],
  ],
  ["changed event content", [{ ...moved, title: "Different meeting" }, other]],
  [
    "changed recurrence",
    [{ ...moved, recurrence: ["RRULE:FREQ=DAILY"] }, other],
  ],
  ["missing target", [other]],
  ["duplicated target", [moved, moved, other]],
  ["deleted unrelated event", [moved]],
  ["changed unrelated event", [moved, { ...other, title: "Changed" }]],
  ["new unrelated event", [moved, other, event({ id: "extra" })]],
] as const)("rejects %s", (_reason, after) => {
  expect(inspectCalendarReschedule(before, after, expected)).toBeDefined();
});
