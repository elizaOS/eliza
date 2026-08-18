import {
  CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
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

const { handleTextEmbedding, handleBatchTextEmbedding, embeddingBackoffMs, EMBED_BACKOFF_CAP_MS } =
  await import("../../src/models/embeddings");

const DIM = 384;

function makeRuntime(dimension = DIM): IAgentRuntime {
  return {
    getSetting: (key: string) => {
      if (key === "ELIZAOS_CLOUD_EMBEDDING_MODEL") return "BAAI/bge-small-en-v1.5";
      if (key === "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS") return String(dimension);
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

function embeddingResponse(
  vectors: number[][],
  model: string | null = "BAAI/bge-small-en-v1.5",
  attestation: Record<string, unknown> = {
    pooling: "cls",
    embedding_space_fingerprint: "BAAI/bge-small-en-v1.5:384:cls:l2:v2",
  }
): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      ...(model === null ? {} : { model }),
      ...attestation,
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function vec(_seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
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
    await expect(handleTextEmbedding(makeRuntime(), "   ")).rejects.toThrow(/cannot be blank/);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("enforces the canonical input boundary without truncating or repairing", async () => {
    const exact = "x".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS);
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(1)]));

    await handleTextEmbedding(makeRuntime(), exact);

    expect(requestRaw.mock.calls[0]?.[2]?.json).toMatchObject({
      input: [exact],
    });
    requestRaw.mockClear();
    await expect(handleTextEmbedding(makeRuntime(), `${exact}x`)).rejects.toThrow(
      /maximum is 510/i
    );
    await expect(handleTextEmbedding(makeRuntime(), "bad \uD83D input")).rejects.toThrow(
      /well-formed Unicode/i
    );
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("returns the real embedding for valid text", async () => {
    const controller = new AbortController();
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.7)]));
    const result = await handleTextEmbedding(makeRuntime(), {
      text: "hello world",
      signal: controller.signal,
    });
    expect(result).toEqual(vec(0.7));
    expect(requestRaw).toHaveBeenCalledWith(
      "POST",
      "/embeddings",
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("rejects explicit response model mismatches and omitted identity", async () => {
    requestRaw
      .mockResolvedValueOnce(embeddingResponse([vec(1)], "text-embedding-3-small"))
      .mockResolvedValueOnce(embeddingResponse([vec(1)], null));

    await expect(handleTextEmbedding(makeRuntime(), "first")).rejects.toThrow(/model mismatch/i);
    await expect(handleTextEmbedding(makeRuntime(), "second")).rejects.toThrow(/model mismatch/i);
  });

  it("rejects missing, mean-pooled, and old-fingerprint response attestation", async () => {
    requestRaw
      .mockResolvedValueOnce(embeddingResponse([vec(1)], "BAAI/bge-small-en-v1.5", {}))
      .mockResolvedValueOnce(
        embeddingResponse([vec(1)], "BAAI/bge-small-en-v1.5", { pooling: "mean" })
      )
      .mockResolvedValueOnce(
        embeddingResponse([vec(1)], "BAAI/bge-small-en-v1.5", {
          pooling: "cls",
          embedding_space_fingerprint: "BAAI/bge-small-en-v1.5:384:mean:l2:v1",
        })
      );

    await expect(handleTextEmbedding(makeRuntime(), "missing")).rejects.toThrow(
      /pooling attestation mismatch/i
    );
    await expect(handleTextEmbedding(makeRuntime(), "mean")).rejects.toThrow(
      /pooling attestation mismatch/i
    );
    await expect(handleTextEmbedding(makeRuntime(), "old")).rejects.toThrow(
      /embedding-space attestation mismatch/i
    );
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
      /input at index 1/
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
      new Response(JSON.stringify({ model: "BAAI/bge-small-en-v1.5", not: "data" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /invalid response structure/
    );
  });

  it("throws on a transport error instead of writing markers", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    requestRaw.mockRejectedValueOnce(new Error("network down"));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(/network down/);
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("preserves expected turn cancellation without logging a provider failure", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    const debugSpy = vi.spyOn(logger, "debug");
    const controller = new AbortController();
    const cancellation = Object.assign(new Error("Turn aborted: voice-session-interrupt"), {
      name: "TurnAbortedError",
      code: "TURN_ABORTED",
    });
    controller.abort(cancellation);
    requestRaw.mockRejectedValueOnce(cancellation);

    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"], controller.signal)).rejects.toBe(
      cancellation
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith("[BatchEmbeddings] Batch cancelled with its owning turn");
  });

  // Backoff is driven through vitest fake timers so the ~1s exponential sleep
  // (with Math.random jitter) never burns real wall-clock and can't flake.
  it("retries once after a 429 and returns real vectors on retry success", async () => {
    vi.useFakeTimers();
    try {
      requestRaw
        .mockResolvedValueOnce(
          new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        )
        .mockResolvedValueOnce(embeddingResponse([vec(0.9)]));
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual([vec(0.9)]);
      expect(requestRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws (no markers) when the post-429 retry also fails", async () => {
    vi.useFakeTimers();
    try {
      requestRaw
        .mockResolvedValueOnce(
          new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        )
        .mockResolvedValueOnce(
          new Response("still bad", { status: 503, statusText: "Unavailable" })
        );
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      // Attach the rejection assertion before flushing timers so the rejection
      // is observed (no unhandled-rejection warning) once the retry resolves.
      const assertion = expect(promise).rejects.toThrow(/API error: 503/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(emitModelUsageEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleBatchTextEmbedding cold-gateway warming retry (#18103)", () => {
  // The structural warming 503 body the gateway emits while auth/billing
  // caches hydrate (#17875's shape) — the class that dropped one-shot seeds.
  function warmingResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          message: "Authorization cache is warming. Retry shortly.",
          type: "service_unavailable",
          code: "auth_cache_warming",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  it("retries through the warming window and returns real vectors (seed survives a cold cache)", async () => {
    vi.useFakeTimers();
    try {
      // Three warming 503s exceed the ordinary 2-attempt transient budget —
      // proving the warming schedule is its own budget — then success.
      requestRaw
        .mockResolvedValueOnce(warmingResponse())
        .mockResolvedValueOnce(warmingResponse())
        .mockResolvedValueOnce(warmingResponse())
        .mockResolvedValueOnce(embeddingResponse([vec(0.7)]));
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual([vec(0.7)]);
      expect(requestRaw).toHaveBeenCalledTimes(4);
      expect(emitModelUsageEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails closed when the gateway keeps warming past the bounded budget", async () => {
    vi.useFakeTimers();
    try {
      // Warming budget (4 retries) + transient budget (1 retry) all warming →
      // terminal 503 throw, never a marker vector.
      requestRaw.mockImplementation(async () => warmingResponse());
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      const assertion = expect(promise).rejects.toThrow(/API error: 503/);
      await vi.runAllTimersAsync();
      await assertion;
      // 1 initial + 4 warming retries + 1 transient retry = 6 total attempts.
      expect(requestRaw).toHaveBeenCalledTimes(6);
      expect(emitModelUsageEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a NON-warming 503 on the small transient budget (dead gateway fails promptly)", async () => {
    vi.useFakeTimers();
    try {
      const dead = () =>
        new Response(JSON.stringify({ error: { code: "upstream_error" } }), {
          status: 503,
          statusText: "Unavailable",
          headers: { "Content-Type": "application/json" },
        });
      requestRaw.mockImplementation(async () => dead());
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      const assertion = expect(promise).rejects.toThrow(/API error: 503/);
      await vi.runAllTimersAsync();
      await assertion;
      // No warming budget consumed: 1 initial + 1 transient retry only.
      expect(requestRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("embeddingBackoffMs cap + escalation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clamps even a large server retry-after to the cap (no jitter)", () => {
    // Math.random()→0 removes the ±25% jitter so the value is exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    // retry-after 600s would be 600_000ms uncapped — the cap is what stops a
    // hostile/large hint from parking the embedding queue.
    expect(embeddingBackoffMs(0, 600)).toBe(EMBED_BACKOFF_CAP_MS);
    expect(embeddingBackoffMs(0, 600)).toBeLessThan(600_000);
  });

  it("escalates exponentially from the base, capped at EMBED_BACKOFF_CAP_MS", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(embeddingBackoffMs(0)).toBe(1_000);
    expect(embeddingBackoffMs(2)).toBe(4_000);
    // 1000·2^5 = 32_000 → clamped to the 8_000 cap.
    expect(embeddingBackoffMs(5)).toBe(EMBED_BACKOFF_CAP_MS);
  });

  it("adds bounded (≤25%) jitter on top of the base", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    // base 1000 · (1 + 1·0.25) = 1250
    expect(embeddingBackoffMs(0)).toBe(1_250);
  });
});

describe("handleBatchTextEmbedding dimension + count integrity (#8769)", () => {
  it("pins every Cloud request to canonical CLS pooling and 384 dimensions", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(1)]));

    await handleBatchTextEmbedding(makeRuntime(), ["canonical contract"]);

    expect(requestRaw.mock.calls[0]?.[2]?.json).toMatchObject({
      model: "BAAI/bge-small-en-v1.5",
      dimensions: 384,
      pooling: "cls",
    });
  });

  it("sends the configured `dimensions` in the POST body so the gateway pins width", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.4)]));
    // 384-configured agent; the response width won't match so the call rejects —
    // we only care that the request carried `dimensions: 384`.
    await handleBatchTextEmbedding(makeRuntime(384), ["a"]).catch(() => undefined);
    const [method, path, opts] = requestRaw.mock.calls[0] as [
      string,
      string,
      { json?: { dimensions?: number; model?: string; input?: string[] } },
    ];
    expect(method).toBe("POST");
    expect(path).toBe("/embeddings");
    expect(opts.json?.dimensions).toBe(384);
  });

  it("throws on a width mismatch and bills nothing", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([new Array(385).fill(0.1)]));
    await expect(handleBatchTextEmbedding(makeRuntime(384), ["a"])).rejects.toThrow(
      /dimension mismatch: model returned 385d but agent is configured for 384d/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on a count mismatch (fewer vectors than inputs) instead of returning undefined holes", async () => {
    // 2 inputs, server returns only 1 vector — the missing slot would be an
    // undefined hole that escapes to the runtime.
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.1)]));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a", "b"])).rejects.toThrow(
      /expected 2 embeddings, got 1/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on an out-of-range response index instead of crashing on undefined.originalIndex", async () => {
    // A malformed/cross-batch absolute index (5) for a single-item batch.
    requestRaw.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: "BAAI/bge-small-en-v1.5",
          pooling: "cls",
          embedding_space_fingerprint: "BAAI/bge-small-en-v1.5:384:cls:l2:v2",
          data: [{ embedding: vec(0.2), index: 5 }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /response index out of range/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("rejects duplicate in-range response indices instead of returning a sparse batch", async () => {
    requestRaw.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: "BAAI/bge-small-en-v1.5",
          pooling: "cls",
          embedding_space_fingerprint: "BAAI/bge-small-en-v1.5:384:cls:l2:v2",
          data: [
            { embedding: vec(0.2), index: 0 },
            { embedding: vec(0.3), index: 0 },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a", "b"])).rejects.toThrow(
      /duplicate response index/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });
});
