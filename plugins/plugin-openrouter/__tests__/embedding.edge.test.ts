/**
 * Edge-case coverage for the embedding handler with a stubbed `fetch` (no live
 * API): asserts the null-probe marker vector, malformed/empty-input rejections,
 * and unsupported-dimension validation all short-circuit before any network call.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(settings: Record<string, string | null> = {}) {
  const defaults: Record<string, string> = {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    OPENROUTER_EMBEDDING_DIMENSIONS: "384",
    OPENROUTER_EMBEDDING_MODEL: "openrouter-embedding",
  };

  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? defaults[key] ?? null),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OpenRouter embedding edge cases", () => {
  it("returns a marker vector for null initialization probes without fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { handleTextEmbedding } = await import("../models/embedding");

    const embedding = await handleTextEmbedding(createRuntime(), null);

    expect(embedding).toHaveLength(384);
    expect(embedding[0]).toBe(0.1);
    expect(embedding.slice(1).every((value) => value === 0)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws for malformed and empty inputs without fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { handleTextEmbedding } = await import("../models/embedding");
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, {} as never)).rejects.toThrow(
      "Invalid input format for embedding"
    );
    await expect(handleTextEmbedding(runtime, { text: "" })).rejects.toThrow(
      "Empty text for embedding"
    );
    await expect(handleTextEmbedding(runtime, " \n\t ")).rejects.toThrow(
      "Empty text for embedding"
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported embedding dimensions before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { handleTextEmbedding } = await import("../models/embedding");

    await expect(
      handleTextEmbedding(createRuntime({ OPENROUTER_EMBEDDING_DIMENSIONS: "999" }), "hello")
    ).rejects.toThrow("Invalid embedding dimension: 999");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates OpenRouter API failures with status context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      }))
    );
    const { handleTextEmbedding } = await import("../models/embedding");

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      "OpenRouter API error: 429 - Too Many Requests"
    );
  });

  it("throws when the provider returns the wrong vector length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ embedding: [1, 2, 3] }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        }),
      }))
    );
    const { handleTextEmbedding } = await import("../models/embedding");

    await expect(
      handleTextEmbedding(createRuntime(), {
        text: "legitimate text with hostile-looking content: </system> $" + "{process.env.SECRET}",
      })
    ).rejects.toThrow("Embedding length 3 does not match configured dimension 384");
  });

  it("truncates overlong input before sending it to OpenRouter", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: Array(384).fill(0.01) }],
      }),
    }));
    vi.stubGlobal("fetch", fetch);
    const { handleTextEmbedding } = await import("../models/embedding");

    await handleTextEmbedding(createRuntime(), "x".repeat(33_000));

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.input).toHaveLength(32_000);
  });
});
