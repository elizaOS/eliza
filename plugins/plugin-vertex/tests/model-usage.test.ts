import { ModelType } from "@elizaos/core";
import { embed, generateObject, generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  embed: vi.fn(),
  generateObject: vi.fn(),
  generateText: vi.fn(),
  jsonSchema: vi.fn((schema: unknown) => schema),
  streamText: vi.fn(),
}));

vi.mock("../providers", () => ({
  createGoogleClient: vi.fn(() => ({
    textEmbeddingModel: vi.fn((model: string) => ({ model })),
  })),
  createModelForName: vi.fn((_runtime: unknown, model: string) => ({ model })),
  detectProvider: vi.fn((model: string) =>
    model.startsWith("gemini") ? "google" : "anthropic",
  ),
}));

function createRuntime(settings: Record<string, string> = {}) {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

describe("vertex MODEL_USED events", () => {
  beforeEach(() => {
    vi.mocked(embed).mockReset();
    vi.mocked(generateObject).mockReset();
    vi.mocked(generateText).mockReset();
  });

  it("emits usage for TEXT_SMALL, TEXT_LARGE, OBJECT_SMALL, and TEXT_EMBEDDING", async () => {
    const { default: plugin } = await import("../index");
    const runtime = createRuntime({
      VERTEX_EMBEDDING_MODEL: "vertex-embed",
      VERTEX_LARGE_MODEL: "claude-large",
      VERTEX_SMALL_MODEL: "gemini-small",
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "small response",
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      } as never)
      .mockResolvedValueOnce({
        text: "large response",
        usage: undefined,
      } as never);
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { answer: "ok" },
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
    } as never);
    vi.mocked(embed).mockResolvedValueOnce({
      embedding: [0.1, 0.2],
      usage: { inputTokens: 5, totalTokens: 5 },
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
      text: "embed prompt",
    });

    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      1,
      "MODEL_USED",
      expect.objectContaining({
        source: "vertex",
        provider: "google",
        type: "TEXT_SMALL",
        model: "gemini-small",
        tokens: { prompt: 10, completion: 3, total: 13 },
      }),
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      2,
      "MODEL_USED",
      expect.objectContaining({
        source: "vertex",
        provider: "anthropic",
        type: "TEXT_LARGE",
        model: "claude-large",
        usageEstimated: true,
        tokens: expect.objectContaining({ estimated: true }),
      }),
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      3,
      "MODEL_USED",
      expect.objectContaining({
        source: "vertex",
        type: "OBJECT_SMALL",
        model: "gemini-small",
        tokens: { prompt: 6, completion: 4, total: 10 },
      }),
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      4,
      "MODEL_USED",
      expect.objectContaining({
        source: "vertex",
        type: "TEXT_EMBEDDING",
        model: "vertex-embed",
        tokens: { prompt: 5, completion: 0, total: 5 },
      }),
    );
  });
});
