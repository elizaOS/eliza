import { describe, expect, it } from "vitest";
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/lifeops";
import { matchesCalendarEventEndedFilters } from "./service-mixin-workflows.js";

function makeEvent(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "evt_1",
    externalId: "ext_1",
    agentId: "agent_1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Design review",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-04-19T14:00:00.000Z",
    endAt: "2026-04-19T15:00:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [
      { email: "owner@example.com" },
      { email: "pm@acme.com" },
    ] as unknown as LifeOpsCalendarEvent["attendees"],
    metadata: {},
    syncedAt: "2026-04-19T14:00:00.000Z",
    updatedAt: "2026-04-19T14:00:00.000Z",
    ...overrides,
  };
}

describe("matchesCalendarEventEndedFilters", () => {
  it("matches any event when filters are undefined", () => {
    expect(matchesCalendarEventEndedFilters(makeEvent(), undefined)).toBe(true);
  });

  it("matches when calendarIds filter contains the event's calendar", () => {
    expect(
      matchesCalendarEventEndedFilters(makeEvent(), {
        calendarIds: ["primary", "team"],
      }),
    ).toBe(true);
  });

  it("rejects when calendarIds filter excludes the event's calendar", () => {
    expect(
      matchesCalendarEventEndedFilters(makeEvent({ calendarId: "other" }), {
        calendarIds: ["primary"],
      }),
    ).toBe(false);
  });

  it("matches titleIncludesAny case-insensitively", () => {
    expect(
      matchesCalendarEventEndedFilters(makeEvent({ title: "Weekly Design Review" }), {
        titleIncludesAny: ["design review"],
      }),
    ).toBe(true);
  });

  it("rejects when titleIncludesAny has no overlap", () => {
    expect(
      matchesCalendarEventEndedFilters(makeEvent({ title: "1:1 with Ana" }), {
        titleIncludesAny: ["standup", "retro"],
      }),
    ).toBe(false);
  });

  it("matches when event duration meets minDurationMinutes", () => {
    const event = makeEvent({
      startAt: "2026-04-19T14:00:00.000Z",
      endAt: "2026-04-19T14:45:00.000Z",
    });
    expect(
      matchesCalendarEventEndedFilters(event, { minDurationMinutes: 30 }),
    ).toBe(true);
  });

  it("rejects when event is shorter than minDurationMinutes", () => {
    const event = makeEvent({
      startAt: "2026-04-19T14:00:00.000Z",
      endAt: "2026-04-19T14:04:00.000Z",
    });
    expect(
      matchesCalendarEventEndedFilters(event, { minDurationMinutes: 5 }),
    ).toBe(false);
  });

  it("matches when any attendee email contains a filter substring", () => {
    expect(
      matchesCalendarEventEndedFilters(makeEvent(), {
        attendeeEmailIncludesAny: ["acme.com"],
      }),
    ).toBe(true);
  });

  it("rejects when no attendee matches", () => {
    expect(
      matchesCalendarEventEndedFilters(makeEvent(), {
        attendeeEmailIncludesAny: ["contoso.com"],
      }),
    ).toBe(false);
  });

  it("requires every configured filter to match (AND semantics)", () => {
    const event = makeEvent({
      title: "Client call",
      calendarId: "primary",
    });
    expect(
      matchesCalendarEventEndedFilters(event, {
        calendarIds: ["primary"],
        titleIncludesAny: ["client"],
        attendeeEmailIncludesAny: ["contoso.com"],
      }),
    ).toBe(false);
    expect(
      matchesCalendarEventEndedFilters(event, {
        calendarIds: ["primary"],
        titleIncludesAny: ["client"],
        attendeeEmailIncludesAny: ["acme.com"],
      }),
    ).toBe(true);
  });
});
