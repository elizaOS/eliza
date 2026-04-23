import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
} from "@elizaos/app-lifeops/contracts";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "./service.js";
import { mergeAggregatedCalendarFeedEvents } from "./service-mixin-calendar.js";
import { LifeOpsServiceError } from "./service-types.js";

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

function runtime() {
  return {
    agentId: "agent-calendar-service",
  } as unknown as ConstructorParameters<typeof LifeOpsService>[0];
}

function grant(
  overrides: Partial<LifeOpsConnectorGrant & { identityEmail: string }> = {},
): LifeOpsConnectorGrant & { identityEmail: string } {
  return {
    id: "grant-1",
    agentId: "agent-calendar-service",
    provider: "google",
    side: "owner",
    mode: "cloud_managed",
    executionTarget: "cloud",
    sourceOfTruth: "cloud_profile",
    preferredByAgent: false,
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: [],
    capabilities: ["google.calendar.read"],
    tokenRef: null,
    metadata: {},
    lastRefreshAt: null,
    cloudConnectionId: "cloud-1",
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
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

describe("LifeOps calendar feed fallback", () => {
  it("falls back to primary aggregation when no calendars can be listed", async () => {
    const service = new LifeOpsService(runtime());
    vi.spyOn(service, "listCalendars").mockResolvedValue([]);
    vi.spyOn(service.repository, "listConnectorGrants").mockResolvedValue([
      grant(),
    ]);
    const aggregate = vi
      .spyOn(service, "aggregateCalendarFeeds")
      .mockResolvedValue(
        feed([], {
          calendarId: "primary",
          source: "cache",
          syncedAt: null,
        }),
      );

    const result = await service.getCalendarFeed(
      new URL("http://localhost/api/lifeops/calendar/feed"),
      { side: "owner", mode: "cloud_managed" },
      new Date("2026-04-23T12:00:00.000Z"),
    );

    expect(aggregate).toHaveBeenCalledWith(
      expect.any(URL),
      [expect.objectContaining({ id: "grant-1" })],
      "primary",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false,
      expect.any(Date),
    );
    expect(result.calendarId).toBe("primary");
  });

  it("falls back to primary aggregation when managed calendar discovery is unavailable", async () => {
    const service = new LifeOpsService(runtime());
    vi.spyOn(service, "listCalendars").mockRejectedValue(
      new LifeOpsServiceError(
        503,
        "Google calendar discovery is unavailable for this connection. The connector backend needs the managed calendar-list route.",
      ),
    );
    vi.spyOn(service.repository, "listConnectorGrants").mockResolvedValue([
      grant(),
    ]);
    const aggregate = vi
      .spyOn(service, "aggregateCalendarFeeds")
      .mockResolvedValue(
        feed([], {
          calendarId: "primary",
          source: "cache",
          syncedAt: null,
        }),
      );

    const result = await service.getCalendarFeed(
      new URL("http://localhost/api/lifeops/calendar/feed"),
      { side: "owner", mode: "cloud_managed" },
      new Date("2026-04-23T12:00:00.000Z"),
    );

    expect(aggregate).toHaveBeenCalledOnce();
    expect(result.calendarId).toBe("primary");
  });
});
