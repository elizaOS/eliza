import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createHealthActionRunner,
  HEALTH_PARAMETERS,
  HEALTH_SIMILES,
  type HealthActionService,
} from "./health.js";

function makeRunner(service: HealthActionService) {
  return createHealthActionRunner({
    hasAccess: async () => true,
    createService: () => service,
    messageText: (message) =>
      typeof message.content.text === "string" ? message.content.text : "",
    renderReply: async ({ fallback }) => fallback,
    recentConversationTexts: async () => [],
    runJsonModel: async () => null,
  });
}

const runtime = {
  logger: { warn: vi.fn() },
} as unknown as IAgentRuntime;

const message = {
  content: { text: "health status" },
} as Memory;

describe("health action runner", () => {
  it("exports the owner health planner surface from plugin-health", () => {
    expect(HEALTH_SIMILES).toContain("FITNESS");
    expect(HEALTH_PARAMETERS.map((parameter) => parameter.name)).toEqual([
      "subaction",
      "intent",
      "metric",
      "date",
      "days",
    ]);
  });

  it("runs status through injected service and renderer adapters", async () => {
    const service = {
      getHealthConnectorStatus: vi.fn(async () => ({
        available: false,
        backend: "none" as const,
      })),
      getHealthSummary: vi.fn(async () => ({
        providers: [],
        summaries: [],
        samples: [],
        workouts: [],
        sleepEpisodes: [],
        syncedAt: "2026-05-30T12:00:00.000Z",
      })),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const runner = makeRunner(service);

    const result = await runner(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "status" } },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("No HealthKit/Google Fit bridge available");
    expect(result.data).toMatchObject({
      subaction: "status",
      status: { available: false, backend: "none" },
      healthConnectors: [],
    });
  });
});
