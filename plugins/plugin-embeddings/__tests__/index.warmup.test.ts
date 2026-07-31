/**
 * Tests for the boot-time endpoint warm-up fired from `init()`: one
 * TEXT_EMBEDDING call when a base URL is configured and observable diagnostics
 * when the endpoint is unreachable.
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
    reportError: vi.fn(),
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

  it("rejects API-key-only configuration before warm-up", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => mockEmbeddingsResponse([vectorOf(1536)]));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await expect(
      embeddingsPlugin.init?.({}, createRuntime({ EMBEDDING_API_KEY: "key-only" }))
    ).rejects.toMatchObject({ code: "EMBEDDINGS_ENDPOINT_NOT_CONFIGURED" });
    await flushWarmupChain();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a rejected warm-up without breaking boot", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED: embedding endpoint down");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const runtime = createRuntime({ EMBEDDING_BASE_URL: "https://down.example/v1" });
    await expect(embeddingsPlugin.init?.({}, runtime)).resolves.toBeUndefined();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushWarmupChain();
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringMatching(/Endpoint warm/));
    expect(runtime.reportError).toHaveBeenCalledWith("Embeddings.warmup", expect.any(Error), {
      endpoint: "https://down.example/v1",
    });
  });
});
