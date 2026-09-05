/**
 * Exercises the standalone action's real renderer over a deterministic model
 * boundary. Provider failure must not become canonical assistant prose or erase
 * the authoritative calendar snapshot. No live model claim is made here.
 */
import type {
  ActionResult,
  Content,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { calendarAction } from "../src/actions/calendar.js";

const actor = {
  id: "00000000-0000-0000-0000-000000000604",
  entityId: "00000000-0000-0000-0000-000000000602",
  roomId: "00000000-0000-0000-0000-000000000603",
  content: { text: "What is on my calendar this week?" },
} as Memory;

async function readCalendar(useModel?: IAgentRuntime["useModel"]) {
  const delivered: Content[] = [];
  const service = {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "primary",
      events: [],
      source: "synced",
      state: "complete",
      sources: [{ status: "fresh" }],
      timeMin: "2026-07-27T00:00:00.000Z",
      timeMax: "2026-08-03T00:00:00.000Z",
      syncedAt: "2026-07-27T12:00:00.000Z",
    })),
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000601",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportError: vi.fn(),
    getService: (name: string) => (name === "calendar" ? service : null),
    ...(useModel ? { useModel } : {}),
  } as unknown as IAgentRuntime;
  const result = (await calendarAction.handler(
    runtime,
    actor,
    undefined,
    {
      parameters: {
        subaction: "feed",
        details: {
          timeMin: "2026-07-27T00:00:00.000Z",
          timeMax: "2026-08-03T00:00:00.000Z",
        },
      },
    },
    async (content) => {
      delivered.push(content);
      return [];
    },
  )) as ActionResult;
  return { result, delivered, service };
}

describe("standalone calendar reply provenance", () => {
  it("delivers the model's response with the snapshot receipt", async () => {
    const useModel = vi.fn(
      async () => "Your calendar is clear in that window.",
    );
    const { result, delivered } = await readCalendar(
      useModel as unknown as IAgentRuntime["useModel"],
    );
    expect(result.success).toBe(true);
    expect(result.userFacingText).toBe(
      "Your calendar is clear in that window.",
    );
    expect(result.replyFailure).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(useModel).toHaveBeenCalledOnce();
  });

  it.each(["rate_limited", "invalid", "no_provider"] as const)(
    "preserves the read without fallback prose for %s",
    async (mode) => {
      const useModel = vi.fn(async () => {
        if (mode === "rate_limited")
          throw Object.assign(new Error("provider unavailable"), {
            statusCode: 429,
          });
        return "{}";
      });
      const { result, delivered, service } = await readCalendar(
        mode === "no_provider"
          ? undefined
          : (useModel as unknown as IAgentRuntime["useModel"]),
      );
      expect(result).toMatchObject({
        success: true,
        transcriptVisibility: "internal",
        turnComplete: false,
        replyFailure: {
          kind: mode === "invalid" ? "provider_issue" : mode,
          transient: false,
        },
        effectReceipts: [{ operation: "calendar.feed.read", outcome: "noop" }],
      });
      expect(result).not.toHaveProperty("userFacingText");
      expect(delivered).toEqual([]);
      expect(service.getCalendarFeed).toHaveBeenCalledOnce();
      expect(useModel).toHaveBeenCalledTimes(mode === "no_provider" ? 0 : 1);
    },
  );
});
