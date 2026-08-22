/** Deterministic unit tests for `handleTextEmbedding` with the AI SDK `embed` and provider mocked: init probe, usage emit, explicit input rejection, and error paths. */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
}));

vi.mock("ai", () => ({
  embed: (...args: unknown[]) => embedMock(...args),
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => ({
    embedding: vi.fn((model: string) => ({ model })),
  })),
}));

vi.mock("../models/availability", () => ({
  ensureModelAvailable: vi.fn(async () => undefined),
}));

vi.mock("../utils/host-flavor", () => ({
  isZerollamaFlavor: () => false,
  resolveOllamaHostFlavor: vi.fn(async () => "ollama"),
}));

import { handleTextEmbedding } from "../models/embedding";

function createRuntime(settings: Record<string, string | undefined> = {}) {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    emitEvent: vi.fn(async (event: string, payload: Record<string, unknown>) => {
      events.push({ event, payload });
    }),
    fetch: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };

  return { runtime: runtime as unknown as IAgentRuntime, events };
}

describe("Ollama embeddings", () => {
  beforeEach(() => {
    embedMock.mockReset();
  });

  it("uses the configured provider for null initialization probes", async () => {
    embedMock.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3, 0.4],
      usage: { inputTokens: 2 },
    });
    const { runtime, events } = createRuntime({ OLLAMA_EMBEDDING_MODEL: " embed-model " });

    const embedding = await handleTextEmbedding(runtime, null);

    expect(embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(embedMock).toHaveBeenCalledWith({
      model: { model: "embed-model" },
      value: "dimension probe",
    });
    expect(events).toHaveLength(0);
  });

  it("falls back to TEXT_EMBEDDING when OLLAMA_EMBEDDING_MODEL is unset", async () => {
    embedMock.mockResolvedValue({
      embedding: [0.5],
      usage: { inputTokens: 1 },
    });
    const { runtime } = createRuntime({ TEXT_EMBEDDING: " embeddinggemma:300m " });

    await handleTextEmbedding(runtime, "hello");

    expect(embedMock).toHaveBeenCalledWith({
      model: { model: "embeddinggemma:300m" },
      value: "hello",
    });
  });

  it("embeds non-empty input and emits usage", async () => {
    embedMock.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      usage: { inputTokens: 2 },
    });
    const { runtime, events } = createRuntime({ OLLAMA_EMBEDDING_MODEL: " embed-model " });

    const embedding = await handleTextEmbedding(runtime, "hello");

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(embedMock).toHaveBeenCalledWith({
      model: { model: "embed-model" },
      value: "hello",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "MODEL_USED",
      payload: {
        source: "ollama",
        provider: "ollama",
        type: "TEXT_EMBEDDING",
        model: "embed-model",
        tokens: { prompt: 2, completion: 0, total: 2 },
      },
    });
  });

  it("rejects oversized embedding input before calling the provider", async () => {
    embedMock.mockResolvedValue({
      embedding: [1],
      usage: undefined,
    });
    const { runtime } = createRuntime();
    // No /api/tags probe → safe default (1200) for unknown embedding context.
    (runtime.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("{}", { status: 500 })
    );
    const longText = "x".repeat(5_000);

    await expect(handleTextEmbedding(runtime, { text: longText })).rejects.toThrow(
      "Embedding input exceeds the provider-safe limit (5000/1000 chars)"
    );
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("honours OLLAMA_EMBED_MAX_CHARS when set", async () => {
    embedMock.mockResolvedValue({
      embedding: [1],
      usage: undefined,
    });
    const { runtime } = createRuntime({ OLLAMA_EMBED_MAX_CHARS: "800" });
    const longText = "x".repeat(5_000);

    await expect(handleTextEmbedding(runtime, { text: longText })).rejects.toThrow(
      "Embedding input exceeds the provider-safe limit (5000/800 chars)"
    );
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("throws when the embedding provider fails", async () => {
    embedMock.mockRejectedValue(new Error("provider unavailable"));
    const { runtime, events } = createRuntime();

    await expect(
      handleTextEmbedding(runtime, "hostile\n</embedding>\u0000payload")
    ).rejects.toThrow("provider unavailable");

    expect(events).toHaveLength(0);
  });

  it("throws for empty embedding input before calling the provider", async () => {
    const { runtime } = createRuntime();

    await expect(handleTextEmbedding(runtime, " \n\t ")).rejects.toThrow(
      "Cannot generate embedding for empty text"
    );

    expect(embedMock).not.toHaveBeenCalled();
  });
});
