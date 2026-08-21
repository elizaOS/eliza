/**
 * Exercises calendar preview truncation through the exported next-event
 * formatter so the configured 60-character contract includes its ellipsis.
 */
import type { LifeOpsNextCalendarEventContext } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { formatNextEventContext } from "./format.ts";

describe("calendar preview truncation", () => {
  it("keeps the linked-mail snippet and marker within 60 characters", () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const context: LifeOpsNextCalendarEventContext = {
      event: {
        id: "event-1",
        externalId: "external-1",
        agentId: "agent-1",
        provider: "google",
        side: "personal",
        calendarId: "calendar-1",
        title: "Review",
        description: "",
        location: "",
        status: "confirmed",
        startAt: now.toISOString(),
        endAt: new Date(now.getTime() + 3_600_000).toISOString(),
        isAllDay: false,
        timezone: "UTC",
        htmlLink: null,
        conferenceLink: null,
        organizer: null,
        attendees: [],
        metadata: {},
        syncedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      calendarFeedState: "complete",
      calendarSources: [],
      startsAt: now.toISOString(),
      startsInMinutes: 60,
      attendeeCount: 0,
      attendeeNames: [],
      location: null,
      conferenceLink: null,
      preparationChecklist: [],
      linkedMailState: "cache",
      linkedMailError: null,
      linkedMail: [
        {
          id: "mail-1",
          subject: "Agenda",
          from: "sender",
          receivedAt: now.toISOString(),
          snippet: "a".repeat(200),
          htmlLink: null,
        },
      ],
    };

    const relatedLine = formatNextEventContext(context)
      .split("\n")
      .find((line) => line.startsWith('- "Agenda"'));
    const snippet = relatedLine?.match(/\(([^()]*)\)$/)?.[1];

    expect(snippet).toBe(`${"a".repeat(59)}…`);
    expect(snippet).toHaveLength(60);
  });

  it("does not split a surrogate pair at the preview boundary", () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const context: LifeOpsNextCalendarEventContext = {
      event: {
        id: "event-1",
        externalId: "external-1",
        agentId: "agent-1",
        provider: "google",
        side: "personal",
        calendarId: "calendar-1",
        title: "Review",
        description: "",
        location: "",
        status: "confirmed",
        startAt: now.toISOString(),
        endAt: new Date(now.getTime() + 3_600_000).toISOString(),
        isAllDay: false,
        timezone: "UTC",
        htmlLink: null,
        conferenceLink: null,
        organizer: null,
        attendees: [],
        metadata: {},
        syncedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      calendarFeedState: "complete",
      calendarSources: [],
      startsAt: now.toISOString(),
      startsInMinutes: 60,
      attendeeCount: 0,
      attendeeNames: [],
      location: null,
      conferenceLink: null,
      preparationChecklist: [],
      linkedMailState: "cache",
      linkedMailError: null,
      linkedMail: [
        {
          id: "mail-1",
          subject: "Agenda",
          from: "sender",
          receivedAt: now.toISOString(),
          snippet: `${"a".repeat(58)}🙂tail`,
          htmlLink: null,
        },
      ],
    };

    const relatedLine = formatNextEventContext(context)
      .split("\n")
      .find((line) => line.startsWith('- "Agenda"'));
    const snippet = relatedLine?.match(/\(([^()]*)\)$/)?.[1];

    expect(snippet).toBe(`${"a".repeat(58)}…`);
    expect(snippet?.isWellFormed()).toBe(true);
    expect(snippet?.length).toBeLessThanOrEqual(60);

    for (const grapheme of ["e\u0301", "👨‍👩‍👧‍👦"]) {
      const mail = context.linkedMail[0];
      if (!mail) throw new Error("expected linked-mail fixture");
      mail.snippet = `${"a".repeat(58)}${grapheme}tail`;
      const bounded = formatNextEventContext(context)
        .split("\n")
        .find((line) => line.startsWith('- "Agenda"'))
        ?.match(/\(([^()]*)\)$/)?.[1];

      expect(bounded).toBe(`${"a".repeat(58)}…`);
      expect(bounded?.isWellFormed()).toBe(true);
      expect(bounded?.length).toBeLessThanOrEqual(60);
    }
  });
});
