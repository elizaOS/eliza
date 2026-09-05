/**
 * Model and storage calls made by CALENDAR search_events: an explicit query
 * reads the feed with no model call and no room-transcript scan; a query-less
 * search runs the query extraction once (not twice) before the grounding and
 * disambiguation fallbacks, and scans the room transcript only for that
 * fallback. CalendarService is stubbed and the model runners are deterministic
 * nulls, so this is a call-shape contract, not live-model proof.
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
  it("reads with an explicit query without any model call or room-transcript scan", async () => {
    const { result, runTextModel, runJsonModel, recentConversationTexts } =
      await runSearch({ subaction: "search_events", query: "gym" });
    expect(result.success).toBe(true);
    expect(runJsonModel).not.toHaveBeenCalled();
    expect(runTextModel).not.toHaveBeenCalled();
    expect(recentConversationTexts).not.toHaveBeenCalled();
  });

  it("extracts a missing query once and scans the transcript only for the disambiguation fallback", async () => {
    // Live 2026-09-05: the same extraction ran twice with identical inputs and
    // every search_events read scanned the whole room transcript up front.
    const { runTextModel, runJsonModel, recentConversationTexts } =
      await runSearch({ subaction: "search_events" });
    const modelCalls =
      runJsonModel.mock.calls.length + runTextModel.mock.calls.length;
    // extraction (1) + feed grounding (1) + read-plan disambiguation (1)
    expect(modelCalls).toBe(3);
    expect(recentConversationTexts).toHaveBeenCalledTimes(1);
  });
});
