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
          accountEmail: "me@example.com",
          calendarId: "primary",
          grantId: "grant-1",
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
          accountEmail: "me@example.com",
          calendarId: "primary",
          grantId: "grant-1",
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
