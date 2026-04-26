import {
  type AgentRuntime,
  EventType,
  ModelType,
  runWithTrajectoryContext,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/types.js";
import {
  estimateTokenCount,
  fitPromptToTokenBudget,
  installPromptOptimizations,
  withModelUsageCapture,
} from "./prompt-optimization.js";

type RuntimeOverrides = Partial<AgentRuntime> & {
  useModel?: AgentRuntime["useModel"];
  emitEvent?: AgentRuntime["emitEvent"];
};

function createRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const runtime = {
    agentId: stringToUuid("agent-runtime"),
    character: {
      name: "Test Agent",
      system: "System prompt",
      settings: {
        model: "test/tiny-model",
      },
    },
    actions: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(async () => undefined),
    useModel: vi.fn(async () => "ok"),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    ...overrides,
  } satisfies Partial<AgentRuntime>;

  return runtime as AgentRuntime;
}

function tinyModelConfig(): ElizaConfig {
  return {
    models: {
      providers: {
        test: {
          baseUrl: "http://localhost",
          models: [
            {
              id: "tiny-model",
              name: "Tiny Model",
              reasoning: false,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 512,
              maxTokens: 128,
            },
          ],
        },
      },
    },
  } as ElizaConfig;
}

describe("prompt optimization token budgeting", () => {
  it("truncates overflowing prompts while preserving the received message", () => {
    const prompt = [
      "# System",
      "background ".repeat(2_000),
      "# Project Context",
      "workspace ".repeat(2_000),
      "# Received Message",
      "please keep this final request",
    ].join("\n\n");

    const result = fitPromptToTokenBudget(prompt, 160);

    expect(result.truncated).toBe(true);
    expect(result.promptTokens).toBeLessThanOrEqual(160);
    expect(result.prompt).toContain("please keep this final request");
  });

  it("applies configured small context windows before calling the provider", async () => {
    const providerPayloads: Record<string, unknown>[] = [];
    const runtime = createRuntime({
      useModel: vi.fn(async (_modelType, payload) => {
        providerPayloads.push(payload as Record<string, unknown>);
        return "ok";
      }) as AgentRuntime["useModel"],
    });

    installPromptOptimizations(runtime, tinyModelConfig());

    await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: [
        "# System",
        "context ".repeat(2_000),
        "# Received Message",
        "answer this",
      ].join("\n\n"),
      maxTokens: 128,
    });

    const payload = providerPayloads[0];
    expect(payload?.maxTokens).toBe(128);
    expect(
      estimateTokenCount(String(payload?.prompt ?? "")),
    ).toBeLessThanOrEqual(Math.floor((512 - 128) * 0.95));
    expect(String(payload?.prompt ?? "")).toContain("answer this");
  });
});

describe("model usage capture", () => {
  it("records actual provider usage events", async () => {
    const runtime = createRuntime();

    const capture = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        source: "test-provider",
        provider: "test-provider",
        type: ModelType.TEXT_LARGE,
        tokens: {
          prompt: 12,
          completion: 7,
          total: 19,
        },
      });
      return "done";
    });

    expect(capture.result).toBe("done");
    expect(capture.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
      provider: "test-provider",
      isEstimated: false,
      llmCalls: 1,
    });
  });

  it("marks trajectory fallback usage as estimated when providers do not report usage", async () => {
    const llmCalls: Record<string, unknown>[] = [];
    const trajectoryLogger = {
      logLlmCall: vi.fn((call: Record<string, unknown>) => {
        llmCalls.push(call);
      }),
      logProviderAccess: vi.fn(),
      getLlmCallLogs: vi.fn(() => llmCalls),
      getProviderAccessLogs: vi.fn(() => []),
    };
    const runtime = createRuntime({
      getService: vi.fn(() => trajectoryLogger),
      getServicesByType: vi.fn(() => [trajectoryLogger]),
      useModel: vi.fn(async () => "reply") as AgentRuntime["useModel"],
    });

    installPromptOptimizations(runtime, tinyModelConfig());

    await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, () =>
      runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "hello",
        maxTokens: 128,
      }),
    );

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      tokenUsageEstimated: true,
    });
  });

  it("records provider usage in trajectory fallback calls when available", async () => {
    const llmCalls: Record<string, unknown>[] = [];
    const trajectoryLogger = {
      logLlmCall: vi.fn((call: Record<string, unknown>) => {
        llmCalls.push(call);
      }),
      logProviderAccess: vi.fn(),
      getLlmCallLogs: vi.fn(() => llmCalls),
      getProviderAccessLogs: vi.fn(() => []),
    };
    const runtime = createRuntime({
      getService: vi.fn(() => trajectoryLogger),
      getServicesByType: vi.fn(() => [trajectoryLogger]),
    });
    runtime.useModel = vi.fn(async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        source: "test-provider",
        provider: "test-provider",
        type: ModelType.TEXT_LARGE,
        tokens: {
          prompt: 21,
          completion: 9,
          total: 30,
        },
      });
      return "reply";
    }) as AgentRuntime["useModel"];

    installPromptOptimizations(runtime, tinyModelConfig());

    await runWithTrajectoryContext({ trajectoryStepId: "step-actual" }, () =>
      runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "hello",
        maxTokens: 128,
      }),
    );

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      promptTokens: 21,
      completionTokens: 9,
      tokenUsageEstimated: false,
    });
  });
});
