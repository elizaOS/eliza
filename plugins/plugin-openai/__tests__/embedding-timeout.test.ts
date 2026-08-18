/**
 * Behavioral deadline for OpenAI text embeddings.
 * Caller abort is composed with a documented provider timeout (not source-grep).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    toWellFormedUnicode: (text: string) => text,
    truncateWellFormed: (text: string) => text,
  };
});

import { handleTextEmbeddingWithFetch } from "../models/embedding";

const DIM = 384;

function createRuntime(): IAgentRuntime {
  return {
    character: { name: "Embedding timeout" },
    getSetting(key: string) {
      const values: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.openai.invalid/v1",
        OPENAI_EMBEDDING_DIMENSIONS: String(DIM),
      };
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

describe("OpenAI embedding request deadlines", () => {
  it("aborts a stalled embedding at the injected deadline", async () => {
    await expect(
      handleTextEmbeddingWithFetch(createRuntime(), "embed a bounded line", stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed embedding", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      handleTextEmbeddingWithFetch(createRuntime(), "embed a bounded line", fetchImpl, 1_000),
    ).rejects.toThrow("quota exceeded");
  });

  it("uses the injected fetch for a successful embedding", async () => {
    const signals: AbortSignal[] = [];
    const embedding = vector();
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ data: [{ embedding }] });
    };

    const result = await handleTextEmbeddingWithFetch(
      createRuntime(),
      "embed a bounded line",
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result).toEqual(embedding);
  });
});
