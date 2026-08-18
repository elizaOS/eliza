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
  countTokens: vi.fn(),
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
  // Use the real per-model input-token-limit resolver so the truncation
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
    mocks.getEmbeddingModel.mockReturnValue("gemini-embedding-001");
    mocks.countTokens.mockResolvedValue(5);
    // gemini-embedding-001 honours outputDimensionality:768 and returns a
    // 768-length (un-normalized) vector for that request.
    mocks.embedContent.mockResolvedValue({
      embeddings: [{ values: Array(768).fill(0.5) }],
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

    expect(embedding).toHaveLength(768);
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

  it("truncates an oversized input to the default model's 2,048-token (~8,192-char) limit before the embedContent call", async () => {
    // gemini-embedding-001 documents a 2,048-token input limit. The handler must
    // slice the text to ~4 chars/token = 8,192 chars BEFORE the SDK call, so the
    // mocked embedContent never sees more than 8,192 characters for this model.
    mocks.getEmbeddingModel.mockReturnValue("gemini-embedding-001");
    const oversized = "a".repeat(20_000);

    await handleTextEmbedding(createRuntime(), oversized);

    expect(mocks.embedContent).toHaveBeenCalledTimes(1);
    const passed = mocks.embedContent.mock.calls[0][0] as {
      model: string;
      contents: string;
    };
    expect(passed.model).toBe("gemini-embedding-001");
    expect(passed.contents.length).toBe(8_192);
    expect(passed.contents).toBe("a".repeat(8_192));
  });

  it("does NOT truncate a gemini-embedding-2 override to the smaller 2,048 limit for the same input", async () => {
    // gemini-embedding-2 supports an 8,192-token window (~32,768 chars). The
    // same 20,000-char input that is cut to 8,192 chars under the default model
    // must pass through untouched here, proving the limit is model-aware and not
    // pinned to the old hardcoded boundary.
    mocks.getEmbeddingModel.mockReturnValue("gemini-embedding-2");
    const input = "a".repeat(20_000);

    await handleTextEmbedding(createRuntime(), input);

    expect(mocks.embedContent).toHaveBeenCalledTimes(1);
    const passed = mocks.embedContent.mock.calls[0][0] as {
      model: string;
      contents: string;
    };
    expect(passed.model).toBe("gemini-embedding-2");
    expect(passed.contents.length).toBe(20_000);
  });

  it("truncates an unmapped override to the safe 2,048-token default limit", async () => {
    // An override id not present in the limit map falls back to the safe 2,048
    // limit (never the larger 8,192 window), so it is cut to 8,192 chars.
    mocks.getEmbeddingModel.mockReturnValue("some-unknown-embedding-model");
    const oversized = "b".repeat(40_000);

    await handleTextEmbedding(createRuntime(), oversized);

    const passed = mocks.embedContent.mock.calls[0][0] as { contents: string };
    expect(passed.contents.length).toBe(8_192);
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
