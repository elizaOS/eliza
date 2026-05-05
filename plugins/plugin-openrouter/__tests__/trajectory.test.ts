import type { IAgentRuntime } from "@elizaos/core";
import { runWithTrajectoryContext } from "@elizaos/core";
import { generateObject } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  jsonSchema: vi.fn((schema: unknown) => ({ schema })),
}));

vi.mock("../providers", () => ({
  createOpenRouterProvider: () => ({
    chat: (modelName: string) => ({ modelName }),
  }),
}));

function createTrajectoryRuntime() {
  const llmCalls: Record<string, unknown>[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: vi.fn((call: Record<string, unknown>) => {
      llmCalls.push(call);
    }),
  };
  const runtime = {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getService: vi.fn((name: string) => (name === "trajectories" ? trajectoryLogger : null)),
    getServicesByType: vi.fn((type: string) => (type === "trajectories" ? [trajectoryLogger] : [])),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENROUTER_SMALL_MODEL: "openrouter-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
  return { runtime, llmCalls };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter trajectory wrapping", () => {
  it("records object generation through recordLlmCall", async () => {
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { ok: true },
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    } as never);

    const { handleObjectSmall } = await import("../models/object");
    const { runtime, llmCalls } = createTrajectoryRuntime();

    await runWithTrajectoryContext({ trajectoryStepId: "step-openrouter" }, async () => {
      await handleObjectSmall(runtime, { prompt: "Return JSON" });
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      stepId: "step-openrouter",
      actionType: "ai.generateObject",
      response: '{"ok":true}',
      promptTokens: 4,
      completionTokens: 5,
    });
  });
});
