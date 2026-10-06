import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "./calendar-handler.js";

const allDay = (id: string, date: string, next: string) => ({
  id,
  title: "Field trip",
  description: "",
  location: "",
  attendees: [],
  startAt: `${date}T00:00:00.000Z`,
  endAt: `${next}T00:00:00.000Z`,
  isAllDay: true,
  timezone: "America/New_York",
  provider: "eliza",
});

describe("calendar search all-day civil dates", () => {
  it("matches the event on the date the all-day value carries", async () => {
    const novemberFirst = allDay("trip-1", "2026-11-01", "2026-11-02");
    const novemberSecond = allDay("trip-2", "2026-11-02", "2026-11-03");
    const getCalendarFeed = vi.fn(async () => ({
      events: [novemberFirst, novemberSecond],
      state: "complete",
      source: "synced",
      syncedAt: "2026-10-31T12:00:00.000Z",
      timeMin: "2026-10-31T04:00:00.000Z",
      timeMax: "2026-11-15T05:00:00.000Z",
      sources: [],
    }));
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000aaa",
      character: { name: "Eliza" },
      getSetting: () => undefined,
      getService: (name: string) =>
        name === "calendar"
          ? { getCalendarFeed, listCalendars: vi.fn() }
          : null,
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const action = createCalendarActionRunner({
      runJsonModel: async () => ({ rawResponse: "{}", parsed: {} }),
      runTextModel: async () => null,
      recentConversationTexts: async () => [],
    });
    const result = await action.handler(
      runtime,
      {
        id: "00000000-0000-4000-8000-000000000aab",
        entityId: "00000000-0000-4000-8000-000000000aac",
        roomId: "00000000-0000-4000-8000-000000000aad",
        createdAt: Date.parse("2026-10-31T12:00:00.000Z"),
        content: {
          text: "find the field trip on November 1",
          metadata: { uiTimeZone: "America/New_York" },
        },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "search_events",
          query: "field trip November 1",
        },
      },
    );

    expect(result.data).toMatchObject({
      events: [{ id: "trip-1" }],
    });
  });
});
