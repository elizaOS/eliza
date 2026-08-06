/** Tests for the real plugin entrypoint: metadata, boot-time config validation, and model-slot wiring. */
import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { embeddingsPlugin } from "../src/index";

type Setting = string | null;

function createRuntime(settings: Record<string, Setting> = {}): IAgentRuntime {
  return {
    character: { name: "Ada" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
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

describe("plugin-embeddings entrypoint", () => {
  it("init warns but does not throw when the plugin is manually loaded without opt-in config", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await expect(embeddingsPlugin.init?.({}, createRuntime())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Neither EMBEDDING_BASE_URL/));
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("init validates dimensions at boot and rejects unsupported vector widths", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await expect(
      embeddingsPlugin.init?.(
        {},
        createRuntime({
          EMBEDDING_BASE_URL: "https://embeddings.example/v1",
          EMBEDDING_DIMENSIONS: "999",
        })
      )
    ).rejects.toThrow(/Invalid embedding dimension: 999/i);
  });

  it("init allows API-key-only opt-in but warns that real embedding calls still need an endpoint", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await expect(
      embeddingsPlugin.init?.(
        {},
        createRuntime({
          EMBEDDING_API_KEY: "key-only",
          EMBEDDING_DIMENSIONS: "768",
        })
      )
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/EMBEDDING_API_KEY is set/));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/dimensions=768/));
  });

  it("wires TEXT_EMBEDDING to the local primary endpoint before any configured fallback", async () => {
    const expected = vectorOf(512);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([expected]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await embeddingsPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(
      createRuntime({
        EMBEDDING_BASE_URL: "https://local.example/v1",
        EMBEDDING_API_KEY: "local-key",
        EMBEDDING_DIMENSIONS: "512",
        EMBEDDING_MODEL: "local-model",
        EMBEDDING_FALLBACK_BASE_URL: "https://remote.example/v1",
        EMBEDDING_FALLBACK_API_KEY: "remote-key",
        EMBEDDING_FALLBACK_MODEL: "remote-model",
      }),
      { text: "local first" }
    );

    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://local.example/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer local-key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "local-model",
      input: "local first",
      dimensions: 512,
    });
  });

  it("wires TEXT_EMBEDDING fallback without allowing mixed vector dimensions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockHttpError(503, "Service Unavailable", "local warming"))
      .mockResolvedValueOnce(mockEmbeddingsResponse([vectorOf(768)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      embeddingsPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(
        createRuntime({
          EMBEDDING_BASE_URL: "https://local.example/v1",
          EMBEDDING_DIMENSIONS: "1536",
          EMBEDDING_FALLBACK_BASE_URL: "https://remote.example/v1",
        }),
        { text: "fallback mismatch" }
      )
    ).rejects.toThrow(/fallback embedding dimension mismatch: got 768, expected 1536/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wires TEXT_EMBEDDING_BATCH to one batched /embeddings call", async () => {
    const vectors = [vectorOf(384), vectorOf(384)];
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse(vectors));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await embeddingsPlugin.models?.[ModelType.TEXT_EMBEDDING_BATCH]?.(
      createRuntime({
        EMBEDDING_BASE_URL: "https://local.example/v1",
        EMBEDDING_DIMENSIONS: "384",
      }),
      { texts: ["clear old width", "re-embed active width"] }
    );

    expect(result).toEqual(vectors);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      input: ["clear old width", "re-embed active width"],
      dimensions: 384,
    });
  });
});
