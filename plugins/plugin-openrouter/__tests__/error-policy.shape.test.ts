/**
 * Failure-path tests for the #12182 error-handling policy (#12795): missing
 * credential, provider rejection (4xx/5xx incl. rate-limit), and malformed
 * provider responses for the embedding and transcription handlers, which call
 * the OpenRouter HTTP API through a stubbed global `fetch` (no live API).
 * Every case must surface a typed error — never a fabricated vector or
 * transcript.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(settings: Record<string, string | null> = {}) {
  const defaults: Record<string, string> = {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    OPENROUTER_EMBEDDING_DIMENSIONS: "384",
    OPENROUTER_EMBEDDING_MODEL: "openrouter-embedding",
    OPENROUTER_TRANSCRIPTION_MODEL: "openrouter-whisper",
  };

  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => (key in settings ? settings[key] : (defaults[key] ?? null))),
  } as unknown as IAgentRuntime;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OpenRouter embedding failure surfaces", () => {
  it("surfaces a 429 rate-limit as a typed error, never a fabricated vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { error: { message: "rate limited" } }))
    );
    const { handleTextEmbedding } = await import("../models/embedding");
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toThrow(
      "OpenRouter API error: 429"
    );
    expect(
      (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent
    ).not.toHaveBeenCalled();
  });

  it("surfaces a 500 provider failure as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: { message: "internal" } }))
    );
    const { handleTextEmbedding } = await import("../models/embedding");

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      "OpenRouter API error: 500"
    );
  });

  it("surfaces a malformed provider response (no embedding) as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: [] }))
    );
    const { handleTextEmbedding } = await import("../models/embedding");

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      "API returned invalid structure"
    );
  });

  it("surfaces a dimension mismatch instead of returning the wrong-size vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: [{ embedding: [0.1, 0.2] }] }))
    );
    const { handleTextEmbedding } = await import("../models/embedding");

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      /Embedding length 2 does not match configured dimension 384/
    );
  });
});

describe("OpenRouter transcription failure surfaces", () => {
  it("throws a typed error when the API key is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { handleTranscription } = await import("../models/audio");

    await expect(
      handleTranscription(createRuntime({ OPENROUTER_API_KEY: null }), Buffer.from("audio"))
    ).rejects.toThrow("OPENROUTER_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 503 provider rejection with the error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("service unavailable", { status: 503, statusText: "Service Unavailable" })
      )
    );
    const { handleTranscription } = await import("../models/audio");

    await expect(handleTranscription(createRuntime(), Buffer.from("audio"))).rejects.toThrow(
      /OpenRouter transcription failed: 503 Service Unavailable - service unavailable/
    );
  });

  it("still throws the typed failure when the error body itself is unreadable", async () => {
    const response = new Response(null, { status: 500, statusText: "Internal Server Error" });
    vi.spyOn(response, "text").mockRejectedValue(new Error("socket closed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response)
    );
    const { handleTranscription } = await import("../models/audio");

    await expect(handleTranscription(createRuntime(), Buffer.from("audio"))).rejects.toThrow(
      /OpenRouter transcription failed: 500 Internal Server Error - Unknown error/
    );
  });

  it("surfaces a malformed provider response (missing text) as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { usage: { input_tokens: 1 } }))
    );
    const { handleTranscription } = await import("../models/audio");

    await expect(handleTranscription(createRuntime(), Buffer.from("audio"))).rejects.toThrow(
      "OpenRouter transcription response did not include text"
    );
  });
});
