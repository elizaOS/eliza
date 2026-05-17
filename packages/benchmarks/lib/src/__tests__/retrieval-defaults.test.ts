import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_DEFAULTS_BY_TIER,
  resolveRetrievalDefaults,
} from "../retrieval-defaults.ts";

const TIERS = ["small", "mid", "large", "frontier"] as const;

describe("RETRIEVAL_DEFAULTS_BY_TIER", () => {
  it("defines entries for all four canonical tiers", () => {
    for (const tier of TIERS) {
      expect(RETRIEVAL_DEFAULTS_BY_TIER[tier]).toBeDefined();
      expect(RETRIEVAL_DEFAULTS_BY_TIER[tier].topK).toBeGreaterThan(0);
      expect(RETRIEVAL_DEFAULTS_BY_TIER[tier].stageWeights).toBeDefined();
    }
  });

  it("has monotonically non-decreasing topK across tiers (small <= mid <= large <= frontier)", () => {
    expect(RETRIEVAL_DEFAULTS_BY_TIER.small.topK).toBeLessThanOrEqual(
      RETRIEVAL_DEFAULTS_BY_TIER.mid.topK,
    );
    expect(RETRIEVAL_DEFAULTS_BY_TIER.mid.topK).toBeLessThanOrEqual(
      RETRIEVAL_DEFAULTS_BY_TIER.large.topK,
    );
    expect(RETRIEVAL_DEFAULTS_BY_TIER.large.topK).toBeLessThanOrEqual(
      RETRIEVAL_DEFAULTS_BY_TIER.frontier.topK,
    );
  });

  it("has strictly increasing topK from small to frontier", () => {
    // We expect strict monotonicity, not just non-decreasing — if two tiers
    // ever collapse to the same topK, that's a regression.
    expect(RETRIEVAL_DEFAULTS_BY_TIER.small.topK).toBeLessThan(
      RETRIEVAL_DEFAULTS_BY_TIER.frontier.topK,
    );
  });

  it("uses positive finite weights for every declared stage", () => {
    for (const tier of TIERS) {
      const weights = RETRIEVAL_DEFAULTS_BY_TIER[tier].stageWeights;
      for (const [stage, weight] of Object.entries(weights)) {
        expect(
          Number.isFinite(weight),
          `tier=${tier} stage=${stage} weight=${weight} must be finite`,
        ).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
    }
  });

  it("up-weights exact match on small tier (high precision under tight context)", () => {
    const small = RETRIEVAL_DEFAULTS_BY_TIER.small.stageWeights;
    expect(small.exact ?? 1).toBeGreaterThan(1);
    expect(small.exact ?? 1).toBeGreaterThanOrEqual(small.embedding ?? 1);
  });

  it("does not down-weight embedding on frontier tier", () => {
    const frontier = RETRIEVAL_DEFAULTS_BY_TIER.frontier.stageWeights;
    expect(frontier.embedding ?? 1).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveRetrievalDefaults", () => {
  it("falls back to large when MODEL_TIER is unset", () => {
    const defaults = resolveRetrievalDefaults({});
    expect(defaults.topK).toBe(RETRIEVAL_DEFAULTS_BY_TIER.large.topK);
  });

  it("falls back to large on unknown MODEL_TIER", () => {
    const defaults = resolveRetrievalDefaults({ MODEL_TIER: "xl" });
    expect(defaults.topK).toBe(RETRIEVAL_DEFAULTS_BY_TIER.large.topK);
  });

  it("returns the right tier when MODEL_TIER is set", () => {
    for (const tier of TIERS) {
      const defaults = resolveRetrievalDefaults({ MODEL_TIER: tier });
      expect(defaults.topK).toBe(RETRIEVAL_DEFAULTS_BY_TIER[tier].topK);
    }
  });

  it("returns a fresh stageWeights copy on each call", () => {
    const a = resolveRetrievalDefaults({ MODEL_TIER: "small" });
    a.stageWeights.exact = 999;
    const b = resolveRetrievalDefaults({ MODEL_TIER: "small" });
    expect(b.stageWeights.exact).not.toBe(999);
    expect(RETRIEVAL_DEFAULTS_BY_TIER.small.stageWeights.exact).not.toBe(999);
  });
});
