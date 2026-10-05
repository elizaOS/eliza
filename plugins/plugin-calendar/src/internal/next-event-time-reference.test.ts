import type {
  LifeOpsCalendarEvent,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/contracts";
import { AgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "../actions/calendar-handler.js";
import { CalendarService } from "../service/CalendarService.js";
import { buildNextCalendarEventContext } from "./calendar-normalize.js";
import { formatCalendarFeed, formatNextEventContext } from "./format.js";

function event(
  startAt: string,
  timezone = "America/Los_Angeles",
): LifeOpsCalendarEvent {
  return {
    id: "event-1",
    externalId: "event-1",
    agentId: "owner",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title: "Review",
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: new Date(Date.parse(startAt) + 3600000).toISOString(),
    isAllDay: false,
    timezone,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: startAt,
    updatedAt: startAt,
  };
}
function context(
  now: string,
  start: string,
  timeZone: string,
  eventZone = timeZone,
): LifeOpsNextCalendarEventContext {
  return {
    ...buildNextCalendarEventContext(event(start, eventZone), new Date(now)),
    timeReference: { asOf: now, timeZone },
    readScope: {
      selection: "next_event",
      timeMin: now,
      timeMax: start,
      exhaustive: false,
    },
    calendarFeedState: "complete",
    calendarSources: [],
  };
}

describe("next-event temporal evidence", () => {
  it.each([
    [
      "2026-09-26T05:28:48.434Z",
      "2026-09-26T17:00:00.000Z",
      "America/Los_Angeles",
      "tomorrow",
      "Sep 26, 10:00 AM",
    ],
    [
      "2026-09-25T14:30:00.000Z",
      "2026-09-25T16:00:00.000Z",
      "Asia/Tokyo",
      "tomorrow",
      "Sep 26, 1:00 AM",
    ],
    [
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T10:30:00.000Z",
      "America/Los_Angeles",
      "tomorrow",
      "Mar 8, 3:30 AM",
    ],
    [
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T09:30:00.000Z",
      "America/Los_Angeles",
      "tomorrow",
      "Nov 1, 1:30 AM",
    ],
    [
      "2027-01-01T07:30:00.000Z",
      "2027-01-01T17:00:00.000Z",
      "America/Los_Angeles",
      "tomorrow",
      "Jan 1, 2027, 9:00 AM",
    ],
    [
      "2026-09-26T05:00:00.000Z",
      "2026-09-26T06:00:00.000Z",
      "America/Los_Angeles",
      "today",
      "Sep 25, 11:00 PM",
    ],
    [
      "2026-09-26T08:00:00.000Z",
      "2026-09-26T06:00:00.000Z",
      "America/Los_Angeles",
      "yesterday",
      "Sep 25, 11:00 PM",
    ],
  ])("uses civil dates for %s in %s", (now, start, zone, day, absolute) => {
    const source = context(now, start, zone);
    if (!source.event) throw new Error("Missing event fixture");
    if (Date.parse(start) < Date.parse(now))
      source.event.endAt = new Date(Date.parse(now) + 3600000).toISOString();
    const before = structuredClone(source);
    const text = formatNextEventContext(source);
    expect(text).toContain(`; ${day})`);
    expect(text).toContain(absolute);
    expect(source).toEqual(before);
  });

  it("uses the requested display zone instead of the event's different zone", () => {
    const source = context(
      "2026-09-26T05:00:00.000Z",
      "2026-09-26T06:30:00.000Z",
      "America/Los_Angeles",
      "Europe/London",
    );
    expect(formatNextEventContext(source)).toContain(
      "Sep 25, 11:30 PM – Sep 26, 12:30 AM PDT; today",
    );
  });

  it("preserves the ordinary same-day text and a quoted relative-day title", () => {
    const source = context(
      "2026-09-26T06:18:42.538Z",
      "2026-09-26T17:00:00.000Z",
      "America/Los_Angeles",
    );
    if (!source.event) throw new Error("Missing event fixture");
    source.event.title = '"today" and "tomorrow"';
    source.event.endAt = "2026-09-26T17:15:00.000Z";
    expect(formatNextEventContext(source).split(" — ")[0]).toBe(
      '**Next event: "today" and "tomorrow"** (Sep 26, 10:00 AM – 10:15 AM PDT; tomorrow)',
    );
  });

  it.each([
    [
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T10:30:00.000Z",
      "Mar 7, 11:30 PM PST – Mar 8, 3:30 AM PDT",
    ],
    [
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T10:30:00.000Z",
      "Oct 31, 11:30 PM PDT – Nov 1, 2:30 AM PST",
    ],
    [
      "2027-01-01T07:30:00.000Z",
      "2027-01-01T09:00:00.000Z",
      "Dec 31, 2026, 11:30 PM – Jan 1, 2027, 1:00 AM PST",
    ],
  ])(
    "retains both civil dates across midnight for %s",
    (start, end, expected) => {
      const source = context(
        start,
        start,
        "America/Los_Angeles",
        "Europe/London",
      );
      if (!source.event) throw new Error("Missing event fixture");
      source.event.endAt = end;
      const before = structuredClone(source);
      expect(formatNextEventContext(source)).toContain(expected);
      expect(source).toEqual(before);
    },
  );

  it("renders feed ranges without a reference while preserving same-day output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T06:18:42.538Z"));
    try {
      const spanning = event("2026-11-01T06:30:00.000Z");
      spanning.endAt = "2026-11-01T10:30:00.000Z";
      const ordinary = event("2026-09-26T17:00:00.000Z");
      ordinary.endAt = "2026-09-26T17:15:00.000Z";
      const feed = {
        events: [spanning, ordinary],
      } as Parameters<typeof formatCalendarFeed>[0];
      expect(formatCalendarFeed(feed, "in range")).toBe(
        "Events in range:\n- **Review** (Oct 31, 11:30 PM PDT – Nov 1, 2:30 AM PST)\n- **Review** (Sep 26, 10:00 AM – 10:15 AM)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both offsets explicit when an event crosses a DST fold", () => {
    const source = context(
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T08:30:00.000Z",
      "America/Los_Angeles",
    );
    expect(formatNextEventContext(source)).toContain(
      "Nov 1, 1:30 AM PDT – 1:30 AM PST; tomorrow",
    );
  });

  it.each([
    undefined,
    { asOf: "invalid", timeZone: "UTC" },
    { asOf: "2026-09-26T05:00:00Z", timeZone: "invalid" },
  ])(
    "does not invent a relative date without a valid reference %j",
    (timeReference) => {
      const source = context(
        "2026-09-26T05:00:00.000Z",
        "2026-09-26T17:00:00.000Z",
        "America/Los_Angeles",
      );
      source.timeReference = timeReference;
      expect(formatNextEventContext(source)).not.toMatch(
        /; (today|tomorrow|yesterday)/,
      );
      expect(formatNextEventContext(source)).toContain("Sep 26, 10:00 AM");
    },
  );

  it("keeps all-day and distant-event formatting conservative", () => {
    const source = context(
      "2026-09-26T05:00:00.000Z",
      "2026-09-29T17:00:00.000Z",
      "America/Los_Angeles",
    );
    expect(formatNextEventContext(source)).not.toMatch(
      /; (today|tomorrow|yesterday)/,
    );
    if (!source.event) throw new Error("Missing event fixture");
    source.event.isAllDay = true;
    expect(formatNextEventContext(source)).toContain("(all day)");
    expect(formatNextEventContext(source)).not.toMatch(
      /; (today|tomorrow|yesterday)/,
    );
  });

  it.each([
    [
      "2026-09-26T06:18:42.538Z",
      "America/Los_Angeles",
      "Friday, September 25, 2026 at 11:18:42 PM PDT",
    ],
    [
      "2026-09-25T16:18:42.538Z",
      "Asia/Tokyo",
      "Saturday, September 26, 2026 at 1:18:42 AM GMT+9",
    ],
    [
      "2026-11-01T08:30:00.000Z",
      "America/Los_Angeles",
      "Sunday, November 1, 2026 at 1:30:00 AM PDT",
    ],
    [
      "2026-11-01T09:30:00.000Z",
      "America/Los_Angeles",
      "Sunday, November 1, 2026 at 1:30:00 AM PST",
    ],
    [
      "2027-01-01T07:30:00.000Z",
      "America/Los_Angeles",
      "Thursday, December 31, 2026 at 11:30:00 PM PST",
    ],
  ])(
    "projects the existing snapshot %s in requested zone %s",
    async (asOf, timeZone, display) => {
      const now = new Date(asOf);
      const next = event(
        new Date(now.getTime() + 3600000).toISOString(),
        "Europe/London",
      );
      const runtime = new AgentRuntime({
        character: { name: "Reference proof", bio: [] },
      });
      const service = new CalendarService(runtime);
      const feed = {
        calendarId: "primary",
        events: [next],
        source: "synced" as const,
        state: "complete" as const,
        sources: [],
        timeMin: asOf,
        timeMax: next.endAt,
        syncedAt: asOf,
      };
      const original = structuredClone(feed);
      const read = vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed);
      const result = await service.getNextCalendarEventContext(
        new URL("http://localhost/"),
        { timeZone },
        now,
      );
      expect(result.timeReference).toEqual({ asOf, timeZone, display });
      expect(read.mock.calls[0]?.[2]).toBe(now);
      expect(now.toISOString()).toBe(asOf);
      expect(feed).toEqual(original);
      expect(result.event).toEqual(next);
      const legacyReference = { ...result, timeReference: { asOf, timeZone } };
      expect(formatNextEventContext(result)).toBe(
        formatNextEventContext(legacyReference),
      );
    },
  );

  it("carries the exact service clock and tomorrow fact through the Calendar action without a model call", async () => {
    const now = new Date("2026-09-26T05:28:48.434Z");
    const next = event("2026-09-26T17:00:00.000Z");
    const runtime = new AgentRuntime({
      character: { name: "Temporal proof", bio: [] },
    });
    const service = new CalendarService(runtime);
    runtime.services.set(CalendarService.serviceType, [service]);
    const feed = {
      calendarId: "primary",
      events: [next],
      source: "synced" as const,
      state: "complete" as const,
      sources: [],
      timeMin: now.toISOString(),
      timeMax: "2026-10-26T07:00:00.000Z",
      syncedAt: now.toISOString(),
    };
    const original = structuredClone(feed);
    vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed);
    const projection = await service.getNextCalendarEventContext(
      new URL("http://localhost/"),
      { timeZone: "America/Los_Angeles" },
      now,
    );
    expect(projection.timeReference).toEqual({
      asOf: now.toISOString(),
      timeZone: "America/Los_Angeles",
      display: "Friday, September 25, 2026 at 10:28:48 PM PDT",
    });
    vi.spyOn(service, "getNextCalendarEventContext").mockResolvedValue(
      projection,
    );
    const model = vi.fn(async () => {
      throw new Error("Unexpected model call");
    });
    const action = createCalendarActionRunner({
      runTextModel: model,
      runJsonModel: model,
      recentConversationTexts: async () => [],
    });
    const message = {
      id: "00000000-0000-0000-0000-000000000001",
      entityId: "00000000-0000-0000-0000-000000000002",
      roomId: "00000000-0000-0000-0000-000000000003",
      agentId: runtime.agentId,
      createdAt: now.getTime(),
      content: { text: "What is my next event?" },
    } as Memory;
    const output = await action.handler(runtime, message, undefined, {
      parameters: {
        subaction: "next_event",
        details: { timeZone: "America/Los_Angeles" },
      },
    });
    if (!output || typeof output !== "object")
      throw new Error("Missing action result");
    expect(output.data?.timeReference).toEqual(projection.timeReference);
    expect(output.data?.replyContext).toMatchObject({
      scenario: "next_event",
      facts: expect.stringContaining(
        "Sep 26, 10:00 AM – 11:00 AM PDT; tomorrow",
      ),
    });
    expect(model).not.toHaveBeenCalled();
    expect(feed).toEqual(original);
  });
});
