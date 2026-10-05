/**
 * With no planner-supplied zone, CALENDAR resolves "today" and new events in
 * the owner's calendar time zone (the resolver personal-assistant registers),
 * not the agent TIMEZONE setting or the host zone.
 */
import { registerCalendarTimeZoneResolver } from "@elizaos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "./calendar-handler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CALENDAR feed 'today' uses the owner's calendar zone", () => {
  it("reads the owner's local day, not the host's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T01:30:00.000Z"));
    const key = {
      provider: "eliza",
      side: "owner",
      grantId: "eliza-calendar",
      connectorAccountId: "eliza-calendar",
      calendarId: "primary",
    };
    const getCalendarFeed = vi.fn(
      async (_url: string, options: Record<string, unknown>) => ({
        events: [],
        state: "complete",
        source: "synced",
        syncedAt: new Date().toISOString(),
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        sources: [{ key, status: "fresh", visibility: "details", error: null }],
      }),
    );
    const service = { getCalendarFeed, listCalendars: vi.fn(async () => []) };
    const runtime = {
      reportError: vi.fn(),
      agentId: "00000000-0000-4000-8000-000000000aaa",
      getService: (name: string) => (name === "calendar" ? service : null),
      getSetting: () => undefined,
      character: { name: "Eliza" },
    };
    registerCalendarTimeZoneResolver(runtime, async () => "America/New_York");
    const action = createCalendarActionRunner({
      runJsonModel: (async () => ({ rawResponse: "{}", parsed: {} })) as never,
      runTextModel: async () => null,
      recentConversationTexts: async () => [],
    });
    const message = {
      id: "00000000-0000-4000-8000-000000000aab",
      entityId: "00000000-0000-4000-8000-000000000aac",
      roomId: "00000000-0000-4000-8000-000000000aad",
      createdAt: Date.now(),
      content: { text: "what's on my calendar today?" },
    };
    await action.handler(runtime as never, message as never, undefined, {
      parameters: { subaction: "feed" },
    } as never);
    const options = getCalendarFeed.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      timeZone: "America/New_York",
      timeMin: "2026-10-04T04:00:00.000Z",
      timeMax: "2026-10-05T04:00:00.000Z",
    });
  });
});
