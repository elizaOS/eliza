import { AgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CalendarService } from "../service/CalendarService.ts";
import { createCalendarActionRunner } from "./calendar-handler.ts";

describe("Calendar explicit date grounding through real handler", () => {
  it.each([
    {
      request: "What’s on my calendar from today through November 1?",
      date: "2026-10-26",
      endDate: "2026-11-01",
      start: "2026-10-26T07:00:00.000Z",
      end: "2026-11-02T08:00:00.000Z",
      label:
        "from Monday, October 26, 2026 through Sunday, November 1, 2026, inclusive (America/Los_Angeles)",
    },
    {
      request: "What’s on my calendar on November 1, 2026?",
      date: "2026-11-01",
      endDate: "2026-11-01",
      start: "2026-11-01T07:00:00.000Z",
      end: "2026-11-02T08:00:00.000Z",
      label: "on Sunday, November 1, 2026 (America/Los_Angeles)",
    },
    {
      request: "Show my calendar from October 26, 2026 to November 1, 2026.",
      date: "2026-10-26",
      endDate: "2026-11-01",
      start: "2026-10-26T07:00:00.000Z",
      end: "2026-11-02T08:00:00.000Z",
      label:
        "from Monday, October 26, 2026 through Sunday, November 1, 2026, inclusive (America/Los_Angeles)",
    },
    {
      request: "Show my calendar between today and November 1.",
      date: "2026-10-26",
      endDate: "2026-11-01",
      start: "2026-10-26T07:00:00.000Z",
      end: "2026-11-02T08:00:00.000Z",
      label:
        "from Monday, October 26, 2026 through Sunday, November 1, 2026, inclusive (America/Los_Angeles)",
    },
  ])(
    "keeps civil weekdays and end-exclusive bounds for $request",
    async ({ request, date, endDate, start, end, label }) => {
      const runtime = new AgentRuntime({
        character: { name: "Calendar date grounding", bio: [] },
      });
      const service = new CalendarService(runtime);
      runtime.services.set(CalendarService.serviceType, [service]);
      const feed = {
        calendarId: "primary",
        events: [],
        source: "synced" as const,
        state: "complete" as const,
        sources: [],
        timeMin: start,
        timeMax: end,
        syncedAt: "2026-10-26T19:00:00.000Z",
      };
      const original = structuredClone(feed);
      const read = vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed);
      const unexpectedModel = vi.fn(async () => {
        throw Error("Typed date read must not call a model");
      });
      const action = createCalendarActionRunner({
        runTextModel: unexpectedModel,
        runJsonModel: unexpectedModel,
        recentConversationTexts: async () => [],
      });
      const message = {
        id: "00000000-0000-0000-0000-000000000001",
        entityId: "00000000-0000-0000-0000-000000000002",
        roomId: "00000000-0000-0000-0000-000000000003",
        agentId: runtime.agentId,
        createdAt: new Date("2026-10-26T19:00:00Z").getTime(),
        content: { text: request },
      } as Memory;
      const result = await action.handler(runtime, message, undefined, {
        parameters: {
          subaction: "feed",
          details: { date, endDate, timeZone: "America/Los_Angeles" },
        },
      });
      expect(result).toMatchObject({
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        data: {
          replyContext: {
            scenario: "feed_results",
            facts: `No events ${label}.`,
            userFacingFacts: `No events ${label}.`,
            context: { label },
          },
        },
      });
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]?.[1]).toMatchObject({
        timeMin: start,
        timeMax: end,
        timeZone: "America/Los_Angeles",
      });
      expect(
        result && typeof result === "object" && result.effectReceipts?.[0],
      ).toMatchObject({ operation: "calendar.feed.read", outcome: "noop" });
      expect(result).not.toHaveProperty("userFacingText");
      expect(unexpectedModel).not.toHaveBeenCalled();
      expect(feed).toEqual(original);
    },
  );
  it("still refuses a range whose start conflicts with the single requested day", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Calendar date authority", bio: [] },
    });
    const service = new CalendarService(runtime);
    runtime.services.set(CalendarService.serviceType, [service]);
    const read = vi.spyOn(service, "getCalendarFeed");
    const unexpectedModel = vi.fn(async () => {
      throw Error("Typed date read must not call a model");
    });
    const action = createCalendarActionRunner({
      runTextModel: unexpectedModel,
      runJsonModel: unexpectedModel,
      recentConversationTexts: async () => [],
    });
    const message = {
      id: "00000000-0000-0000-0000-000000000011",
      entityId: "00000000-0000-0000-0000-000000000002",
      roomId: "00000000-0000-0000-0000-000000000003",
      agentId: runtime.agentId,
      createdAt: new Date("2026-10-26T19:00:00Z").getTime(),
      content: { text: "What's on my calendar tomorrow?" },
    } as Memory;
    const result = await action.handler(runtime, message, undefined, {
      parameters: {
        subaction: "feed",
        details: {
          date: "2026-10-26",
          endDate: "2026-11-01",
          timeZone: "America/Los_Angeles",
        },
      },
    });
    expect(result).toMatchObject({
      success: false,
      data: { error: "CALENDAR_READ_DATE_CONFLICT" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(unexpectedModel).not.toHaveBeenCalled();
  });
});
