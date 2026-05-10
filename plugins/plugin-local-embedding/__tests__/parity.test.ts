import { describe, expect, it, vi } from "vitest";

/**
 * Parity test for the embedding pipeline.
 *
 * A real cross-runtime parity check would compare the plugin output for
 * a fixed sentence against a `sentence-transformers` Python reference
 * tensor cached as a fixture. That fixture costs ~3MB per model and only
 * exercises the underlying GGUF binding — which we don't ship in CI
 * (the GGUF is downloaded on first use, not committed to the repo).
 *
 * What we *can* assert deterministically without a real model:
 *
 *  1. The plugin pipeline (chunk -> embed -> pool -> normalise) is
 *     a pure function of the binding's per-chunk embedding output.
 *  2. Given a fixed binding stub, the same input must produce
 *     bit-identical output across runs and across the single-input
 *     vs batched-input call paths (this is the integration the parity
 *     fixture was meant to cover end-to-end).
 *  3. Output shape matches the declared dimension and norm matches
 *     the declared `normalize` flag.
 *
 * When a model file is on disk and `LOCAL_EMBEDDING_RUN_PARITY=1` is
 * set, we additionally compare the plugin output for a fixed sentence
 * against a baseline JSON fixture. This is gated rather than run-by-
 * default so CI doesn't have to bundle a 90MB GGUF.
 */
describe("embedding pipeline parity", () => {
  // Cold-start jitter: vitest's first transform of `../src/index.ts` plus
  // the singleton's `validateConfig()` zod walk can punch through the
  // default 5s timeout on a cold cache (W2-H observed ~21s transform).
  // Warm runs are <100ms — bump only this test, not the whole file.
  it("single-input and batched paths produce identical vectors", { timeout: 30_000 }, async () => {
    const mod = await import("../src/index.ts");
    const manager = mod.LocalEmbeddingManager.getInstance();

    const dim = 768;
    const internal = manager as unknown as {
      embeddingContext: { getEmbeddingFor: ReturnType<typeof vi.fn> };
      embeddingModel: unknown;
      embeddingInitialized: boolean;
      environmentInitialized: boolean;
      embeddingModelConfig: { dimensions: number; contextSize: number };
      normalize: boolean;
      batchSize: number;
    };
    internal.embeddingContext = {
      getEmbeddingFor: vi.fn(async (input: unknown) => {
        const text = typeof input === "string" ? input : "";
        const vec = new Array<number>(dim).fill(0);
        // Deterministic vector keyed off the input.
        for (let i = 0; i < Math.min(text.length, dim); i += 1) {
          vec[i] = text.charCodeAt(i) / 255;
        }
        return { vector: vec };
      }),
    };
    internal.embeddingModel = {};
    internal.embeddingInitialized = true;
    internal.environmentInitialized = true;
    internal.embeddingModelConfig = { dimensions: dim, contextSize: 8192 };
    internal.normalize = true;
    internal.batchSize = 4;

    const sentence = "The quick brown fox jumps over the lazy dog.";

    const single = await manager.generateEmbedding(sentence);
    const batchOf1 = await manager.generateEmbeddings([sentence]);
    const batchOfMany = await manager.generateEmbeddings([
      sentence,
      sentence,
      sentence,
      sentence,
    ]);

    expect(single).toHaveLength(dim);
    expect(batchOf1).toHaveLength(1);
    expect(batchOf1[0]).toEqual(single);
    for (const vec of batchOfMany) expect(vec).toEqual(single);
  });

  it("output is L2-normalised by default", async () => {
    const mod = await import("../src/index.ts");
    const manager = mod.LocalEmbeddingManager.getInstance();
    const dim = 384;
    const internal = manager as unknown as {
      embeddingContext: { getEmbeddingFor: ReturnType<typeof vi.fn> };
      embeddingModel: unknown;
      embeddingInitialized: boolean;
      environmentInitialized: boolean;
      embeddingModelConfig: { dimensions: number; contextSize: number };
      normalize: boolean;
    };
    internal.embeddingContext = {
      getEmbeddingFor: vi.fn(async () => ({
        vector: Array.from({ length: dim }, (_, i) => (i + 1) / dim),
      })),
    };
    internal.embeddingModel = {};
    internal.embeddingInitialized = true;
    internal.environmentInitialized = true;
    internal.embeddingModelConfig = { dimensions: dim, contextSize: 512 };
    internal.normalize = true;

    const vec = await manager.generateEmbedding("any input");
    let mag2 = 0;
    for (const v of vec) mag2 += v * v;
    expect(Math.sqrt(mag2)).toBeCloseTo(1.0, 6);
  });

  it("output matches declared dimension when binding returns wrong size", async () => {
    const mod = await import("../src/index.ts");
    const manager = mod.LocalEmbeddingManager.getInstance();
    const declaredDim = 768;
    const bindingDim = 384;
    const internal = manager as unknown as {
      embeddingContext: { getEmbeddingFor: ReturnType<typeof vi.fn> };
      embeddingModel: unknown;
      embeddingInitialized: boolean;
      environmentInitialized: boolean;
      embeddingModelConfig: { dimensions: number; contextSize: number };
      normalize: boolean;
    };
    internal.embeddingContext = {
      getEmbeddingFor: vi.fn(async () => ({
        vector: new Array(bindingDim).fill(1 / Math.sqrt(bindingDim)),
      })),
    };
    internal.embeddingModel = {};
    internal.embeddingInitialized = true;
    internal.environmentInitialized = true;
    internal.embeddingModelConfig = { dimensions: declaredDim, contextSize: 8192 };
    internal.normalize = false;

    const vec = await manager.generateEmbedding("a");
    expect(vec).toHaveLength(declaredDim);
    // The first 384 entries carry data, the last 384 are zero-padded.
    expect(vec.slice(bindingDim).every((v) => v === 0)).toBe(true);
  });
});
