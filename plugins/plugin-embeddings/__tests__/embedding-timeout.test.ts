/**
 * Behavioral deadline for plugin-embeddings when the caller omits signal.
 * Not a source-grep test: runs timeout, provider-error, and success paths.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleTextEmbeddingWithFetch } from "../src/models/embedding";

const DIM = 384;

function createRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const values: Record<string, string> = {
    EMBEDDING_BASE_URL: "https://embeddings.invalid/v1",
    EMBEDDING_API_KEY: "test-key",
    EMBEDDING_DIMENSIONS: String(DIM),
    ...settings,
  };
  return {
    character: { name: "Embeddings timeout" },
    emitEvent: vi.fn(async () => undefined),
    getSetting(key: string) {
      return values[key];
    },
  } as unknown as IAgentRuntime;
}

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected embedding abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

function vector(): number[] {
  return Array.from({ length: DIM }, (_, i) => (i === 0 ? 0.1 : 0));
}

describe("plugin-embeddings request deadlines", () => {
  it("aborts a stalled embedding at the injected deadline", async () => {
    await expect(
      handleTextEmbeddingWithFetch(createRuntime(), "embed a bounded line", stallUntilAborted(), 10)
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed embedding", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      handleTextEmbeddingWithFetch(createRuntime(), "embed a bounded line", fetchImpl, 1_000)
    ).rejects.toThrow("quota exceeded");
  });

  it("uses the injected fetch for a successful embedding", async () => {
    const signals: AbortSignal[] = [];
    const embedding = vector();
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        data: [{ embedding, index: 0 }],
      });
    };

    const result = await handleTextEmbeddingWithFetch(
      createRuntime(),
      "embed a bounded line",
      fetchImpl,
      1_000
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result).toEqual(embedding);
  });
});
