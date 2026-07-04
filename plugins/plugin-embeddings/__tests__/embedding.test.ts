/** Tests for the embedding handlers against a mocked fetch: request shape, dimension validation, and batch handling (no live endpoint). */
import type { IAgentRuntime } from "@elizaos/core";
import { VECTOR_DIMS } from "@elizaos/core";
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
  return Array.from({ length }, (_v, i) => (i + 1) / length);
}

function mockEmbeddingsResponse(vectors: number[][]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      object: "list",
      data: vectors.map((embedding, index) => ({ object: "embedding", embedding, index })),
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    text: async () => "",
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("plugin-embeddings handleTextEmbedding", () => {
  it("returns an EMBEDDING_DIMENSIONS-wide vector for the null init-probe", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const probe = await handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "768" }), null);

    expect(probe).toHaveLength(768);
    expect(probe[0]).toBeCloseTo(0.1);
    // The null probe must never hit the network — it only reports the width.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults the probe width to 1536 when EMBEDDING_DIMENSIONS is unset", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(vi.fn() as typeof fetch);
    const probe = await handleTextEmbedding(createRuntime(), null);
    expect(probe).toHaveLength(1536);
  });

  it("returns the parsed vector from a wire-mocked /embeddings response", async () => {
    const expected = vectorOf(1536);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([expected]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await handleTextEmbedding(createRuntime(), { text: "hello world" });

    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://embeddings.example/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe("hello world");
    expect(body.model).toBe("text-embedding-3-small");
  });

  it("omits the dimensions field when EMBEDDING_DIMENSIONS is not explicitly set", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(1536)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await handleTextEmbedding(createRuntime(), { text: "hi" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("dimensions");
  });

  it("sends the dimensions field when EMBEDDING_DIMENSIONS is explicitly set", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(512)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "512" }), { text: "hi" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.dimensions).toBe(512);
  });

  it("throws on a dimension mismatch (never returns the wrong-width vector)", async () => {
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(768)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "1536" }), { text: "hi" })
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it("throws on empty text before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTextEmbedding(createRuntime(), { text: "   " })).rejects.toThrow(
      /empty text/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on an unsupported configured dimension", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTextEmbedding(createRuntime({ EMBEDDING_DIMENSIONS: "999" }), { text: "hi" })
    ).rejects.toThrow(/Invalid embedding dimension/i);
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

  it("emits the configured dimension as a member of VECTOR_DIMS (contract)", async () => {
    const dims = Object.values(VECTOR_DIMS) as number[];
    for (const dim of dims) {
      const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(dim)]));
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
      const result = await handleTextEmbedding(
        createRuntime({ EMBEDDING_DIMENSIONS: String(dim) }),
        { text: "contract" }
      );
      expect(result).toHaveLength(dim);
      expect(dims).toContain(result.length);
      vi.restoreAllMocks();
    }
  });
});

describe("plugin-embeddings handleBatchTextEmbedding", () => {
  it("returns one vector per input in order from a single request", async () => {
    const v0 = vectorOf(1536).map((x) => x * 0.5);
    const v1 = vectorOf(1536);
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
      /empty text at index 1/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
