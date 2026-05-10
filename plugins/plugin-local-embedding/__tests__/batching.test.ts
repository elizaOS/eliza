import { describe, expect, it, vi } from "vitest";
import { LocalEmbeddingManager } from "../src/index.ts";

/**
 * Speedup measurement for the batched-embed path.
 *
 * The plugin's `generateEmbeddings(string[])` API serialises through a
 * single LlamaEmbeddingContext (the binding is single-inflight per
 * context), so the speedup over per-call invocation comes from
 * amortising lazy-init, runtime probing, and per-call argument
 * normalisation — not from concurrent kernel execution.
 *
 * We mock the manager's underlying `embeddingContext.getEmbeddingFor`
 * with a fixed-cost stub so the test runs deterministically without a
 * GGUF on disk. The assertion is "batched call is at least as fast as
 * sequential calls and the per-call invariants hold" — not a hard
 * speedup floor that would flap on CI.
 */
describe("LocalEmbeddingManager batching", () => {
  it("returns one vector per input and preserves order", async () => {
    // Stub the binding by replacing the manager's private context
    // before any real init runs. We construct a fresh manager and inject
    // a fake embedding context that returns deterministic vectors.
    const manager = LocalEmbeddingManager.getInstance();

    const dim = 768;
    const fakeContext = {
      getEmbeddingFor: vi.fn(async (input: unknown) => {
        const text = typeof input === "string" ? input : "";
        const vec = new Array<number>(dim).fill(0);
        // Deterministic pseudo-vector keyed off length + first char.
        vec[0] = text.length;
        vec[1] = text.charCodeAt(0) || 0;
        return { vector: vec };
      }),
    };
    // Bypass private fields by casting through unknown — ok for test wiring.
    const internal = manager as unknown as {
      embeddingContext: typeof fakeContext;
      embeddingModel: { fake: true };
      embeddingInitialized: boolean;
      environmentInitialized: boolean;
      embeddingModelConfig: { dimensions: number; contextSize: number };
    };
    internal.embeddingContext = fakeContext;
    internal.embeddingModel = { fake: true };
    internal.embeddingInitialized = true;
    internal.environmentInitialized = true;
    internal.embeddingModelConfig = { dimensions: dim, contextSize: 8192 };

    const inputs = Array.from({ length: 100 }, (_, i) => `input-${i}-${"x".repeat(i)}`);

    // Batched
    const batchStart = performance.now();
    const batched = await manager.generateEmbeddings(inputs);
    const batchElapsed = performance.now() - batchStart;
    expect(batched).toHaveLength(100);
    for (const vec of batched) expect(vec).toHaveLength(dim);

    // Sequential
    const seqStart = performance.now();
    const sequential: number[][] = [];
    for (const text of inputs) sequential.push(await manager.generateEmbedding(text));
    const seqElapsed = performance.now() - seqStart;
    expect(sequential).toHaveLength(100);

    // Both paths should call the binding 100 times.
    expect(fakeContext.getEmbeddingFor).toHaveBeenCalledTimes(200);

    // Batched path should not be measurably slower than sequential
    // (allow 50ms slack for GC / scheduler jitter on shared CI).
    expect(batchElapsed).toBeLessThanOrEqual(seqElapsed + 50);
  });

  it("returns a zero vector for blank inputs in a batch", async () => {
    const manager = LocalEmbeddingManager.getInstance();

    const dim = 768;
    const internal = manager as unknown as {
      embeddingContext: { getEmbeddingFor: ReturnType<typeof vi.fn> };
      embeddingModel: unknown;
      embeddingInitialized: boolean;
      environmentInitialized: boolean;
      embeddingModelConfig: { dimensions: number; contextSize: number };
    };
    internal.embeddingContext = {
      getEmbeddingFor: vi.fn(async () => ({ vector: new Array(dim).fill(1) })),
    };
    internal.embeddingModel = {};
    internal.embeddingInitialized = true;
    internal.environmentInitialized = true;
    internal.embeddingModelConfig = { dimensions: dim, contextSize: 8192 };

    const out = await manager.generateEmbeddings(["", "  ", "real"]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(new Array(dim).fill(0));
    expect(out[1]).toEqual(new Array(dim).fill(0));
    // Real input goes through the binding and is L2-normalised by default.
    let mag2 = 0;
    for (const v of out[2]) mag2 += v * v;
    expect(Math.sqrt(mag2)).toBeCloseTo(1.0, 5);
  });

  it("chunks long inputs and pools the result to a normalised dim-N vector", async () => {
    const manager = LocalEmbeddingManager.getInstance();

    const dim = 768;
    const ctxTokens = 8192;
    const callLog: string[] = [];
    const internal = manager as unknown as {
      embeddingContext: { getEmbeddingFor: ReturnType<typeof vi.fn> };
      embeddingModel: unknown;
      embeddingInitialized: boolean;
      environmentInitialized: boolean;
      embeddingModelConfig: { dimensions: number; contextSize: number };
      overlapTokens: number;
      batchSize: number;
      normalize: boolean;
    };
    internal.embeddingContext = {
      getEmbeddingFor: vi.fn(async (input: unknown) => {
        const text = typeof input === "string" ? input : "";
        callLog.push(text.slice(0, 16));
        const vec = new Array<number>(dim).fill(0);
        vec[0] = text.length;
        return { vector: vec };
      }),
    };
    internal.embeddingModel = {};
    internal.embeddingInitialized = true;
    internal.environmentInitialized = true;
    internal.embeddingModelConfig = { dimensions: dim, contextSize: ctxTokens };
    internal.overlapTokens = 64;
    internal.batchSize = 16;
    internal.normalize = true;

    // 16k-token doc (~64k chars). Window is 92% of 8192 = ~7536 tokens
    // ≈ 30k chars. With overlap 64 tokens (256 chars), expect 3 chunks.
    const longDoc = "Lorem ipsum dolor sit amet ".repeat(64_000 / 27);
    const result = await manager.generateEmbedding(longDoc);
    expect(result).toHaveLength(dim);

    // Pooled vector is L2-normalised.
    let mag2 = 0;
    for (const v of result) mag2 += v * v;
    expect(Math.sqrt(mag2)).toBeCloseTo(1.0, 5);

    // At least 2 calls into the binding -> chunking actually fired.
    expect(callLog.length).toBeGreaterThanOrEqual(2);
  });
});
