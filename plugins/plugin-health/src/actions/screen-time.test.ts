import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createScreenTimeActionRunner,
  SCREEN_TIME_PARAMETERS,
  SCREEN_TIME_SIMILES,
  type ScreenTimeActionService,
} from "./screen-time.js";

const runtime = {
  agentId: "agent-screen-time",
  logger: { debug: vi.fn() },
} as unknown as IAgentRuntime;

const message = {
  content: { text: "screen time today" },
} as Memory;

function makeService(): ScreenTimeActionService {
  return {
    getScreenTimeDaily: vi.fn(async () => [
      {
        id: "daily-1",
        agentId: "agent-screen-time",
        source: "app",
        identifier: "com.example.Editor",
        date: "2026-05-30",
        totalSeconds: 3600,
        sessionCount: 2,
        metadata: {},
        createdAt: "2026-05-30T12:00:00.000Z",
        updatedAt: "2026-05-30T12:00:00.000Z",
      },
    ]),
    getScreenTimeSummary: vi.fn(async () => ({
      items: [],
      totalSeconds: 0,
    })),
    getScreenTimeWeeklyAverageByApp: vi.fn(async () => ({
      daysInWindow: 7,
      totalSeconds: 0,
      items: [],
    })),
  };
}

function makeRunner(service: ScreenTimeActionService) {
  return createScreenTimeActionRunner({
    hasAccess: async () => true,
    createService: () => service,
    messageText: (input) =>
      typeof input.content.text === "string" ? input.content.text : "",
    renderReply: async ({ fallback }) => fallback,
    resolveActionArgs: async () => ({
      ok: true,
      subaction: "today",
      params: { date: "2026-05-30" },
    }),
    isDarwin: () => false,
    getActivityReport: vi.fn(),
    getTimeOnApp: vi.fn(),
    getBrowserDomainActivity: vi.fn(),
    getBrowserActivitySnapshot: vi.fn(),
  });
}

describe("screen-time action runner", () => {
  it("exports the owner screen-time planner surface from plugin-health", () => {
    expect(SCREEN_TIME_SIMILES).toContain("TIME_ON_SITE");
    expect(SCREEN_TIME_PARAMETERS.map((parameter) => parameter.name)).toContain(
      "windowHours",
    );
  });

  it("runs daily screen-time through injected service and renderer adapters", async () => {
    const service = makeService();
    const runner = makeRunner(service);

    const result = await runner(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "today", date: "2026-05-30" } },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Screen time for 2026-05-30");
    expect(result.data).toMatchObject({
      subaction: "today",
      date: "2026-05-30",
    });
    expect(service.getScreenTimeDaily).toHaveBeenCalledWith({
      date: "2026-05-30",
      source: undefined,
      identifier: undefined,
      limit: 10,
    });
  });
});
