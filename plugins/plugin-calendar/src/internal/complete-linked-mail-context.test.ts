/** Verifies that next-event model context preserves complete linked-mail snippets. */
import type { LifeOpsNextCalendarEventContext } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { formatNextEventContext } from "./format.ts";

describe("calendar model context integrity", () => {
  it("keeps the complete linked-mail snippet", () => {
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

    expect(snippet).toBe("a".repeat(200));
    expect(snippet).toHaveLength(200);
  });

  it("keeps complete well-formed Unicode snippets", () => {
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

    expect(snippet).toBe(`${"a".repeat(58)}🙂tail`);
    expect(snippet?.isWellFormed()).toBe(true);

    for (const grapheme of ["e\u0301", "👨‍👩‍👧‍👦"]) {
      const mail = context.linkedMail[0];
      if (!mail) throw new Error("expected linked-mail fixture");
      mail.snippet = `${"a".repeat(58)}${grapheme}tail`;
      const rendered = formatNextEventContext(context)
        .split("\n")
        .find((line) => line.startsWith('- "Agenda"'))
        ?.match(/\(([^()]*)\)$/)?.[1];

      expect(rendered).toBe(`${"a".repeat(58)}${grapheme}tail`);
      expect(rendered?.isWellFormed()).toBe(true);
    }
  });
});
