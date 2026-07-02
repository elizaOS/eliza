/**
 * Regression: a missing price must (1) NOT throw a 500 and (2) NEVER bill $0.
 *
 * `calculateTextCostFromCatalog` once left the input-price lookup unguarded, so
 * a catalog miss threw `Pricing unavailable for language:input <model>` → a 500
 * / masked "bridge unreachable". That was fixed by degrading a miss to a
 * fallback rate — but the last-resort tier was `?? 0`, so a servable model with
 * no catalog row AND no `AI_PRICING_FALLBACK_*` env default billed **$0** = free
 * inference / uncollected revenue (#11635).
 *
 * Both seams (persisted repo + live gateway) are mocked empty so EVERY lookup
 * misses — the worst case — and no env fallback is set, so the last-resort tier
 * is exercised. Post-#11635 it bills a conservative non-zero frontier-max rate
 * (`lastResortTokenUnitPrice`), keyed by product family, and still never throws.
 * (Provider-max / env-default tiers are covered in lookup-fallback-pricing.test.ts.)
 */
import { beforeEach, expect, mock, test } from "bun:test";

const warnSpy = mock(() => {});

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async () => [],
    listActiveEntries: async () => [],
  },
}));
mock.module("../../utils/logger", () => ({
  logger: {
    warn: warnSpy,
  },
}));
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog } = await import("./lookup");

beforeEach(() => {
  warnSpy.mockClear();
});

test("missing language pricing bills a non-zero last-resort rate, never $0 (#11635)", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "totally-uncatalogued-model",
    provider: "someprovider",
    inputTokens: 1000,
    outputTokens: 500,
  });

  // Never throws (the original 500-degradation) AND never $0 (the #11635 fix):
  // 1000in@$5/M + 500out@$25/M ≈ $0.0175 base + markup — a small, sane amount.
  expect(result.inputCost).toBeGreaterThan(0);
  expect(result.outputCost).toBeGreaterThan(0);
  expect(result.totalCost).toBeGreaterThan(0);
  expect(result.totalCost).toBeLessThan(0.1); // sane: not an absurd rate
  expect(warnSpy.mock.calls).toContainEqual([
    "ai-pricing: input pricing unavailable; billing at fallback rate",
    {
      canonicalModel: "someprovider/totally-uncatalogued-model",
      provider: "someprovider",
      billingSource: undefined,
      fallbackSource: "last_resort",
      fallbackUnitPrice: 0.000005,
    },
  ]);
  expect(warnSpy.mock.calls).toContainEqual([
    "ai-pricing: output pricing unavailable; billing at fallback rate",
    {
      canonicalModel: "someprovider/totally-uncatalogued-model",
      provider: "someprovider",
      billingSource: undefined,
      fallbackSource: "last_resort",
      fallbackUnitPrice: 0.000025,
    },
  ]);
});

test("missing embedding pricing bills the cheaper embedding last-resort rate, non-zero (#11635)", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "uncatalogued-embedding-model",
    provider: "someprovider",
    inputTokens: 800,
    outputTokens: 0,
  });

  // Non-zero (never free) but keyed to the embedding family ($0.2/M), so 800
  // tokens is a tiny amount — proving the family keying picked the cheap rate,
  // not the $5/M language default.
  expect(result.inputCost).toBeGreaterThan(0);
  expect(result.totalCost).toBeGreaterThan(0);
  expect(result.totalCost).toBeLessThan(0.001);
});
