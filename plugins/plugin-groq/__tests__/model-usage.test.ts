import { generateObject, generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/groq", () => ({
  createGroq: vi.fn(() => ({
    languageModel: vi.fn((model: string) => ({ model })),
  })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(),
    generateText: vi.fn(),
  };
});

function createRuntime(settings: Record<string, string> = {}) {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

describe("groq MODEL_USED events", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    vi.mocked(generateObject).mockReset();
  });

  it("emits actual token usage for TEXT_SMALL and TEXT_LARGE", async () => {
    const { default: plugin } = await import("../index");
    const runtime = createRuntime({
      GROQ_API_KEY: "gsk_test",
      GROQ_SMALL_MODEL: "small-model",
      GROQ_LARGE_MODEL: "large-model",
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "small response",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      } as never)
      .mockResolvedValueOnce({
        text: "large response",
        usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
      } as never);

    await plugin.models?.TEXT_SMALL?.(runtime as never, { prompt: "small prompt" });
    await plugin.models?.TEXT_LARGE?.(runtime as never, { prompt: "large prompt" });

    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      1,
      "MODEL_USED",
      expect.objectContaining({
        source: "groq",
        provider: "groq",
        type: "TEXT_SMALL",
        model: "small-model",
        tokens: { prompt: 8, completion: 3, total: 11 },
      }),
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      2,
      "MODEL_USED",
      expect.objectContaining({
        source: "groq",
        provider: "groq",
        type: "TEXT_LARGE",
        model: "large-model",
        tokens: { prompt: 13, completion: 5, total: 18 },
      }),
    );
  });

  it("emits estimated object usage with the object model type", async () => {
    const { default: plugin } = await import("../index");
    const runtime = createRuntime({
      GROQ_API_KEY: "gsk_test",
      GROQ_SMALL_MODEL: "small-model",
    });

    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { answer: "ok" },
      usage: undefined,
    } as never);

    await plugin.models?.OBJECT_SMALL?.(runtime as never, {
      prompt: "return a small object",
    });

    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "MODEL_USED",
      expect.objectContaining({
        source: "groq",
        type: "OBJECT_SMALL",
        model: "small-model",
        usageEstimated: true,
        tokens: expect.objectContaining({
          estimated: true,
        }),
      }),
    );
  });
});
