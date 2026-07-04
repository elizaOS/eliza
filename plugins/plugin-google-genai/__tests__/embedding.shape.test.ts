/**
 * Unit tests for `handleTextEmbedding`: the null-probe marker vector, usage
 * emission, and the throw paths (empty input, empty API response). The config,
 * events, tokenization, and `@google/genai` layers are mocked — no live call.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  countTokens: vi.fn(),
  createGoogleGenAI: vi.fn(),
  embedContent: vi.fn(),
  emitModelUsageEvent: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
  ModelType: {
    TEXT_EMBEDDING: "TEXT_EMBEDDING",
  },
}));

vi.mock("../utils/config", () => ({
  createGoogleGenAI: mocks.createGoogleGenAI,
  getEmbeddingModel: vi.fn(() => "text-embedding-004"),
}));

vi.mock("../utils/events", () => ({
  emitModelUsageEvent: mocks.emitModelUsageEvent,
}));

vi.mock("../utils/tokenization", () => ({
  countTokens: mocks.countTokens,
}));

import { handleTextEmbedding } from "../models/embedding";

function createRuntime(): IAgentRuntime {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn(() => null),
  } as unknown as IAgentRuntime;
}

describe("Google GenAI embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTokens.mockResolvedValue(5);
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });
    mocks.createGoogleGenAI.mockReturnValue({
      models: {
        embedContent: mocks.embedContent,
      },
    });
  });

  it("returns a marker vector for null initialization probes without creating a client", async () => {
    const embedding = await handleTextEmbedding(createRuntime(), null);

    expect(embedding).toHaveLength(768);
    expect(embedding[0]).toBe(0.1);
    expect(embedding.slice(1).every((value) => value === 0)).toBe(true);
    expect(mocks.createGoogleGenAI).not.toHaveBeenCalled();
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("embeds non-empty input and emits usage", async () => {
    const runtime = createRuntime();

    const embedding = await handleTextEmbedding(runtime, "hello");

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(mocks.embedContent).toHaveBeenCalledWith({
      model: "text-embedding-004",
      contents: "hello",
    });
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      {
        promptTokens: 5,
        completionTokens: 0,
        totalTokens: 5,
      },
    );
  });

  it("throws for empty embedding input before creating a client", async () => {
    await expect(
      handleTextEmbedding(createRuntime(), { text: " \n\t " }),
    ).rejects.toThrow("Cannot generate embedding for empty text");

    expect(mocks.createGoogleGenAI).not.toHaveBeenCalled();
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("throws when the embedding API fails", async () => {
    mocks.embedContent.mockRejectedValue(new Error("provider unavailable"));

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      "provider unavailable",
    );
  });

  it("throws when the embedding API returns no vector", async () => {
    mocks.embedContent.mockResolvedValue({ embeddings: [] });

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      "Google GenAI API returned no embedding",
    );
  });
});
