/**
 * OWNER_HEALTH's time-zone wiring: the runner must read "today" through the
 * shared fail-closed calendar zone owner that this plugin registers, so an
 * invalid or unreadable owner zone fails visibly instead of answering for the
 * host's day. Access, the LifeOps service, and reply rendering are
 * deterministic stubs; zone resolution is the real core resolver.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  CALENDAR_TIME_ZONE_UNAVAILABLE,
  registerCalendarTimeZoneResolver,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHealthDailySummary: vi.fn(async (date: string) => ({
    date,
    provider: "healthkit",
    steps: 0,
    activeMinutes: 0,
    sleepHours: 0,
  })),
}));

vi.mock("../src/lifeops/access.js", () => ({
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("../src/lifeops/service.js", () => ({
  LifeOpsService: class {
    getHealthConnectorStatus = vi.fn(async () => ({
      available: true,
      backend: "healthkit",
    }));
    getHealthSummary = vi.fn(async () => ({
      providers: [],
      summaries: [],
      samples: [],
      workouts: [],
      sleepEpisodes: [],
      syncedAt: "2026-10-02T20:00:00.000Z",
    }));
    getHealthTrend = vi.fn();
    getHealthDataPoints = vi.fn();
    getHealthDailySummary = mocks.getHealthDailySummary;
  },
}));

vi.mock("../src/lifeops/voice/grounded-reply.js", () => ({
  messageText: (message: Memory) =>
    typeof message.content.text === "string" ? message.content.text : "",
  renderLifeOpsActionReply: async ({ fallback }: { fallback: string }) => ({
    kind: "model",
    text: fallback,
  }),
}));

import { runHealthHandler } from "../src/actions/health.js";

function ownerRuntime(resolve: () => Promise<string | null>): IAgentRuntime {
  const runtime = {
    agentId: "agent-health-zone-test",
    getSetting: () => undefined,
    reportError: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  registerCalendarTimeZoneResolver(runtime, resolve);
  return runtime;
}

const message = { content: { text: "how did I sleep today" } } as Memory;

describe("OWNER_HEALTH time zone", () => {
  it("summarizes the owner's local day in the owner's zone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-02T20:00:00.000Z") });
    try {
      mocks.getHealthDailySummary.mockClear();
      const result = await runHealthHandler(
        ownerRuntime(async () => "Asia/Tokyo"),
        message,
        undefined,
        { parameters: { subaction: "today" } },
      );
      expect(result.success).toBe(true);
      // 05:00 on Oct 3 in Tokyo while the UTC day is still Oct 2.
      expect(mocks.getHealthDailySummary).toHaveBeenCalledWith("2026-10-03", {
        timeZone: "Asia/Tokyo",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails visibly when the owner's zone cannot be read", async () => {
    mocks.getHealthDailySummary.mockClear();
    const result = await runHealthHandler(
      ownerRuntime(async () => {
        throw new Error("fact store unavailable");
      }),
      message,
      undefined,
      { parameters: { subaction: "today" } },
    );
    expect(result).toMatchObject({
      success: false,
      data: { error: CALENDAR_TIME_ZONE_UNAVAILABLE },
    });
    expect(mocks.getHealthDailySummary).not.toHaveBeenCalled();
  });
});
