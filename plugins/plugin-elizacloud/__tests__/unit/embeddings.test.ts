import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the Cloud API client the embeddings handlers use. requestRaw is the
// single network seam, so we drive every success/failure path through it.
const requestRaw = vi.fn();
vi.mock("../../src/utils/sdk-client", () => ({
  createCloudApiClient: () => ({ requestRaw }),
}));

// Embeddings must never emit usage on a failed batch; spy to assert that.
const emitModelUsageEvent = vi.fn();
vi.mock("../../src/utils/events", () => ({ emitModelUsageEvent }));

const { handleTextEmbedding, handleBatchTextEmbedding } = await import(
  "../../src/models/embeddings"
);

const DIM = 1536;

function makeRuntime(): IAgentRuntime {
  return {
    getSetting: (key: string) => {
      if (key === "ELIZAOS_CLOUD_EMBEDDING_MODEL") return "text-embedding-3-small";
      if (key === "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS") return "1536";
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

function embeddingResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function vec(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => (i === 0 ? seed : 0));
}

beforeEach(() => {
  requestRaw.mockReset();
  emitModelUsageEvent.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleTextEmbedding init + validation", () => {
  it("returns a correctly-sized init probe vector for null (legitimate init)", async () => {
    const result = await handleTextEmbedding(makeRuntime(), null);
    expect(result).toHaveLength(DIM);
    expect(result[0]).toBe(0.1);
    // Init must never touch the network.
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("throws on malformed params instead of returning a marker vector", async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      handleTextEmbedding(makeRuntime(), { notText: "x" } as any)
    ).rejects.toThrow(/Invalid input format/);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("throws on empty text instead of returning a marker vector", async () => {
    await expect(handleTextEmbedding(makeRuntime(), "   ")).rejects.toThrow(/empty text/);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("returns the real embedding for valid text", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.7)]));
    const result = await handleTextEmbedding(makeRuntime(), "hello world");
    expect(result).toEqual(vec(0.7));
  });
});

describe("handleBatchTextEmbedding no-marker-on-failure", () => {
  it("returns [] for an empty input array (not a marker)", async () => {
    const result = await handleBatchTextEmbedding(makeRuntime(), []);
    expect(result).toEqual([]);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("throws (no marker vectors) when a text is empty", async () => {
    await expect(handleBatchTextEmbedding(makeRuntime(), ["ok", ""])).rejects.toThrow(
      /empty text at index 1/
    );
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("returns real vectors for a successful batch and emits usage", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.1), vec(0.2)]));
    const result = await handleBatchTextEmbedding(makeRuntime(), ["a", "b"]);
    expect(result).toEqual([vec(0.1), vec(0.2)]);
    expect(emitModelUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("throws on a 401 auth failure (no marker vectors, no usage)", async () => {
    requestRaw.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /Authentication failed/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on a generic non-auth API error instead of writing markers", async () => {
    requestRaw.mockResolvedValueOnce(
      new Response("boom", { status: 500, statusText: "Server Error" })
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(/API error: 500/);
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on an invalid response structure instead of writing markers", async () => {
    requestRaw.mockResolvedValueOnce(
      new Response(JSON.stringify({ not: "data" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /invalid response structure/
    );
  });

  it("throws on a transport error instead of writing markers", async () => {
    requestRaw.mockRejectedValueOnce(new Error("network down"));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(/network down/);
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  // `retry-after: 1` keeps the backoff to ~1s (0 is falsy → handler defaults to
  // 30s), well under the bumped per-test timeout.
  it("retries once after a 429 and returns real vectors on retry success", async () => {
    requestRaw
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
      )
      .mockResolvedValueOnce(embeddingResponse([vec(0.9)]));
    const result = await handleBatchTextEmbedding(makeRuntime(), ["a"]);
    expect(result).toEqual([vec(0.9)]);
    expect(requestRaw).toHaveBeenCalledTimes(2);
  }, 10000);

  it("throws (no markers) when the post-429 retry also fails", async () => {
    requestRaw
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
      )
      .mockResolvedValueOnce(new Response("still bad", { status: 503, statusText: "Unavailable" }));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(/API error: 503/);
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  }, 10000);
});
