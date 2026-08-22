/**
 * Verifies Apple EventKit provenance survives normalization and prevents a
 * Google calendar surfaced through Apple Calendar from being imported twice.
 * All events are deterministic DTOs; no native store or provider is touched.
 */

import { describe, expect, it } from "vitest";
import { lifeOpsCalendarEventFromApple } from "./apple-calendar.js";
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
