/** Tests for the embedding handlers against a mocked fetch: request shape, dimension validation, and batch handling (no live endpoint). */
import { CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleBatchTextEmbedding, handleTextEmbedding } from "../src/models/embedding";

function createRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const values: Record<string, string> = {
    EMBEDDING_BASE_URL: "https://embeddings.example/v1",
    EMBEDDING_API_KEY: "test-key",
    ...settings,
  };
  return {
    character: { name: "Ada" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => values[key] ?? null),
  } as unknown as IAgentRuntime;
}

function vectorOf(length: number): number[] {
  return Array.from({ length }, (_v, i) => (i === 0 ? 1 : 0));
}

function mockEmbeddingsResponse(vectors: number[][]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      object: "list",
      data: vectors.map((embedding, index) => ({ object: "embedding", embedding, index })),
      model: "BAAI/bge-small-en-v1.5",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    text: async () => "",
  } as unknown as Response;
}

function mockHttpError(status: number, statusText: string, body: string): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("plugin-embeddings handleTextEmbedding", () => {
  it("returns the canonical 384-wide vector for the null init-probe", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const probe = await handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "384" }), null);

    expect(probe).toHaveLength(384);
    expect(probe[0]).toBeCloseTo(0.1);
    // The null probe must never hit the network — it only reports the width.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults the probe width to 384 when EMBEDDING_DIMENSIONS is unset", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(vi.fn() as typeof fetch);
    const probe = await handleTextEmbedding(createRuntime(), null);
    expect(probe).toHaveLength(384);
  });

  it("returns the parsed vector from a wire-mocked /embeddings response", async () => {
    const expected = vectorOf(384);
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([expected]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await handleTextEmbedding(createRuntime(), {
      text: "hello world",
      signal: controller.signal,
    });

    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://embeddings.example/v1/embeddings");
    expect(init.signal).toBe(controller.signal);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe("hello world");
    expect(body.model).toBe("BAAI/bge-small-en-v1.5");
  });

  it("rejects explicit response model mismatches and omitted identity", async () => {
    const vector = vectorOf(384);
    const response = (model: string | undefined): Response =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          object: "list",
          data: [{ object: "embedding", embedding: vector, index: 0 }],
          ...(model === undefined ? {} : { model }),
        }),
        text: async () => "",
      }) as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("text-embedding-3-small"))
      .mockResolvedValueOnce(response(undefined));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(handleTextEmbedding(createRuntime(), "first")).rejects.toThrow(
      /embedding model mismatch/i
    );
    await expect(handleTextEmbedding(createRuntime(), "second")).rejects.toThrow(
      /embedding model mismatch/i
    );
  });

  it("uses the primary endpoint without touching fallback when primary succeeds", async () => {
    const expected = vectorOf(384);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([expected]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await handleTextEmbedding(
      createRuntime({
        EMBEDDING_FALLBACK_BASE_URL: "https://fallback.example/v1",
        EMBEDDING_FALLBACK_API_KEY: "fallback-key",
        EMBEDDING_FALLBACK_MODEL: "BAAI/bge-small-en-v1.5",
      }),
      { text: "hello world" }
    );

    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://embeddings.example/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string).model).toBe("BAAI/bge-small-en-v1.5");
  });

  it("retries once against fallback when the primary endpoint fails", async () => {
    const expected = vectorOf(384);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockHttpError(503, "Service Unavailable", "local warming"))
      .mockResolvedValueOnce(mockEmbeddingsResponse([expected]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await handleTextEmbedding(
      createRuntime({
        EMBEDDING_FALLBACK_BASE_URL: "https://fallback.example/v1/",
        EMBEDDING_FALLBACK_API_KEY: "fallback-key",
        EMBEDDING_FALLBACK_MODEL: "BAAI/bge-small-en-v1.5",
      }),
      { text: "hello world" }
    );

    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [fallbackUrl, fallbackInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(fallbackUrl).toBe("https://fallback.example/v1/embeddings");
    expect((fallbackInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer fallback-key"
    );
    const body = JSON.parse(fallbackInit.body as string);
    expect(body.model).toBe("BAAI/bge-small-en-v1.5");
    expect(body.input).toBe("hello world");
  });

  it("throws when the fallback response width differs from EMBEDDING_DIMENSIONS", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockHttpError(502, "Bad Gateway", "primary down"))
      .mockResolvedValueOnce(mockEmbeddingsResponse([vectorOf(385)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      handleTextEmbedding(
        createRuntime({
          EMBEDDING_DIMENSIONS: "384",
          EMBEDDING_FALLBACK_BASE_URL: "https://fallback.example/v1",
        }),
        { text: "hi" }
      )
    ).rejects.toThrow(/fallback embedding dimension mismatch: got 385, expected 384/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws with primary and fallback context when both endpoints fail", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(mockHttpError(401, "Unauthorized", "bad fallback key"));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      handleTextEmbedding(
        createRuntime({
          EMBEDDING_FALLBACK_BASE_URL: "https://fallback.example/v1",
          EMBEDDING_FALLBACK_API_KEY: "fallback-key",
        }),
        { text: "hi" }
      )
    ).rejects.toThrow(
      /Embedding endpoints failed: primary https:\/\/embeddings\.example\/v1: connect ECONNREFUSED \| fallback https:\/\/fallback\.example\/v1: fallback embedding API HTTP 401 Unauthorized - bad fallback key/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("omits the dimensions field when EMBEDDING_DIMENSIONS is not explicitly set", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(384)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await handleTextEmbedding(createRuntime(), { text: "hi" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("dimensions");
  });

  it("sends the dimensions field when EMBEDDING_DIMENSIONS is explicitly set", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(384)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "384" }), { text: "hi" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.dimensions).toBe(384);
  });

  it("throws on a dimension mismatch (never returns the wrong-width vector)", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(385)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "384" }), { text: "hi" })
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it("throws on empty text before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTextEmbedding(createRuntime(), { text: "   " })).rejects.toThrow(
      /cannot be blank/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fallback for malformed caller input", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTextEmbedding(
        createRuntime({ EMBEDDING_FALLBACK_BASE_URL: "https://fallback.example/v1" }),
        { text: "   " }
      )
    ).rejects.toThrow(/cannot be blank/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on an unsupported configured dimension", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "999" }), { text: "hi" })
    ).rejects.toThrow(/dimension mismatch/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when no endpoint is configured (no silent default, no zero vector)", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    // Only a key, no base URL — a real text embed cannot resolve an endpoint.
    const runtime = {
      character: { name: "Ada" },
      emitEvent: vi.fn(),
      getSetting: vi.fn((key: string) => (key === "EMBEDDING_API_KEY" ? "k" : null)),
    } as unknown as IAgentRuntime;

    await expect(handleTextEmbedding(runtime, { text: "hi" })).rejects.toThrow(
      /No embedding endpoint configured/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-OK HTTP response instead of returning a fabricated vector", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "upstream down",
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(handleTextEmbedding(createRuntime(), { text: "hi" })).rejects.toThrow(/502/);
  });

  it("emits only the canonical 384-dimensional contract", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(384)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    await expect(handleTextEmbedding(createRuntime(), { text: "contract" })).resolves.toHaveLength(
      384
    );
    await expect(
      handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "512" }), { text: "contract" })
    ).rejects.toThrow(/dimension mismatch/i);
  });
});

