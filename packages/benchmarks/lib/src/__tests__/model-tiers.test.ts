import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIERS,
  isModelTier,
  resolveTier,
} from "../model-tiers.ts";

describe("resolveTier", () => {
  it("returns the large tier by default when no MODEL_TIER is set", () => {
    const spec = resolveTier({});
    expect(spec.tier).toBe("large");
    expect(spec.provider).toBe("cerebras");
    expect(spec.modelName).toBe("gpt-oss-120b");
    expect(spec.baseUrl).toBe("https://api.cerebras.ai/v1");
  });

  it("returns the small tier when MODEL_TIER=small", () => {
    const spec = resolveTier({ MODEL_TIER: "small" });
    expect(spec.tier).toBe("small");
    expect(spec.provider).toBe("local-llama-cpp");
    expect(spec.modelName).toBe("qwen3-0.6b-q8_0");
    expect(spec.bundlePath).toContain("eliza-1-0.6b.bundle");
  });

  it("returns the mid tier when MODEL_TIER=mid", () => {
    const spec = resolveTier({ MODEL_TIER: "mid" });
    expect(spec.tier).toBe("mid");
    expect(spec.modelName).toBe("qwen3-1.7b-q4_k_m");
    expect(spec.contextWindow).toBe(65_536);
  });

  it("returns the frontier tier when MODEL_TIER=frontier", () => {
    const spec = resolveTier({ MODEL_TIER: "frontier" });
    expect(spec.provider).toBe("anthropic");
    expect(spec.modelName).toBe("claude-opus-4-7");
    expect(spec.contextWindow).toBe(200_000);
  });

  it("falls back to large for unknown tier strings", () => {
    const spec = resolveTier({ MODEL_TIER: "bogus" });
    expect(spec.tier).toBe("large");
  });

  it("applies MODEL_NAME_OVERRIDE", () => {
    const spec = resolveTier({
      MODEL_TIER: "small",
      MODEL_NAME_OVERRIDE: "qwen3-0.6b-q4_k_s",
    });
    expect(spec.modelName).toBe("qwen3-0.6b-q4_k_s");
  });

  it("applies MODEL_BASE_URL_OVERRIDE", () => {
    const spec = resolveTier({
      MODEL_TIER: "large",
      MODEL_BASE_URL_OVERRIDE: "http://localhost:9999/v1",
    });
    expect(spec.baseUrl).toBe("http://localhost:9999/v1");
  });

  it("applies MODEL_BUNDLE_OVERRIDE", () => {
    const spec = resolveTier({
      MODEL_TIER: "mid",
      MODEL_BUNDLE_OVERRIDE: "/custom/bundle.gguf",
    });
    expect(spec.bundlePath).toBe("/custom/bundle.gguf");
  });

  it("does not mutate the DEFAULT_TIERS registry on override", () => {
    resolveTier({
      MODEL_TIER: "small",
      MODEL_NAME_OVERRIDE: "mutated",
    });
    expect(DEFAULT_TIERS.small.modelName).toBe("qwen3-0.6b-q8_0");
  });
});

describe("isModelTier", () => {
  it("accepts all four canonical tiers", () => {
    expect(isModelTier("small")).toBe(true);
    expect(isModelTier("mid")).toBe(true);
    expect(isModelTier("large")).toBe(true);
    expect(isModelTier("frontier")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isModelTier("xl")).toBe(false);
    expect(isModelTier(null)).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
    expect(isModelTier(42)).toBe(false);
  });
});
