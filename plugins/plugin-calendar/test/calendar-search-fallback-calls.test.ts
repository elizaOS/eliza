/**
 * Checks typed Calendar search routing through the real action runner with
 * a controlled feed and model ports. Valid filters read without inference;
 * missing filters return a repairable error before any feed or model call.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

const EVENT: LifeOpsCalendarEvent = {
  id: "agent-1:eliza:owner:calendar:primary:evt-1",
  externalId: "evt-1",
  agentId: "agent-1",
  provider: "eliza",
  side: "owner",
  calendarId: "primary",
  title: "Gym session",
  description: "",
  location: "",
  status: "confirmed",
  startAt: "2026-09-08T14:00:00.000Z",
  endAt: "2026-09-08T15:00:00.000Z",
  isAllDay: false,
  timezone: "UTC",
  htmlLink: null,
  conferenceLink: null,
  organizer: null,
  attendees: [],
  metadata: {},
  syncedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  grantId: "eliza-calendar",
};

function stubService() {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: [EVENT],
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-09-01T00:00:00.000Z",
      timeMax: "2026-09-30T00:00:00.000Z",
      syncedAt: null,
    })),
  };
}

function fakeRuntime(service: ReturnType<typeof stubService>): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    reportError: () => undefined,
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    entityId: "00000000-0000-0000-0000-000000000102",
    roomId: "00000000-0000-0000-0000-000000000103",
    content: { text },
  } as unknown as Memory;
}

function spiedDeps() {
  const runTextModel = vi.fn(async () => null);
  const runJsonModel = vi.fn(async () => null);
  const recentConversationTexts = vi.fn(async () => [
    "whats on my calendar tuesday?",
  ]);
  const deps: CalendarActionDeps = {
    runTextModel,
    runJsonModel,
    recentConversationTexts,
  };
  return { deps, runTextModel, runJsonModel, recentConversationTexts };
}

async function runSearch(parameters: Record<string, unknown>) {
  const service = stubService();
  const spies = spiedDeps();
  const action = createCalendarActionRunner(spies.deps);
  const result = await action.handler(
    fakeRuntime(service),
    message("whats on my calendar tuesday?"),
    undefined,
    { parameters },
    vi.fn(async () => []),
  );
  if (!result) throw new Error("Expected a Calendar action result");
  return { result, ...spies, service };
}

describe("CALENDAR search_events call shape", () => {
  it.each([
    { query: "gym" },
    { queries: ["gym"] },
    { details: { query: "gym" } },
    { details: { queries: ["gym"] } },
  ])(
    "reads with a supported query alias without inference: %j",
    async (parameters) => {
      const { result, runTextModel, runJsonModel, recentConversationTexts } =
        await runSearch({ subaction: "search_events", ...parameters });
      expect(result.success).toBe(true);
      expect(runJsonModel).not.toHaveBeenCalled();
      expect(runTextModel).not.toHaveBeenCalled();
      expect(recentConversationTexts).not.toHaveBeenCalled();
    },
  );

  it("reads an unfiltered date range through feed without query extraction", async () => {
    const {
      result,
      runTextModel,
      runJsonModel,
      recentConversationTexts,
      service,
    } = await runSearch({
      subaction: "feed",
      details: {
        timeMin: "2026-09-16T00:00:00",
        timeMax: "2026-09-17T00:00:00",
        timeZone: "UTC",
      },
    });
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    expect(runJsonModel).not.toHaveBeenCalled();
    expect(runTextModel).not.toHaveBeenCalled();
    expect(recentConversationTexts).not.toHaveBeenCalled();
  });

  it.each([undefined, "event", "events", "calendar"])(
    "rejects a typed search without a content filter before inference or reading: %s",
    async (query) => {
      const {
        result,
        runTextModel,
        runJsonModel,
        recentConversationTexts,
        service,
      } = await runSearch({
        subaction: "search_events",
        query,
        details: {
          timeMin: "2026-09-16T00:00:00",
          timeMax: "2026-09-17T00:00:00",
          timeZone: "UTC",
        },
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "CALENDAR_SEARCH_QUERY_REQUIRED",
      );
      expect(JSON.stringify(result)).toContain("feed");
      expect(runJsonModel).not.toHaveBeenCalled();
      expect(runTextModel).not.toHaveBeenCalled();
      expect(recentConversationTexts).not.toHaveBeenCalled();
      expect(service.getCalendarFeed).not.toHaveBeenCalled();
    },
  );
});
