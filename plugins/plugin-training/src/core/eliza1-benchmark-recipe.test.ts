/**
 * Covers the Eliza-1 benchmark tier/variant vocabulary and the canonical
 * tier-sort and action-pair helpers (pure).
 */

import { describe, expect, it } from "vitest";
import {
  canonicalElizaOneTierSort,
  ELIZA_ONE_BENCHMARK_TIER_LIST,
  ELIZA_ONE_BENCHMARK_TIERS,
  elizaOneActionBenchmarkPairs,
  elizaOneBenchmarkModelId,
  normalizeElizaOneBenchmarkTier,
  parseElizaOneBenchmarkTiers,
} from "./eliza1-benchmark-recipe.js";

describe("Eliza-1 benchmark recipe", () => {
  it("exposes the canonical all-tier harness recipe", () => {
    expect(ELIZA_ONE_BENCHMARK_TIERS).toEqual(["2b", "4b", "9b", "27b"]);
    expect(ELIZA_ONE_BENCHMARK_TIER_LIST).toBe("2b,4b,9b,27b");
  });

  it("parses all, comma, newline, fallback, and duplicate tier inputs", () => {
    expect(parseElizaOneBenchmarkTiers("all")).toEqual([
      "2b",
      "4b",
      "9b",
      "27b",
    ]);
    expect(parseElizaOneBenchmarkTiers("2b,4b\n4b,9b")).toEqual([
      "2b",
      "4b",
      "9b",
    ]);
    expect(parseElizaOneBenchmarkTiers("eliza-1-2b-base,2b")).toEqual(["2b"]);
    expect(parseElizaOneBenchmarkTiers(undefined)).toEqual(["2b"]);
    expect(parseElizaOneBenchmarkTiers("", [])).toEqual([]);
  });

  it("normalizes common release and provider tier aliases", () => {
    expect(normalizeElizaOneBenchmarkTier("gemma4-e2b")).toBe("2b");
    expect(normalizeElizaOneBenchmarkTier("2B")).toBe("2b");
    expect(normalizeElizaOneBenchmarkTier("eliza-1-27b-trained")).toBe("27b");
  });

  it("builds default base/trained model IDs and pair records", () => {
    expect(elizaOneBenchmarkModelId("2b", "base")).toBe("eliza-1-2b-base");
    expect(elizaOneBenchmarkModelId("gemma4-e2b", "base")).toBe(
      "eliza-1-2b-base",
    );
    expect(elizaOneBenchmarkModelId("27b", "trained")).toBe(
      "eliza-1-27b-trained",
    );
    expect(elizaOneBenchmarkModelId("", "base")).toBeUndefined();
    expect(elizaOneActionBenchmarkPairs(["2b", "4b"])).toEqual([
      {
        tier: "2b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
      {
        tier: "4b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
    ]);
  });

  it("sorts canonical tiers from smallest to largest before unknown tiers", () => {
    expect(
      ["27b", "custom", "2b", "9b", "4b"].sort(canonicalElizaOneTierSort),
    ).toEqual(["2b", "4b", "9b", "27b", "custom"]);
  });
});
