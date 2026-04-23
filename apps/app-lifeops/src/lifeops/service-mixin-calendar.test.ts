import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
} from "@elizaos/app-lifeops/contracts";
import { describe, expect, it } from "vitest";
import { mergeAggregatedCalendarFeedEvents } from "./service-mixin-calendar.js";

function calendar(
  overrides: Partial<LifeOpsCalendarSummary> = {},
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: "owner",
    grantId: "grant-1",
    accountEmail: "owner@example.test",
    calendarId: "primary",
    summary: "Primary",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/New_York",
    selected: true,
    includeInFeed: true,
    ...overrides,
  };
}

function event(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "event-1",
    externalId: "external-1",
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Event",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-04-23T12:00:00.000Z",
    endAt: "2026-04-23T13:00:00.000Z",
    isAllDay: false,
    timezone: "America/New_York",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-04-23T11:00:00.000Z",
    updatedAt: "2026-04-23T11:00:00.000Z",
    ...overrides,
  };
}

function feed(
  events: LifeOpsCalendarEvent[],
  overrides: Partial<LifeOpsCalendarFeed> = {},
): LifeOpsCalendarFeed {
  return {
    calendarId: "primary",
    events,
    source: "synced",
    timeMin: "2026-04-23T00:00:00.000Z",
    timeMax: "2026-04-24T00:00:00.000Z",
    syncedAt: "2026-04-23T11:00:00.000Z",
    ...overrides,
  };
}

describe("mergeAggregatedCalendarFeedEvents", () => {
  it("sorts merged events, dedupes by id, and preserves calendar metadata", () => {
    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: calendar({
          grantId: "grant-family",
          accountEmail: "family@example.test",
          calendarId: "family",
          summary: "Family",
          primary: false,
        }),
        feed: feed([
          event({
            id: "dup-1",
            externalId: "shared-1",
            calendarId: "family",
            startAt: "2026-04-23T15:00:00.000Z",
            endAt: "2026-04-23T16:00:00.000Z",
          }),
          event({
            id: "late-1",
            externalId: "late-1",
            calendarId: "family",
            startAt: "2026-04-23T18:00:00.000Z",
            endAt: "2026-04-23T19:00:00.000Z",
          }),
        ]),
      },
      {
        calendar: calendar({
          grantId: "grant-primary",
          accountEmail: "owner@example.test",
          calendarId: "primary",
          summary: "Primary",
        }),
        feed: feed([
          event({
            id: "early-1",
            externalId: "early-1",
            calendarId: "primary",
            startAt: "2026-04-23T09:00:00.000Z",
            endAt: "2026-04-23T10:00:00.000Z",
          }),
          event({
            id: "dup-1",
            externalId: "shared-1",
            calendarId: "family",
            startAt: "2026-04-23T15:00:00.000Z",
            endAt: "2026-04-23T16:00:00.000Z",
          }),
        ]),
      },
    ]);

    expect(merged.map((item) => item.id)).toEqual([
      "early-1",
      "dup-1",
      "late-1",
    ]);
    expect(merged.find((item) => item.id === "dup-1")).toEqual(
      expect.objectContaining({
        calendarId: "family",
        calendarSummary: "Family",
        grantId: "grant-family",
        accountEmail: "family@example.test",
      }),
    );
  });
});
