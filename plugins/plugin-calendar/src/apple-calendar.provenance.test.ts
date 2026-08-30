/**
 * Verifies Apple EventKit provenance survives normalization and prevents a
 * Google calendar surfaced through Apple Calendar from being imported twice.
 * All events are deterministic DTOs; no native store or provider is touched.
 */

import { describe, expect, it } from "vitest";
import {
  appleRecurrenceToRrules,
  lifeOpsCalendarEventFromApple,
} from "./apple-calendar.js";
import { mergeAggregatedCalendarFeedEvents } from "./service/CalendarService.js";

describe("Apple Calendar portable identity", () => {
  it("maps EventKit UID and occurrence identity into the unified event metadata", () => {
    const event = lifeOpsCalendarEventFromApple({
      agentId: "agent-1",
      event: {
        id: "eventkit-1",
        externalId: "eventkit-1",
        calendarId: "apple-calendar-1",
        calendarSummary: "Google through Apple",
        title: "Recurring review",
        startAt: "2026-08-24T16:00:00.000Z",
        endAt: "2026-08-24T16:30:00.000Z",
        iCalUID: "portable-uid@example.com",
        originalStartAt: "2026-08-24T16:00:00.000Z",
        sourceIdentifier: "google-source",
        sourceTitle: "Google",
        sourceType: "caldav",
        recurrenceRules: [{ frequency: "weekly", interval: 1 }],
        reminders: [{ relativeOffsetSeconds: -900 }],
      },
    });

    expect(event.metadata).toMatchObject({
      iCalUID: "portable-uid@example.com",
      originalStartTime: "2026-08-24T16:00:00.000Z",
      sourceIdentifier: "google-source",
      sourceType: "caldav",
      recurrenceRules: [{ frequency: "weekly", interval: 1 }],
      reminders: [{ relativeOffsetSeconds: -900 }],
    });
  });

  it("projects EventKit recurrence onto RRULE lines and the series identity", () => {
    const occurrence = lifeOpsCalendarEventFromApple({
      agentId: "agent-1",
      event: {
        id: "series-1",
        externalId: "series-1",
        calendarId: "apple-calendar-1",
        title: "Weekly sync",
        startAt: "2026-08-31T16:00:00.000Z",
        endAt: "2026-08-31T16:30:00.000Z",
        originalStartAt: "2026-08-31T16:00:00.000Z",
        recurrenceRules: [
          { frequency: "weekly", interval: 2, occurrenceCount: 10 },
          { frequency: "unknown", interval: 1 },
        ],
      },
    });

    expect(occurrence.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10",
    ]);
    expect(occurrence.recurringEventId).toBe("series-1");
    expect(
      appleRecurrenceToRrules([
        {
          frequency: "daily",
          interval: 1,
          endDate: "2026-09-30T00:00:00.000Z",
        },
      ]),
    ).toEqual(["RRULE:FREQ=DAILY;UNTIL=20260930T000000Z"]);
  });

  it("leaves one-off events without recurrence or series identity", () => {
    const single = lifeOpsCalendarEventFromApple({
      agentId: "agent-1",
      event: {
        id: "single-1",
        externalId: "single-1",
        calendarId: "apple-calendar-1",
        title: "Dentist",
        startAt: "2026-08-24T16:00:00.000Z",
        endAt: "2026-08-24T16:30:00.000Z",
        recurrenceRules: [],
      },
    });

    expect(single.recurrence).toBeNull();
    expect(single.recurringEventId).toBeNull();
  });

  it("keeps one authoritative event for Google-via-Apple overlap", () => {
    const apple = lifeOpsCalendarEventFromApple({
      agentId: "agent-1",
      syncedAt: "2026-08-22T08:00:00.000Z",
      event: {
        id: "eventkit-1",
        externalId: "eventkit-1",
        calendarId: "apple-calendar-1",
        calendarSummary: "Google through Apple",
        title: "Recurring review",
        startAt: "2026-08-24T16:00:00.000Z",
        endAt: "2026-08-24T16:30:00.000Z",
        iCalUID: "portable-uid@example.com",
        originalStartAt: "2026-08-24T16:00:00.000Z",
      },
    });
    const google = {
      ...apple,
      id: "google-event-1",
      externalId: "google-event-1",
      provider: "google",
      calendarId: "google-calendar-1",
      grantId: "google-grant",
      connectorAccountId: "google-account",
      updatedAt: "2026-08-22T09:00:00.000Z",
      metadata: {
        iCalUID: "portable-uid@example.com",
        originalStartTime: "2026-08-24T16:00:00.000Z",
      },
    } as const;

    const merged = mergeAggregatedCalendarFeedEvents([
      {
        calendar: {
          provider: "google",
          side: "owner",
          grantId: "google-grant",
          connectorAccountId: "google-account",
          accountEmail: "owner@example.com",
          calendarId: "google-calendar-1",
          summary: "Google",
          accessRole: "owner",
        },
        feed: { events: [google] },
      },
      {
        calendar: {
          provider: "apple_calendar",
          side: "owner",
          grantId: "apple-calendar",
          connectorAccountId: "apple-calendar",
          accountEmail: null,
          calendarId: "apple-calendar-1",
          summary: "Apple",
          accessRole: "writer",
        },
        feed: { events: [apple] },
      },
    ] as never);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.provider).toBe("google");
    expect(merged[0]?.metadata.deduplication).toMatchObject({
      authoritativeSource: { provider: "google" },
      sources: expect.arrayContaining([
        expect.objectContaining({ provider: "google" }),
        expect.objectContaining({ provider: "apple_calendar" }),
      ]),
    });
  });
});
