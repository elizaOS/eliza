/**
 * Unit tests for `handleTextEmbedding`: the null-probe marker vector, the
 * probe/write width contract (#22010 — both pinned to 768 so the runtime's
 * probe-sized pgvector column matches every write), L2 normalization, usage
 * emission, and the typed fail-closed throw paths (empty input, empty API
 * response, width mismatch, zero-magnitude, non-finite components, and a norm
 * that overflows to a non-finite value). The real `ElizaError` is used via
 * `importActual` so the typed `code`/`context` contract is asserted against the
 * class the handler actually throws; the config, events, tokenization, and
 * `@google/genai` layers are mocked — no live call.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  countEmbeddingTokens: vi.fn(),
  createGoogleGenAI: vi.fn(),
  embedContent: vi.fn(),
  emitModelUsageEvent: vi.fn(),
  getEmbeddingModel: vi.fn(() => "gemini-embedding-001"),
}));

vi.mock("@elizaos/core", async () => {
  // Use the real ElizaError so `instanceof` and the typed code/context contract
  // are exercised against the class the handler throws, not a drifting stub.
  const actual =
    await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
  return {
    ElizaError: actual.ElizaError,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
    ModelType: {
      TEXT_EMBEDDING: "TEXT_EMBEDDING",
    },
  };
});

vi.mock("../utils/config", async () => {
  // Use the real per-model input-token-limit resolver so the rejection
  // boundary tests exercise the actual gemini-embedding-001 (2048) vs
  // gemini-embedding-2 (8192) map, not a re-declared stub that could drift.
  const actual =
    await vi.importActual<typeof import("../utils/config")>("../utils/config");
  return {
    createGoogleGenAI: mocks.createGoogleGenAI,
    getEmbeddingModel: mocks.getEmbeddingModel,
    getEmbeddingInputTokenLimit: actual.getEmbeddingInputTokenLimit,
  };
});

vi.mock("../utils/events", () => ({
  emitModelUsageEvent: mocks.emitModelUsageEvent,
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
    mocks.getEmbeddingModel.mockReturnValue("gemini-embedding-001");
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => ({
        totalTokens: Math.ceil(contents.length / 4),
      }),
    );
    // gemini-embedding-001 honours outputDimensionality:768 and returns a
    // 768-length (un-normalized) vector for that request.
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

    expect(embedding).toHaveLength(768);
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      runtime,
      "TEXT_EMBEDDING",
      "hello",
      {
        promptTokens: 2,
        completionTokens: 0,
        totalTokens: 2,
      },
    );
  });

  it("fails closed when the provider reports zero tokens for non-empty input", async () => {
    mocks.countEmbeddingTokens.mockResolvedValue({ totalTokens: 0 });

    await expect(
      handleTextEmbedding(createRuntime(), "non-empty"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_TOKEN_COUNT_INVALID",
      context: { model: "gemini-embedding-001", totalTokens: 0 },
    });
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("wraps provider token-count failures with typed boundary context", async () => {
    const transportFailure = new Error("countTokens transport failed");
    mocks.countEmbeddingTokens.mockRejectedValue(transportFailure);

    await expect(
      handleTextEmbedding(createRuntime(), "non-empty"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_TOKEN_COUNT_FAILED",
      context: {
        model: "gemini-embedding-001",
        inputCodeUnits: 9,
      },
      cause: transportFailure,
    });
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("pins outputDimensionality to the probe width so the write matches the sized column (#22010)", async () => {
    // Regression for #22010: the default model gemini-embedding-001 emits 3072
    // dims by default, but the runtime sizes its pgvector column from the 768
    // init probe. The real request MUST constrain the width to 768 or every
    // memory write fails with "expected 768 dimensions, not 3072".
    const probe = await handleTextEmbedding(createRuntime(), null);
    const embedding = await handleTextEmbedding(createRuntime(), "hello");

    expect(mocks.embedContent).toHaveBeenCalledWith({
      model: "gemini-embedding-001",
      contents: "hello",
      config: { outputDimensionality: 768 },
    });
    // The probe (which sizes the column) and a real write agree on width.
    expect(embedding).toHaveLength(probe.length);
    expect(embedding).toHaveLength(768);
  });

  it("L2-normalizes the returned vector to unit length", async () => {
    // Google does not pre-normalize sub-3072 outputs; the handler renormalizes
    // so vectors stay cosine-comparable like the native 768-dim model did.
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(2) }],
    });

    const embedding = await handleTextEmbedding(createRuntime(), "hello");

    const norm = Math.sqrt(
      embedding.reduce((acc, value) => acc + value * value, 0),
    );
    expect(norm).toBeCloseTo(1, 10);
    // Every component of a uniform vector normalizes to 1/sqrt(768).
    expect(embedding[0]).toBeCloseTo(1 / Math.sqrt(768), 10);
  });

  it("fails closed with a typed width-mismatch error when the provider returns a width other than the probe (no mismatched write)", async () => {
    // Adversarial: a provider ignoring outputDimensionality and returning 3072
    // must not be written into the 768-sized column; the handler throws instead.
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(3072).fill(0.01) }],
    });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_DIMENSION_MISMATCH",
      context: {
        model: "gemini-embedding-001",
        returnedDimensions: 3072,
        expectedDimensions: 768,
      },
    });
  });

  it("rejects a zero-magnitude embedding with a typed error that cannot be normalized", async () => {
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(0) }],
    });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_ZERO_MAGNITUDE",
      context: { dimensions: 768 },
    });
  });

  it("fails closed when the norm overflows to a non-finite value (all components finite)", async () => {
    // A single enormous component squares past Number.MAX_VALUE, so sumSquares
    // (and thus the norm) is Infinity even though every component is finite and
    // the per-component Number.isFinite guard passes. Dividing by an Infinity
    // norm would return an all-zero "unit" vector — a silent corrupt embedding a
    // store could persist — so the handler must fail closed instead.
    const single = Array(768).fill(1e-10);
    single[0] = 1e200;
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: single }],
    });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_NORM_OVERFLOW",
      context: { dimensions: 768 },
    });

    // Accumulation variant: 768 finite components whose squares each fit the
    // double range but whose sum overflows, even though the true norm
    // (√768·10^154 ≈ 2.77e155) is perfectly representable. The naive sum can't
    // see this, so guarding the norm — not just each component — is required.
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(1e154) }],
    });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_NORM_OVERFLOW",
      context: { dimensions: 768 },
    });
  });

  it("fails closed on a non-finite component instead of returning an all-NaN unit vector", async () => {
    // A NaN slipping through a transport/SDK bug would leave norm = NaN, so a
    // bare `norm === 0` guard never fires and an all-NaN "unit" vector escapes.
    // pgvector accepts NaN literals, so it would store silently and corrupt
    // similarity ordering; the handler must reject the vector instead.
    const poisoned = Array(768).fill(0.5);
    poisoned[7] = Number.NaN;
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: poisoned }],
    });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_NON_FINITE",
      context: { dimensions: 768, index: 7 },
    });

    // Infinity is analogous (norm = Infinity), and must also fail closed.
    const infinite = Array(768).fill(0.5);
    infinite[7] = Number.POSITIVE_INFINITY;
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: infinite }],
    });

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({
      code: "EMBEDDING_NON_FINITE",
      context: { dimensions: 768, index: 7 },
    });
  });

  it("rejects adversarial one-character tokens above the default model limit", async () => {
    mocks.getEmbeddingModel.mockReturnValue("gemini-embedding-001");
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => ({
        totalTokens: contents.length,
      }),
    );
    const oversized = "!".repeat(3_000);

    await expect(
      handleTextEmbedding(createRuntime(), oversized),
    ).rejects.toMatchObject({
      code: "EMBEDDING_INPUT_TOO_LARGE",
      context: {
        model: "gemini-embedding-001",
        limit: 2_048,
        inputTokens: 3_000,
      },
    });
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("rejects oversized Unicode input without sending a prefix", async () => {
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => ({
        totalTokens: Array.from(contents).length,
      }),
    );
    const oversized = "😀".repeat(3_000);

    await expect(
      handleTextEmbedding(createRuntime(), oversized),
    ).rejects.toMatchObject({
      code: "EMBEDDING_INPUT_TOO_LARGE",
    });
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("uses only the full-input token count", async () => {
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => ({
        // A contrived merge discontinuity: the 1,500-character prefix costs
        // more than longer neighboring prefixes. The search may conservatively
        // stop early, but the exact prefix sent must still be measured <= 2,048.
        totalTokens: contents.length === 1_500 ? 2_500 : contents.length,
      }),
    );

    await expect(
      handleTextEmbedding(createRuntime(), "n".repeat(3_000)),
    ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
    expect(mocks.countEmbeddingTokens).toHaveBeenCalledTimes(1);
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("fails closed if re-measuring the selected prefix exceeds the limit", async () => {
    const callsByContents = new Map<string, number>();
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => {
        const calls = (callsByContents.get(contents) ?? 0) + 1;
        callsByContents.set(contents, calls);
        return {
          totalTokens:
            contents.length === 2_048 && calls > 1 ? 2_049 : contents.length,
        };
      },
    );

    await expect(
      handleTextEmbedding(createRuntime(), "x".repeat(3_000)),
    ).rejects.toMatchObject({
      code: "EMBEDDING_INPUT_TOO_LARGE",
    });
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it.each(["gemini-embedding-2", "models/gemini-embedding-2"])(
    "does not reject a %s override at the smaller 2,048 limit",
    async (model) => {
      // The same provider-tokenized input that exceeds the default model's
      // 2,048 limit remains below gemini-embedding-2's 8,192-token window.
      mocks.getEmbeddingModel.mockReturnValue(model);
      mocks.countEmbeddingTokens.mockImplementation(
        async ({ contents }: { contents: string }) => ({
          totalTokens: contents.length,
        }),
      );
      const input = "a".repeat(3_000);

      await handleTextEmbedding(createRuntime(), input);

      expect(mocks.embedContent).toHaveBeenCalledTimes(1);
      const passed = mocks.embedContent.mock.calls[0][0] as {
        model: string;
        contents: string;
      };
      expect(passed.model).toBe(model);
      expect(passed.contents.length).toBe(3_000);
      expect(
        mocks.countEmbeddingTokens.mock.calls.every(
          ([request]) => request.model === model,
        ),
      ).toBe(true);
    },
  );

  it("rejects an unmapped override above the safe 2,048-token default limit", async () => {
    // An override id not present in the limit map falls back to the safe 2,048
    // limit rather than inheriting the larger model's window.
    const model = "models/some-unknown-embedding-model";
    mocks.getEmbeddingModel.mockReturnValue(model);
    mocks.countEmbeddingTokens.mockImplementation(
      async ({ contents }: { contents: string }) => ({
        totalTokens: contents.length,
      }),
    );
    const oversized = "b".repeat(3_000);

    await expect(
      handleTextEmbedding(createRuntime(), oversized),
    ).rejects.toMatchObject({
      code: "EMBEDDING_INPUT_TOO_LARGE",
      context: { model, limit: 2_048, inputTokens: 3_000 },
    });
    expect(mocks.embedContent).not.toHaveBeenCalled();
  });

  it("fails closed when the provider tokenizer returns no valid token total", async () => {
    mocks.countEmbeddingTokens.mockResolvedValue({});

    await expect(
      handleTextEmbedding(createRuntime(), "hello"),
    ).rejects.toMatchObject({ code: "EMBEDDING_TOKEN_COUNT_INVALID" });
    expect(mocks.embedContent).not.toHaveBeenCalled();
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

  it("fails closed with one clear, model-named error on a 404 NOT_FOUND (no infinite retry spam)", async () => {
    // Regression for the text-embedding-004 v1beta 404: the raw SDK 404 must be
    // converted into a single actionable error naming the model and the
    // GOOGLE_EMBEDDING_MODEL escape hatch, not re-propagated verbatim on every
    // call.
    mocks.embedContent.mockRejectedValue(
      new Error(
        "got status: 404 NOT_FOUND. models/text-embedding-004 is not found for API version v1beta",
      ),
    );

    const promise = handleTextEmbedding(createRuntime(), "hello");
    await expect(promise).rejects.toThrow(
      "is not available on the current API version (404 NOT_FOUND)",
    );
    await expect(promise).rejects.toThrow("gemini-embedding-001");
    // Exactly one call: the handler does not retry a 404 internally.
    expect(mocks.embedContent).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite non-404 provider errors", async () => {
    mocks.embedContent.mockRejectedValue(new Error("503 UNAVAILABLE"));

    await expect(handleTextEmbedding(createRuntime(), "hello")).rejects.toThrow(
      "503 UNAVAILABLE",
    );
  });
});
