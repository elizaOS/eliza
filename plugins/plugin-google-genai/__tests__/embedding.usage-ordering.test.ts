/**
 * Pins usage accounting for `handleTextEmbedding` on the paths that fail AFTER
 * the provider call was already billed (#22102): empty response, width
 * mismatch, and each `l2Normalize` rejection. Metering must run once the
 * provider returns, not at the tail of the happy path, or every fail-closed
 * validation silently under-counts consumed tokens. Also pins that metering is
 * observability only — an emitter failure must neither mask the typed validation
 * error nor withhold an otherwise usable vector. Deterministic: the config,
 * events, and `@google/genai` layers are mocked, no live call; the real
 * `ElizaError` is used so the typed `code` contract is asserted.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  countEmbeddingTokens: vi.fn(),
  createGoogleGenAI: vi.fn(),
  embedContent: vi.fn(),
  emitModelUsageEvent: vi.fn(),
}));

vi.mock("@elizaos/core", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
  return {
    ElizaError: actual.ElizaError,
    logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    ModelType: { TEXT_EMBEDDING: "TEXT_EMBEDDING" },
  };
});

vi.mock("../utils/config", async () => {
  const actual =
    await vi.importActual<typeof import("../utils/config")>("../utils/config");
  return {
    ...actual,
    createGoogleGenAI: mocks.createGoogleGenAI,
    getEmbeddingModel: vi.fn(() => "gemini-embedding-001"),
  };
});

vi.mock("../utils/events", () => ({
  emitModelUsageEvent: mocks.emitModelUsageEvent,
}));

import { handleTextEmbedding } from "../models/embedding";

function createRuntime(): IAgentRuntime & {
  reportError: ReturnType<typeof vi.fn>;
} {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn(() => null),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime & { reportError: ReturnType<typeof vi.fn> };
}

/** The exact usage payload the happy path reports, for parity assertions. */
const EXPECTED_USAGE = {
  promptTokens: 5,
  completionTokens: 0,
  totalTokens: 5,
};

describe("Google GenAI embedding usage accounting on billed-but-failing calls (#22102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countEmbeddingTokens.mockResolvedValue({ totalTokens: 5 });
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(0.5) }],
    });
    mocks.createGoogleGenAI.mockReturnValue({
      models: {
        countTokens: mocks.countEmbeddingTokens,
        embedContent: mocks.embedContent,
      },
    });
  });

  it("still reports usage when the provider returns an empty embedding", async () => {
    mocks.embedContent.mockResolvedValue({ embeddings: [{ values: [] }] });
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toThrow(
      /returned no embedding/,
    );
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      EXPECTED_USAGE,
    );
  });

  it("still reports usage when the returned width disagrees with the probe", async () => {
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(3072).fill(0.5) }],
    });
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toMatchObject({
      code: "EMBEDDING_DIMENSION_MISMATCH",
    });
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      EXPECTED_USAGE,
    );
  });

  it("still reports usage when normalization overflows", async () => {
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(1e154) }],
    });
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toMatchObject({
      code: "EMBEDDING_NORM_OVERFLOW",
    });
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      EXPECTED_USAGE,
    );
  });

  it("still reports usage when the vector has zero magnitude", async () => {
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(0) }],
    });
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toThrow();
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("still reports usage when a component is non-finite", async () => {
    const values = Array(768).fill(0.5);
    values[41] = Number.NaN;
    mocks.embedContent.mockResolvedValue({ embeddings: [{ values }] });
    const runtime = createRuntime();

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toMatchObject({
      code: "EMBEDDING_NON_FINITE",
    });
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      EXPECTED_USAGE,
    );
  });

  it("reports usage exactly once on a failing call", async () => {
    mocks.embedContent.mockResolvedValue({ embeddings: [{ values: [] }] });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toThrow();
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("does not meter a call the provider never billed", async () => {
    mocks.embedContent.mockRejectedValue(new Error("network exploded"));

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      /network exploded/,
    );
    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("does not meter an aborted provider call (AbortError)", async () => {
    const abortError = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    mocks.embedContent.mockRejectedValue(abortError);

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      /aborted/,
    );
    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("does not meter the initialization probe, which makes no provider call", async () => {
    await handleTextEmbedding(createRuntime(), null);
    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("keeps the happy path reporting the same usage payload", async () => {
    const runtime = createRuntime();

    const embedding = await handleTextEmbedding(runtime, "hello");

    expect(embedding).toHaveLength(768);
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      EXPECTED_USAGE,
    );
  });

  it("meters the exact provider-counted prefix used for a truncated call", async () => {
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => ({
        totalTokens: contents.length,
      }),
    );
    const runtime = createRuntime();

    await handleTextEmbedding(runtime, "x".repeat(3_000));

    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "x".repeat(2_048),
      {
        promptTokens: 2_048,
        completionTokens: 0,
        totalTokens: 2_048,
      },
    );
  });

  describe("metering is observability, not control flow", () => {
    it("an emitter failure does not mask the typed validation error", async () => {
      mocks.emitModelUsageEvent.mockRejectedValueOnce(
        new Error("telemetry down"),
      );
      mocks.embedContent.mockResolvedValue({
        embeddings: [{ values: Array(3072).fill(0.5) }],
      });
      const runtime = createRuntime();

      await expect(handleTextEmbedding(runtime, "hello")).rejects.toMatchObject(
        {
          code: "EMBEDDING_DIMENSION_MISMATCH",
        },
      );
      expect(runtime.reportError).toHaveBeenCalledWith(
        "GoogleGenAI.embeddingUsage",
        expect.any(Error),
        expect.objectContaining({ model: "gemini-embedding-001" }),
      );
    });

    it("an emitter failure does not withhold a usable vector", async () => {
      mocks.emitModelUsageEvent.mockRejectedValueOnce(
        new Error("telemetry down"),
      );
      const runtime = createRuntime();

      const embedding = await handleTextEmbedding(runtime, "hello");

      expect(embedding).toHaveLength(768);
      expect(runtime.reportError).toHaveBeenCalled();
    });
  });
});
