/**
 * Unit tests for the calendar normalization + feed-merge helpers that back
 * `CalendarService`. Pure functions, no runtime — these lock the input
 * validation and aggregation contracts the service and routes depend on.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  buildNextCalendarEventContext,
  normalizeCalendarAttendees,
  normalizeCalendarDateTimeInTimeZone,
  normalizeCalendarId,
  normalizeCalendarTimeZone,
  resolveCalendarEventRange,
  resolveCalendarWindow,
} from "../src/internal/calendar-normalize.js";
import { CalendarServiceError } from "../src/internal/errors.js";
import { mergeAggregatedCalendarFeedEvents } from "../src/service/CalendarService.js";

function makeEvent(
  overrides: Partial<LifeOpsCalendarEvent> &
    Pick<LifeOpsCalendarEvent, "id" | "startAt">,
): LifeOpsCalendarEvent {
  return {
    externalId: overrides.id,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Event",
    description: "",
    location: "",
    status: "confirmed",
    endAt: overrides.startAt,
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeCalendarId", () => {
  it("defaults empty input to the primary calendar", () => {
    expect(normalizeCalendarId(undefined)).toBe("primary");
    expect(normalizeCalendarId("")).toBe("primary");
    expect(normalizeCalendarId(null)).toBe("primary");
  });

  it("passes through a concrete calendar id", () => {
    expect(normalizeCalendarId("work@group.calendar.google.com")).toBe(
      "work@group.calendar.google.com",
    );
  });
});

describe("normalizeCalendarTimeZone", () => {
  it("accepts a valid IANA zone", () => {
    expect(normalizeCalendarTimeZone("America/New_York")).toBe(
      "America/New_York",
    );
  });

  it("rejects an invalid zone", () => {
    expect(() => normalizeCalendarTimeZone("Not/AZone")).toThrow(
      CalendarServiceError,
    );
  });

  it("falls back to a non-empty default zone for empty input", () => {
    const result = normalizeCalendarTimeZone(undefined);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("normalizeCalendarDateTimeInTimeZone", () => {
  it("returns undefined for empty values", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(undefined, "startAt", "UTC"),
    ).toBeUndefined();
    expect(
      normalizeCalendarDateTimeInTimeZone("", "startAt", "UTC"),
    ).toBeUndefined();
  });

  it("passes through an explicit UTC ISO instant", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2026-03-04T15:30:00.000Z",
        "startAt",
        "America/New_York",
      ),
    ).toBe("2026-03-04T15:30:00.000Z");
  });

  it.each([
    "2026-02-30T09:00:00Z",
    "2026-02-29T09:00:00+00:00",
    "2026-04-31T09:00:00Z",
    "2026-02-30Z",
    "2026-02-30T09:00:00+0000",
    "+010000-02-30T09:00:00Z",
    "2026-02-30 09:00:00 GMT",
    "2026-02-30 09:00:00 UTC",
    "2026-02-30 09:00:00 GMT+05:00",
    "2026-02-30 09:00:00 +5:00",
    "2026-02-30t09:00:00.1234567890z",
  ])("rejects an impossible explicit calendar date: %s", (value) => {
    expect(() =>
      normalizeCalendarDateTimeInTimeZone(value, "startAt", "UTC"),
    ).toThrow(CalendarServiceError);
  });

  it.each([
    "2026-03-04Z",
    "2026-03-04T09:00:00+0000",
    "+010000-02-28T09:00:00Z",
    "2026-03-04t09:00:00z",
    "2026-03-04T09:00:00.1234567890Z",
    "2026-03-04 09:00:00 +05:00",
    "2026-03-04 09:00:00 GMT+05:00",
    "2026-03-04 09:00:00 GMT",
    "2026-03-04 09:00:00 UTC",
  ])("preserves valid explicit calendar forms: %s", (value) => {
    expect(() =>
      normalizeCalendarDateTimeInTimeZone(value, "startAt", "UTC"),
    ).not.toThrow();
  });

  it("interprets a bare local datetime in the supplied zone", () => {
    // 09:00 local in UTC stays 09:00Z.
    expect(
      normalizeCalendarDateTimeInTimeZone("2026-03-04T09:00", "startAt", "UTC"),
    ).toBe("2026-03-04T09:00:00.000Z");
    // 09:00 local in a +05:00 zone is 04:00Z.
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2026-03-04T09:00",
        "startAt",
        "Asia/Karachi",
      ),
    ).toBe("2026-03-04T04:00:00.000Z");
  });
});

describe("resolveCalendarWindow", () => {
  const now = new Date("2026-03-04T12:00:00.000Z");

  it("returns an explicit window when both bounds are given", () => {
    const { timeMin, timeMax } = resolveCalendarWindow({
      now,
      timeZone: "UTC",
      requestedTimeMin: "2026-03-04T00:00:00.000Z",
      requestedTimeMax: "2026-03-05T00:00:00.000Z",
    });
    expect(timeMin).toBe("2026-03-04T00:00:00.000Z");
    expect(timeMax).toBe("2026-03-05T00:00:00.000Z");
  });

  it("rejects an inverted window", () => {
    expect(() =>
      resolveCalendarWindow({
        now,
        timeZone: "UTC",
        requestedTimeMin: "2026-03-05T00:00:00.000Z",
        requestedTimeMax: "2026-03-04T00:00:00.000Z",
      }),
    ).toThrow(CalendarServiceError);
  });

  it("rejects a half-specified window", () => {
    expect(() =>
      resolveCalendarWindow({
        now,
        timeZone: "UTC",
        requestedTimeMin: "2026-03-04T00:00:00.000Z",
      }),
    ).toThrow(CalendarServiceError);
  });

  it("defaults to a single local day when no bounds are given", () => {
    const { timeMin, timeMax } = resolveCalendarWindow({
      now,
      timeZone: "UTC",
    });
    expect(timeMin).toBe("2026-03-04T00:00:00.000Z");
    expect(timeMax).toBe("2026-03-05T00:00:00.000Z");
  });
});

describe("normalizeCalendarAttendees", () => {
  it("normalizes a list of attendee inputs", () => {
    const result = normalizeCalendarAttendees([
      { email: "A@example.com" },
      { email: "b@example.com", displayName: "Bee", optional: true },
    ]);
    expect(result).toHaveLength(2);
    // emails are lowercased
    expect(result[0]?.email).toBe("a@example.com");
    expect(result[1]?.optional).toBe(true);
  });

  it("dedupes repeated attendee emails", () => {
    const result = normalizeCalendarAttendees([
      { email: "dup@example.com" },
      { email: "dup@example.com" },
    ]);
    expect(result).toHaveLength(1);
  });

  it("rejects a malformed attendee email", () => {
    expect(() =>
      normalizeCalendarAttendees([{ email: "not-an-email" }]),
    ).toThrow(CalendarServiceError);
  });

  it("returns an empty list when no attendees are supplied", () => {
    expect(normalizeCalendarAttendees(undefined)).toEqual([]);
  });
});

describe("resolveCalendarEventRange", () => {
  it("derives an end from a duration when only a start is given", () => {
    const range = resolveCalendarEventRange({
      now: new Date("2026-03-04T12:00:00.000Z"),
      timeZone: "UTC",
      startAt: "2026-03-04T15:00:00.000Z",
      durationMinutes: 30,
    });
    expect(range.startAt).toBe("2026-03-04T15:00:00.000Z");
    expect(range.endAt).toBe("2026-03-04T15:30:00.000Z");
  });
});

describe("mergeAggregatedCalendarFeedEvents", () => {
  it("dedupes by id, sorts by start, and backfills calendar metadata", () => {
    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: {
          accessRole: "owner",
          accountEmail: "me@example.com",
          calendarId: "primary",
          connectorAccountId: "account-1",
          grantId: "grant-1",
          provider: "google",
          side: "owner",
          summary: "Personal",
        },
        feed: {
          calendarId: "primary",
          source: "synced",
          timeMin: "2026-03-04T00:00:00.000Z",
          timeMax: "2026-03-05T00:00:00.000Z",
          syncedAt: "2026-03-04T00:00:00.000Z",
          events: [
            makeEvent({ id: "b", startAt: "2026-03-04T16:00:00.000Z" }),
            makeEvent({ id: "a", startAt: "2026-03-04T09:00:00.000Z" }),
          ],
        },
      },
      {
        calendar: {
          accessRole: "owner",
          accountEmail: "me@example.com",
          calendarId: "primary",
          connectorAccountId: "account-1",
          grantId: "grant-1",
          provider: "google",
          side: "owner",
          summary: "Personal",
        },
        feed: {
          calendarId: "primary",
          source: "synced",
          timeMin: "2026-03-04T00:00:00.000Z",
          timeMax: "2026-03-05T00:00:00.000Z",
          syncedAt: "2026-03-04T00:00:00.000Z",
          // Duplicate id "a" must be dropped.
          events: [makeEvent({ id: "a", startAt: "2026-03-04T09:00:00.000Z" })],
        },
      },
    ]);

    expect(merged.map((e) => e.id)).toEqual(["a", "b"]);
    expect(merged[0]?.grantId).toBe("grant-1");
    expect(merged[0]?.calendarSummary).toBe("Personal");
    expect(merged[0]?.accountEmail).toBe("me@example.com");
  });

  it("uses portable occurrence identity and retains the newest source revision", () => {
    const startAt = "2026-03-04T09:00:00.000Z";
    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: {
          accessRole: "reader",
          accountEmail: null,
          calendarId: "school-feed",
          connectorAccountId: "ics-source-1",
          grantId: "ics-source-1",
          provider: "ics",
          side: "owner",
          summary: "School feed",
        },
        feed: {
          calendarId: "school-feed",
          source: "synced",
          timeMin: "2026-03-04T00:00:00.000Z",
          timeMax: "2026-03-05T00:00:00.000Z",
          syncedAt: "2026-03-04T10:00:00.000Z",
          events: [
            makeEvent({
              id: "ics-copy",
              externalId: "ics-copy",
              provider: "ics",
              calendarId: "school-feed",
              connectorAccountId: "ics-source-1",
              grantId: "ics-source-1",
              startAt,
              endAt: "2026-03-04T10:00:00.000Z",
              title: "Corrected school title",
              metadata: { icsUid: "shared-event@example.test" },
              updatedAt: "2026-03-04T10:00:00.000Z",
            }),
          ],
        },
      },
      {
        calendar: {
          accessRole: "writer",
          accountEmail: "me@example.com",
          calendarId: "primary",
          connectorAccountId: "google-account-1",
          grantId: "google-grant-1",
          provider: "google",
          side: "owner",
          summary: "Personal",
        },
        feed: {
          calendarId: "primary",
          source: "synced",
          timeMin: "2026-03-04T00:00:00.000Z",
          timeMax: "2026-03-05T00:00:00.000Z",
          syncedAt: "2026-03-04T09:30:00.000Z",
          events: [
            makeEvent({
              id: "google-copy",
              externalId: "google-copy",
              startAt,
              endAt: "2026-03-04T10:00:00.000Z",
              title: "Updated school title",
              metadata: { iCalUID: "shared-event@example.test" },
              updatedAt: "2026-03-04T09:30:00.000Z",
            }),
          ],
        },
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("ics-copy");
    expect(merged[0]?.title).toBe("Corrected school title");
    expect(merged[0]?.metadata.deduplication).toEqual({
      identityVersion: "rfc5545-uid-recurrence-id-v2",
      authoritativeSource: {
        eventId: "ics-copy",
        provider: "ics",
        side: "owner",
        grantId: "ics-source-1",
        connectorAccountId: "ics-source-1",
        calendarId: "school-feed",
      },
      sources: [
        {
          eventId: "google-copy",
          provider: "google",
          side: "owner",
          grantId: "google-grant-1",
          connectorAccountId: "google-account-1",
          calendarId: "primary",
        },
        {
          eventId: "ics-copy",
          provider: "ics",
          side: "owner",
          grantId: "ics-source-1",
          connectorAccountId: "ics-source-1",
          calendarId: "school-feed",
        },
      ],
      conflictingFields: ["title"],
    });
  });

  it("keeps provider-local id collisions independent across exact sources", () => {
    const startAt = "2026-03-04T09:00:00.000Z";
    const source = (provider: "google" | "microsoft", account: string) => ({
      calendar: {
        accessRole: "owner",
        accountEmail: `${account}@example.test`,
        calendarId: "primary",
        connectorAccountId: account,
        grantId: `grant-${account}`,
        provider,
        side: "owner" as const,
        summary: provider,
      },
      feed: {
        calendarId: "primary",
        source: "synced" as const,
        timeMin: "2026-03-04T00:00:00.000Z",
        timeMax: "2026-03-05T00:00:00.000Z",
        syncedAt: "2026-03-04T10:00:00.000Z",
        events: [
          makeEvent({
            id: "provider-local-id",
            provider,
            connectorAccountId: account,
            grantId: `grant-${account}`,
            startAt,
          }),
        ],
      },
    });

    const merged = mergeAggregatedCalendarFeedEvents([
      source("google", "personal"),
      source("microsoft", "work"),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((event) => event.provider).sort()).toEqual([
      "google",
      "microsoft",
    ]);
  });

  it("normalizes equivalent timed offsets before portable deduplication", () => {
    const baseCalendar = {
      accessRole: "reader",
      accountEmail: null,
      calendarId: "primary",
      connectorAccountId: "account",
      grantId: "grant",
      provider: "google" as const,
      side: "owner" as const,
      summary: "Calendar",
    };
    const feed = {
      calendarId: "primary",
      source: "synced" as const,
      timeMin: "2026-03-04T00:00:00.000Z",
      timeMax: "2026-03-05T00:00:00.000Z",
      syncedAt: "2026-03-04T10:00:00.000Z",
    };

    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: baseCalendar,
        feed: {
          ...feed,
          events: [
            makeEvent({
              id: "offset-a",
              startAt: "2026-03-04T09:00:00-05:00",
              metadata: { iCalUID: "offset-event@example.test" },
            }),
          ],
        },
      },
      {
        calendar: {
          ...baseCalendar,
          connectorAccountId: "account-2",
          grantId: "grant-2",
        },
        feed: {
          ...feed,
          events: [
            makeEvent({
              id: "offset-b",
              startAt: "2026-03-04T14:00:00.000Z",
              metadata: { iCalUID: "offset-event@example.test" },
            }),
          ],
        },
      },
    ]);

    expect(merged).toHaveLength(1);
  });

  it("uses original recurrence identity for a moved cross-provider exception", () => {
    const originalStart = "2026-03-04T14:00:00.000Z";
    const baseCalendar = {
      accessRole: "reader",
      accountEmail: null,
      calendarId: "primary",
      connectorAccountId: "account",
      grantId: "grant",
      provider: "google" as const,
      side: "owner" as const,
      summary: "Calendar",
    };
    const feed = {
      calendarId: "primary",
      source: "synced" as const,
      timeMin: "2026-03-04T00:00:00.000Z",
      timeMax: "2026-03-05T00:00:00.000Z",
      syncedAt: "2026-03-04T10:00:00.000Z",
    };

    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: baseCalendar,
        feed: {
          ...feed,
          events: [
            makeEvent({
              id: "stale-occurrence",
              startAt: originalStart,
              metadata: {
                iCalUID: "moved-event@example.test",
                originalStartTime: originalStart,
              },
              updatedAt: "2026-03-04T09:00:00.000Z",
            }),
          ],
        },
      },
      {
        calendar: {
          ...baseCalendar,
          connectorAccountId: "account-2",
          grantId: "grant-2",
        },
        feed: {
          ...feed,
          events: [
            makeEvent({
              id: "moved-occurrence",
              startAt: "2026-03-04T16:00:00.000Z",
              metadata: {
                iCalUID: "moved-event@example.test",
                icsRecurrenceId: originalStart,
              },
              updatedAt: "2026-03-04T10:00:00.000Z",
            }),
          ],
        },
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("moved-occurrence");
    expect(
      (
        merged[0]?.metadata.deduplication as
          | { conflictingFields?: string[] }
          | undefined
      )?.conflictingFields,
    ).toContain("startAt");
  });

  it("does not collapse coincident events without a shared portable uid", () => {
    const startAt = "2026-03-04T09:00:00.000Z";
    const baseCalendar = {
      accessRole: "reader",
      accountEmail: null,
      calendarId: "primary",
      connectorAccountId: "account-1",
      grantId: "grant-1",
      provider: "google" as const,
      side: "owner" as const,
      summary: "Calendar",
    };
    const feed = {
      calendarId: "primary",
      source: "synced" as const,
      timeMin: "2026-03-04T00:00:00.000Z",
      timeMax: "2026-03-05T00:00:00.000Z",
      syncedAt: "2026-03-04T10:00:00.000Z",
    };

    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: baseCalendar,
        feed: { ...feed, events: [makeEvent({ id: "one", startAt })] },
      },
      {
        calendar: {
          ...baseCalendar,
          connectorAccountId: "account-2",
          grantId: "grant-2",
        },
        feed: { ...feed, events: [makeEvent({ id: "two", startAt })] },
      },
    ]);

    expect(merged.map((event) => event.id)).toEqual(["one", "two"]);
  });

  it("keeps separate recurring occurrences that share a series uid", () => {
    const calendar = {
      accessRole: "reader",
      accountEmail: null,
      calendarId: "primary",
      connectorAccountId: "account-1",
      grantId: "grant-1",
      provider: "google" as const,
      side: "owner" as const,
      summary: "Calendar",
    };
    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar,
        feed: {
          calendarId: "primary",
          source: "synced",
          timeMin: "2026-03-04T00:00:00.000Z",
          timeMax: "2026-03-12T00:00:00.000Z",
          syncedAt: "2026-03-04T10:00:00.000Z",
          events: [
            makeEvent({
              id: "week-1",
              startAt: "2026-03-04T09:00:00.000Z",
              metadata: { iCalUID: "weekly@example.test" },
            }),
            makeEvent({
              id: "week-2",
              startAt: "2026-03-11T09:00:00.000Z",
              metadata: { iCalUID: "weekly@example.test" },
            }),
          ],
        },
      },
    ]);

    expect(merged.map((event) => event.id)).toEqual(["week-1", "week-2"]);
  });
});

describe("buildNextCalendarEventContext", () => {
  it("summarizes the next event with attendee names and prep state", () => {
    const event = makeEvent({
      id: "next",
      startAt: "2026-03-04T15:00:00.000Z",
      endAt: "2026-03-04T16:00:00.000Z",
      title: "Board sync",
      location: "Room 4",
      attendees: [
        {
          email: "chair@example.com",
          displayName: "Chair",
          responseStatus: "accepted",
          self: false,
          organizer: true,
          optional: false,
        },
      ],
    });
    const ctx = buildNextCalendarEventContext(
      event,
      new Date("2026-03-04T14:30:00.000Z"),
    );
    expect(ctx.event?.id).toBe("next");
    expect(ctx.startsInMinutes).toBe(30);
    expect(ctx.attendeeCount).toBe(1);
    expect(ctx.location).toBe("Room 4");
  });

  it("returns an empty context when there is no next event", () => {
    const ctx = buildNextCalendarEventContext(
      null,
      new Date("2026-03-04T14:30:00.000Z"),
    );
    expect(ctx.event).toBeNull();
    expect(ctx.startsAt).toBeNull();
    expect(ctx.attendeeCount).toBe(0);
  });
});
