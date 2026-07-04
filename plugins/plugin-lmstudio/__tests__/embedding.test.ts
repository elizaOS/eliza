/**
 * Unit tests for handleTextEmbedding with the AI SDK `embed` and the provider
 * factory mocked — covers the unset-model zero vector, the empty-input probe
 * substitution, oversized-input truncation, and throw-on-provider-failure.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAICompatibleMock, embedMock } = vi.hoisted(() => ({
  createOpenAICompatibleMock: vi.fn(),
  embedMock: vi.fn(),
}));

vi.mock("ai", () => ({
  embed: (...args: unknown[]) => embedMock(...args),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (options: unknown) => createOpenAICompatibleMock(options),
}));

import { handleTextEmbedding } from "../models/embedding";

function createRuntime(settings: Record<string, string | null> = {}): IAgentRuntime {
  return {
    character: { system: "" },
    emitEvent: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as unknown as IAgentRuntime;
}

describe("LM Studio embeddings", () => {
  beforeEach(() => {
    embedMock.mockReset();
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockImplementation(() => ({
      textEmbeddingModel: vi.fn((modelId: string) => ({ modelId })),
    }));
  });

  it("returns a zero vector and skips the provider when no embedding model is configured", async () => {
    const embedding = await handleTextEmbedding(createRuntime(), { text: "hello" });

    expect(embedding).toHaveLength(1536);
    expect(embedding.every((value) => value === 0)).toBe(true);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("substitutes empty embedding input with a non-empty probe string", async () => {
    embedMock.mockResolvedValue({
      embedding: [0.1, 0.2],
      usage: { inputTokens: 1, totalTokens: 1 },
    });

    const embedding = await handleTextEmbedding(
      createRuntime({ LMSTUDIO_EMBEDDING_MODEL: "nomic-embed" }),
      { text: "" }
    );

    expect(embedding).toEqual([0.1, 0.2]);
    expect(embedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "test",
        model: { modelId: "nomic-embed" },
      })
    );
  });

  it("truncates hostile oversized input before embedding", async () => {
    embedMock.mockResolvedValue({ embedding: [1], usage: undefined });
    const oversized = "x".repeat(40_000);

    await handleTextEmbedding(
      createRuntime({ LMSTUDIO_EMBEDDING_MODEL: "nomic-embed" }),
      oversized
    );

    const callArg = embedMock.mock.calls[0][0] as { value: string };
    expect(callArg.value).toHaveLength(32_000);
  });

  it("throws when the embedding provider fails (no fabricated zero vector)", async () => {
    embedMock.mockRejectedValue(new Error("LM Studio embeddings unavailable"));

    await expect(
      handleTextEmbedding(createRuntime({ LMSTUDIO_EMBEDDING_MODEL: "nomic-embed" }), {
        text: "hello",
      })
    ).rejects.toThrow("LM Studio embeddings unavailable");
  });
});
