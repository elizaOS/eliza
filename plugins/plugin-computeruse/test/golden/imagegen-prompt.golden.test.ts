/**
 * WS10 golden path: text prompt → arbiter loads diffusion → returns PNG.
 *
 * Validates PLUMBING for the image-gen flow. The diffusion backend is
 * replaced with a deterministic stub that emits a fixed PNG fixture; the
 * test asserts on the PNG signature + size, not on pixel content. The
 * arbiter contract being stubbed:
 *
 *   1. Caller requests image-gen for a prompt.
 *   2. Arbiter resolves the per-tier default diffusion model from
 *      ELIZA_1_BUNDLE_EXTRAS.json.
 *   3. Arbiter loads (or no-ops if already resident) the diffusion
 *      weights.
 *   4. Arbiter calls the diffusion runtime, receives PNG bytes, returns
 *      them to the caller.
 *
 * When WS3 (arbiter) + WS5 (image-gen pipeline) land, the stub becomes
 * the integration contract.
 */

import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------- */
/* Stub contracts                                                         */
/* --------------------------------------------------------------------- */

interface ImageGenRequest {
  prompt: string;
  tier: string;
  width?: number;
  height?: number;
}

interface ImageGenResult {
  png: Buffer;
  width: number;
  height: number;
  modelId: string;
  durationMs: number;
}

interface ArbiterImageGen {
  resolveModelId(tier: string): { modelId: string; file: string };
  ensureLoaded(modelId: string): { loaded: boolean; modelId: string };
  generate(req: ImageGenRequest): ImageGenResult;
}

/* --------------------------------------------------------------------- */
/* Deterministic stub                                                     */
/* --------------------------------------------------------------------- */

const ONE_PX_PNG: Buffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

const PER_TIER_DEFAULT: Record<string, { modelId: string; file: string }> = {
  "eliza-1-0_8b": {
    modelId: "imagegen-sd-1_5-q5_0",
    file: "imagegen/sd-1.5-Q5_0.gguf",
  },
  "eliza-1-2b": {
    modelId: "imagegen-sd-1_5-q5_0",
    file: "imagegen/sd-1.5-Q5_0.gguf",
  },
  "eliza-1-4b": {
    modelId: "imagegen-sd-1_5-q5_0",
    file: "imagegen/sd-1.5-Q5_0.gguf",
  },
  "eliza-1-9b": {
    modelId: "imagegen-z-image-turbo-q4_k_m",
    file: "imagegen/z-image-turbo-Q4_K_M.gguf",
  },
  "eliza-1-27b": {
    modelId: "imagegen-z-image-turbo-q4_k_m",
    file: "imagegen/z-image-turbo-Q4_K_M.gguf",
  },
  "eliza-1-27b-256k": {
    modelId: "imagegen-z-image-turbo-q4_k_m",
    file: "imagegen/z-image-turbo-Q4_K_M.gguf",
  },
};

function stubArbiter(): ArbiterImageGen {
  const loaded = new Set<string>();
  return {
    resolveModelId(tier: string) {
      const entry = PER_TIER_DEFAULT[tier];
      if (!entry) throw new Error(`stub-arbiter: unknown tier "${tier}"`);
      return entry;
    },
    ensureLoaded(modelId: string) {
      if (loaded.has(modelId)) return { loaded: true, modelId };
      loaded.add(modelId);
      return { loaded: true, modelId };
    },
    generate(req: ImageGenRequest) {
      if (!req.prompt || req.prompt.trim().length === 0) {
        throw new Error("stub-arbiter: empty prompt");
      }
      return {
        png: ONE_PX_PNG,
        width: req.width ?? 512,
        height: req.height ?? 512,
        modelId: PER_TIER_DEFAULT[req.tier]?.modelId ?? "imagegen-sd-1_5-q5_0",
        durationMs: 42,
      };
    },
  };
}

/* --------------------------------------------------------------------- */
/* Test                                                                   */
/* --------------------------------------------------------------------- */

describe("golden path: prompt → arbiter image-gen → PNG bytes", () => {
  it("returns a valid PNG buffer for a non-empty prompt on a mobile tier", () => {
    const arbiter = stubArbiter();
    const resolved = arbiter.resolveModelId("eliza-1-2b");
    expect(resolved.modelId).toBe("imagegen-sd-1_5-q5_0");
    expect(resolved.file).toBe("imagegen/sd-1.5-Q5_0.gguf");

    const loadResult = arbiter.ensureLoaded(resolved.modelId);
    expect(loadResult.loaded).toBe(true);
    expect(loadResult.modelId).toBe(resolved.modelId);

    const result = arbiter.generate({
      prompt: "a smiling cat in a meadow",
      tier: "eliza-1-2b",
    });
    expect(isPng(result.png)).toBe(true);
    expect(result.png.length).toBeGreaterThan(8); // signature + at least one chunk
    expect(result.width).toBe(512);
    expect(result.height).toBe(512);
    expect(result.modelId).toBe("imagegen-sd-1_5-q5_0");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("resolves to z-image-turbo on a desktop-class tier", () => {
    const arbiter = stubArbiter();
    const resolved = arbiter.resolveModelId("eliza-1-9b");
    expect(resolved.modelId).toBe("imagegen-z-image-turbo-q4_k_m");
    expect(resolved.file).toBe("imagegen/z-image-turbo-Q4_K_M.gguf");
  });

  it("rejects an empty prompt deterministically", () => {
    const arbiter = stubArbiter();
    expect(() => arbiter.generate({ prompt: "", tier: "eliza-1-2b" })).toThrow(
      /empty prompt/,
    );
    expect(() =>
      arbiter.generate({ prompt: "   ", tier: "eliza-1-2b" }),
    ).toThrow(/empty prompt/);
  });

  it("rejects an unknown tier deterministically", () => {
    const arbiter = stubArbiter();
    expect(() => arbiter.resolveModelId("eliza-1-unknown")).toThrow(
      /unknown tier/,
    );
  });
});
