/**
 * Calendar reads and creates default to the agent's configured TIMEZONE when
 * the planner supplies no zone, and to the host zone when none is configured.
 * CalendarService is stubbed and the feed request it receives is inspected;
 * no model, no database.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";
import { resolveDefaultTimeZone } from "../src/internal/constants.js";

function stubService() {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: [],
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-09-01T00:00:00.000Z",
      timeMax: "2026-09-30T00:00:00.000Z",
      syncedAt: null,
    })),
  };
}

function fakeRuntime(
  service: ReturnType<typeof stubService>,
  settings: Record<string, string>,
): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getSetting: (key: string) => settings[key],
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

const deps: CalendarActionDeps = {
  runTextModel: async () => null,
  runJsonModel: async () => null,
  recentConversationTexts: async () => [],
};

async function feedRequestTimeZone(settings: Record<string, string>) {
  const service = stubService();
  const action = createCalendarActionRunner(deps);
  await action.handler(
    fakeRuntime(service, settings),
    {
      id: "00000000-0000-0000-0000-000000000101",
      entityId: "00000000-0000-0000-0000-000000000102",
      roomId: "00000000-0000-0000-0000-000000000103",
      content: { text: "whats on my calendar tuesday?" },
    } as unknown as Memory,
    undefined,
    { parameters: { subaction: "search_events", query: "gym" } },
    vi.fn(async () => []),
  );
  expect(service.getCalendarFeed).toHaveBeenCalled();
  const [, request] = service.getCalendarFeed.mock.calls[0] as unknown as [
    URL,
    { timeZone?: string },
  ];
  return request.timeZone;
}

describe("calendar configured timezone", () => {
  it("uses the agent's TIMEZONE setting when the planner supplies no zone", async () => {
    // Live 2026-09-05: host UTC, agent configured for Pacific time; "tuesday at
    // 7am" was resolved in UTC.
    expect(await feedRequestTimeZone({ TIMEZONE: "America/Los_Angeles" })).toBe(
      "America/Los_Angeles",
    );
  });

  it("falls back to the host zone when TIMEZONE is unset or invalid", async () => {
    expect(await feedRequestTimeZone({})).toBe(resolveDefaultTimeZone());
    expect(await feedRequestTimeZone({ TIMEZONE: "Mars/Olympus" })).toBe(
      resolveDefaultTimeZone(),
    );
  });
});

describe("calendar action explicit read windows", () => {
  it.each([
    [
      "UTC",
      "2026-09-16T00:00:00",
      "2026-09-17T00:00:00",
      "2026-09-16T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z",
    ],
    [
      "Asia/Tokyo",
      "2026-09-16T00:00:00",
      "2026-09-17T00:00:00",
      "2026-09-15T15:00:00.000Z",
      "2026-09-16T15:00:00.000Z",
    ],
    [
      "America/New_York",
      "2026-03-08T00:00:00",
      "2026-03-09T00:00:00",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
    ],
    [
      "America/New_York",
      "2026-11-01T00:00:00",
      "2026-11-02T00:00:00",
      "2026-11-01T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    ],
    [
      "Asia/Tokyo",
      "2026-09-16T00:00:00Z",
      "2026-09-17T00:00:00Z",
      "2026-09-16T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z",
    ],
  ])(
    "passes the correct window to the service in %s",
    async (timeZone, timeMin, timeMax, expectedMin, expectedMax) => {
      for (const explicitZone of [true, false]) {
        const service = stubService();
        const action = createCalendarActionRunner(deps);
        const result = await action.handler(
          fakeRuntime(service, {
            TIMEZONE: explicitZone ? "Pacific/Honolulu" : timeZone,
          }),
          {
            content: {
              text: "Read this calendar window without changing anything.",
            },
          } as Memory,
          undefined,
          {
            parameters: {
              subaction: "feed",
              details: {
                timeMin,
                timeMax,
                ...(explicitZone ? { timeZone } : {}),
              },
            },
          },
          vi.fn(async () => []),
        );
        expect(result?.success).toBe(true);
        expect(service.getCalendarFeed).toHaveBeenCalledWith(
          expect.any(URL),
          expect.objectContaining({
            timeZone,
            timeMin: expectedMin,
            timeMax: expectedMax,
          }),
        );
      }
    },
  );
});

describe("calendar extracted read windows", () => {
  it.each([
    [
      "2026-09-16T00:00:00",
      "2026-09-17T00:00:00",
      "2026-09-15T15:00:00.000Z",
      "2026-09-16T15:00:00.000Z",
    ],
    [
      "2026-09-16T00:00:00Z",
      "2026-09-17T00:00:00Z",
      "2026-09-16T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z",
    ],
    [
      "2026-09-16T00:00:00Z",
      "2026-09-16T23:59:59Z",
      "2026-09-16T00:00:00.000Z",
      "2026-09-16T23:59:59.000Z",
    ],
  ])(
    "preserves the extracted bound semantics for %s",
    async (timeMin, timeMax, expectedMin, expectedMax) => {
      const service = stubService();
      const plan = {
        subaction: "feed",
        shouldAct: true,
        queries: [],
        timeMin,
        timeMax,
      };
      const modelDeps: CalendarActionDeps = {
        ...deps,
        runJsonModel: async () => ({
          rawResponse: JSON.stringify(plan),
          parsed: null,
        }),
        runTextModel: async () => JSON.stringify(plan),
      };
      const action = createCalendarActionRunner(modelDeps);
      const result = await action.handler(
        fakeRuntime(service, { TIMEZONE: "Asia/Tokyo" }),
        {
          content: {
            text: "Show my calendar events for the requested window.",
          },
        } as Memory,
        undefined,
        undefined,
        vi.fn(async () => []),
      );
      expect(result?.success).toBe(true);
      expect(service.getCalendarFeed).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          timeZone: "Asia/Tokyo",
          timeMin: expectedMin,
          timeMax: expectedMax,
        }),
      );
    },
  );
});