describe("plugin-embeddings handleBatchTextEmbedding", () => {
  it("returns one vector per input in order from a single request", async () => {
    const v0 = vectorOf(384);
    const v1 = vectorOf(384);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([v0, v1]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await handleBatchTextEmbedding(createRuntime(), ["a", "b"]);

    expect(result).toEqual([v0, v1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.input).toEqual(["a", "b"]);
  });

  it("returns [] for an empty batch without calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    await expect(handleBatchTextEmbedding(createRuntime(), [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on an empty text inside a batch", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    await expect(handleBatchTextEmbedding(createRuntime(), ["ok", "  "])).rejects.toThrow(
      /input at index 1/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the response repeats an index (a hole must never be returned)", async () => {
    // Count check alone passes (2 items for 2 inputs) but slot 1 stays unfilled;
    // returning [B, undefined] would silently persist a corrupt vector.
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            object: "list",
            data: [
              { object: "embedding", embedding: vectorOf(384), index: 0 },
              { object: "embedding", embedding: vectorOf(384), index: 0 },
            ],
            model: "BAAI/bge-small-en-v1.5",
          }),
          text: async () => "",
        }) as unknown as Response
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(handleBatchTextEmbedding(createRuntime(), ["one", "two"])).rejects.toThrow(
      /duplicate index 0/i
    );
  });

  it("throws when the response index is not an integer", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            object: "list",
            data: [
              { object: "embedding", embedding: vectorOf(384), index: 0.5 },
              { object: "embedding", embedding: vectorOf(384), index: 1 },
            ],
            model: "BAAI/bge-small-en-v1.5",
          }),
          text: async () => "",
        }) as unknown as Response
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(handleBatchTextEmbedding(createRuntime(), ["one", "two"])).rejects.toThrow(
      /out-of-range index 0.5/i
    );
  });
});

describe("plugin-embeddings canonical input boundary", () => {
  it("sends an exact-limit input without truncation", async () => {
    const text = "a".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(384)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await handleTextEmbedding(createRuntime(), text);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.input).toBe(text);
  });

  it("rejects one-over-limit and ill-formed Unicode without provider dispatch", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTextEmbedding(createRuntime(), "a".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS + 1))
    ).rejects.toThrow(/maximum is 510/i);
    await expect(handleTextEmbedding(createRuntime(), "bad \uD83D input")).rejects.toThrow(
      /well-formed Unicode/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
