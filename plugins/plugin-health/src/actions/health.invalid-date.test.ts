import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createHealthActionRunner } from "./health.js";

function buildRunner() {
  const getHealthConnectorStatus = vi.fn(async () => {
    throw new Error("health service must not be read for an invalid date");
  });
  const getHealthSummary = vi.fn(async () => {
    throw new Error("health service must not be read for an invalid date");
  });
  const getHealthDailySummary = vi.fn(async () => {
    throw new Error("health service must not be read for an invalid date");
  });
  const service = {
    getHealthConnectorStatus,
    getHealthSummary,
    getHealthTrend: vi.fn(),
    getHealthDataPoints: vi.fn(),
    getHealthDailySummary,
  };
  const runner = createHealthActionRunner({
    hasAccess: async () => true,
    createService: () => service,
    messageText: (message) =>
      typeof message.content?.text === "string" ? message.content.text : "",
    resolveTimeZone: async () => "America/Los_Angeles",
    renderReply: async ({ fallback }) => ({
      kind: "model" as const,
      text: fallback,
    }),
    recentConversationTexts: async () => [],
    runJsonModel: async () => {
      throw new Error("planner must not run for an explicit subaction");
    },
  });
  return { runner, service };
}

describe("HEALTH invalid date guard", () => {
  it("rejects an invalid date for today before reading the health service", async () => {
    const { runner, service } = buildRunner();
    const result = await runner(
      {
        reportError: vi.fn(),
        logger: { warn: vi.fn() },
      } as unknown as IAgentRuntime,
      { content: { text: "show my health for February 31" } } as Memory,
      undefined,
      { parameters: { subaction: "today", date: "2026-02-31" } },
    );

    expect(result).toMatchObject({
      success: false,
      data: { error: "INVALID_DATE" },
    });
    expect(service.getHealthConnectorStatus).not.toHaveBeenCalled();
    expect(service.getHealthSummary).not.toHaveBeenCalled();
    expect(service.getHealthDailySummary).not.toHaveBeenCalled();
  });
});
