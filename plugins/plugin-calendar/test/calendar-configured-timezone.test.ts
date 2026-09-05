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
