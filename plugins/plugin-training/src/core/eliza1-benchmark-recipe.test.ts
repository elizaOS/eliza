import { describe, expect, it } from "vitest";
import {
  ELIZA_ONE_BENCHMARK_TIER_LIST,
  ELIZA_ONE_BENCHMARK_TIERS,
  elizaOneActionBenchmarkPairs,
  elizaOneBenchmarkModelId,
  canonicalElizaOneTierSort,
  normalizeElizaOneBenchmarkTier,
  parseElizaOneBenchmarkTiers,
} from "./eliza1-benchmark-recipe.js";

describe("Eliza-1 benchmark recipe", () => {
  it("exposes the canonical all-tier harness recipe", () => {
    expect(ELIZA_ONE_BENCHMARK_TIERS).toEqual([
      "0_8b",
      "2b",
      "4b",
      "9b",
      "27b",
    ]);
    expect(ELIZA_ONE_BENCHMARK_TIER_LIST).toBe("0_8b,2b,4b,9b,27b");
  });

  it("parses all, comma, newline, fallback, and duplicate tier inputs", () => {
    expect(parseElizaOneBenchmarkTiers("all")).toEqual([
      "0_8b",
      "2b",
      "4b",
      "9b",
      "27b",
    ]);
    expect(parseElizaOneBenchmarkTiers("0_8b,2b\n2b,4b")).toEqual([
      "0_8b",
      "2b",
      "4b",
    ]);
    expect(parseElizaOneBenchmarkTiers("qwen3.5-0.8b,0.8b,0b")).toEqual([
      "0_8b",
    ]);
    expect(parseElizaOneBenchmarkTiers(undefined)).toEqual(["0_8b"]);
    expect(parseElizaOneBenchmarkTiers("", [])).toEqual([]);
  });

  it("normalizes common release and provider tier aliases", () => {
    expect(normalizeElizaOneBenchmarkTier("qwen3.5-0.8b")).toBe("0_8b");
    expect(normalizeElizaOneBenchmarkTier("0.8B")).toBe("0_8b");
    expect(normalizeElizaOneBenchmarkTier("0b")).toBe("0_8b");
    expect(normalizeElizaOneBenchmarkTier("eliza-1-27b-trained")).toBe("27b");
  });

  it("builds default base/trained model IDs and pair records", () => {
    expect(elizaOneBenchmarkModelId("0_8b", "base")).toBe("eliza-1-0_8b-base");
    expect(elizaOneBenchmarkModelId("qwen3.5-0.8b", "base")).toBe(
      "eliza-1-0_8b-base",
    );
    expect(elizaOneBenchmarkModelId("27b", "trained")).toBe(
      "eliza-1-27b-trained",
    );
    expect(elizaOneBenchmarkModelId("", "base")).toBeUndefined();
    expect(elizaOneActionBenchmarkPairs(["0_8b", "2b"])).toEqual([
      {
        tier: "0_8b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
      {
        tier: "2b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
    ]);
  });

  it("sorts canonical tiers from smallest to largest before unknown tiers", () => {
    expect(
      ["27b", "custom", "2b", "0_8b", "9b", "4b"].sort(
        canonicalElizaOneTierSort,
      ),
    ).toEqual(["0_8b", "2b", "4b", "9b", "27b", "custom"]);
  });
});
