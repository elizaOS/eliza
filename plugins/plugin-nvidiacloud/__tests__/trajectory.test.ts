import type { IAgentRuntime } from "@elizaos/core";
import { runWithTrajectoryContext } from "@elizaos/core";
import { generateObject } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(),
    jsonSchema: vi.fn((schema: unknown) => ({ schema })),
  };
});

vi.mock("../src/providers/nvidia", () => ({
  createNvidiaOpenAI: () => ({
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
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn((type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    ),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        NVIDIA_SMALL_MODEL: "nvidia-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
  return { runtime, llmCalls };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("NVIDIA Cloud trajectory wrapping", () => {
  it("records object generation through recordLlmCall", async () => {
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { ok: true },
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    } as never);

    const { handleObjectSmall } = await import("../src/models/object");
    const { runtime, llmCalls } = createTrajectoryRuntime();

    await runWithTrajectoryContext(
      { trajectoryStepId: "step-nvidia" },
      async () => {
        await handleObjectSmall(runtime, { prompt: "Return JSON" });
      },
    );

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      stepId: "step-nvidia",
      actionType: "ai.generateObject",
      response: '{"ok":true}',
      promptTokens: 4,
      completionTokens: 5,
    });
  });
});
