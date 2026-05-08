import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { embed, generateObject, generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  embed: vi.fn(),
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(() => ({
    textStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve(undefined),
  })),
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => {
    const ollama = vi.fn((model: string) => ({ model }));
    return Object.assign(ollama, {
      embedding: vi.fn((model: string) => ({ model })),
    });
  }),
}));

vi.mock("../models/availability", () => ({
  ensureModelAvailable: vi.fn(async () => undefined),
}));

function createRuntime(settings: Record<string, string> = {}) {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    fetch: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

function createTrajectoryRuntime(settings: Record<string, string> = {}) {
  const llmCalls: Record<string, unknown>[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: vi.fn((call: Record<string, unknown>) => {
      llmCalls.push(call);
    }),
  };
  const runtime = {
    ...createRuntime(settings),
    getService: vi.fn((name: string) => (name === "trajectories" ? trajectoryLogger : null)),
    getServicesByType: vi.fn((type: string) => (type === "trajectories" ? [trajectoryLogger] : [])),
  };
  return { runtime, llmCalls };
}

describe("ollama MODEL_USED events", () => {
  beforeEach(() => {
    vi.mocked(embed).mockReset();
    vi.mocked(generateObject).mockReset();
    vi.mocked(generateText).mockReset();
  });

  it("emits usage for TEXT_SMALL, TEXT_LARGE, OBJECT_SMALL, and TEXT_EMBEDDING", async () => {
    const { default: plugin } = await import("../index");
    const runtime = createRuntime({
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
      OLLAMA_SMALL_MODEL: "small-ollama",
      OLLAMA_LARGE_MODEL: "large-ollama",
      OLLAMA_EMBEDDING_MODEL: "embed-ollama",
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "small response",
        usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
      } as never)
      .mockResolvedValueOnce({
        text: "large response",
        usage: undefined,
      } as never);
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { answer: "ok" },
      usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
    } as never);
    vi.mocked(embed).mockResolvedValueOnce({
      embedding: [0.1, 0.2],
      usage: { inputTokens: 6, totalTokens: 6 },
    } as never);

    await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime as never, {
      prompt: "small prompt",
    });
    await plugin.models?.[ModelType.TEXT_LARGE]?.(runtime as never, {
      prompt: "large prompt",
    });
    await plugin.models?.[ModelType.OBJECT_SMALL]?.(runtime as never, {
      prompt: "object prompt",
    });
    await plugin.models?.[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
      text: "embed this",
    });

    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      1,
      "MODEL_USED",
      expect.objectContaining({
        source: "ollama",
        type: "TEXT_SMALL",
        model: "small-ollama",
        tokens: { prompt: 7, completion: 2, total: 9 },
      })
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      2,
      "MODEL_USED",
      expect.objectContaining({
        source: "ollama",
        type: "TEXT_LARGE",
        model: "large-ollama",
        usageEstimated: true,
        tokens: expect.objectContaining({ estimated: true }),
      })
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      3,
      "MODEL_USED",
      expect.objectContaining({
        source: "ollama",
        type: "OBJECT_SMALL",
        model: "small-ollama",
        tokens: { prompt: 5, completion: 4, total: 9 },
      })
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      4,
      "MODEL_USED",
      expect.objectContaining({
        source: "ollama",
        type: "TEXT_EMBEDDING",
        model: "embed-ollama",
        tokens: { prompt: 6, completion: 0, total: 6 },
      })
    );
  });

  it("records object generation in active trajectories", async () => {
    const { default: plugin } = await import("../index");
    const { runtime, llmCalls } = createTrajectoryRuntime({
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
      OLLAMA_SMALL_MODEL: "small-ollama",
    });

    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { ok: true },
      usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
    } as never);

    await runWithTrajectoryContext({ trajectoryStepId: "step-ollama" }, async () => {
      await plugin.models?.[ModelType.OBJECT_SMALL]?.(runtime as never, {
        prompt: "object prompt",
      });
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      stepId: "step-ollama",
      actionType: "ai.generateObject",
      response: '{"ok":true}',
      promptTokens: 5,
      completionTokens: 4,
    });
  });
});
