/**
 * Tests for the boot-time endpoint warm-up fired from `init()`: one
 * best-effort TEXT_EMBEDDING call when a base URL is configured, no call when
 * it is absent, and a swallowed rejection when the endpoint is unreachable so
 * a cold endpoint can never break boot.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
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
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
    text: async () => "",
  } as unknown as Response;
}

/** Let the fire-and-forget warm-up chain settle (two macrotask turns). */
async function flushWarmupChain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("plugin-embeddings boot warm-up", () => {
  it("fires exactly one warm-up embedding against the configured endpoint on init", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(768)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      embeddingsPlugin.init?.(
        {},
        createRuntime({
          EMBEDDING_BASE_URL: "https://warm.example/v1",
          EMBEDDING_API_KEY: "warm-key",
          EMBEDDING_DIMENSIONS: "768",
        })
      )
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://warm.example/v1/embeddings");
    expect(JSON.parse(requestInit.body as string)).toMatchObject({ input: "warmup" });
    await vi.waitFor(() =>
      expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/Endpoint warm/))
    );
    // One-shot warm-up: no retry loop, no second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire a warm-up when no base URL is configured (API-key-only opt-in)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(1536)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      embeddingsPlugin.init?.({}, createRuntime({ EMBEDDING_API_KEY: "key-only" }))
    ).resolves.toBeUndefined();
    await flushWarmupChain();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/EMBEDDING_API_KEY is set/));
  });

  it("swallows a rejected warm-up so an unreachable endpoint cannot break boot", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED: embedding endpoint down");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      embeddingsPlugin.init?.({}, createRuntime({ EMBEDDING_BASE_URL: "https://down.example/v1" }))
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Settle the rejected fire-and-forget chain; were the rejection not
    // swallowed it would surface as an unhandled rejection and fail this run.
    await flushWarmupChain();
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringMatching(/Endpoint warm/));
  });
});
