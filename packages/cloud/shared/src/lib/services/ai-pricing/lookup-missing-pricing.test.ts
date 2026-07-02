/**
 * Regression: a missing INPUT price must degrade to $0, not throw a 500.
 *
 * `calculateTextCostFromCatalog` previously left the input-price lookup
 * unguarded while the output lookup was `.catch(() => null)`. A catalog miss on
 * the input row therefore threw `Pricing unavailable for language:input <model>`
 * uncaught, which propagated through `calculateCost` → the chat-completions
 * credit reserve → a 500 / masked "bridge unreachable". This is especially easy
 * to hit with embedding models (input-only, and embedded on every turn) or any
 * model whose input row simply isn't catalogued yet.
 *
 * Both seams (persisted repo + live gateway) are mocked empty so EVERY lookup
 * misses — the worst case. With no provider catalog entries and no
 * AI_PRICING_FALLBACK_{INPUT,OUTPUT}_USD_PER_M env defaults, the last-resort
 * behavior bills the missing side at $0 instead of failing the request.
 * (When the provider HAS catalogued entries, or the env defaults are set, the
 * miss bills at a conservative fallback rate instead — covered in
 * lookup-fallback-pricing.test.ts.)
 */
import { expect, mock, test } from "bun:test";

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async () => [],
    listActiveEntries: async () => [],
  },
}));
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog } = await import("./lookup");

test("missing input pricing degrades to $0 instead of throwing a 500", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "totally-uncatalogued-model",
    provider: "someprovider",
    inputTokens: 1000,
    outputTokens: 500,
  });

  // Before the fix this rejected with "Pricing unavailable for language:input …".
  expect(result.inputCost).toBe(0);
  expect(result.outputCost).toBe(0);
  expect(result.totalCost).toBe(0);
});

test("missing input pricing for an input-only embedding model does not throw", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "uncatalogued-embedding-model",
    provider: "someprovider",
    inputTokens: 800,
    outputTokens: 0,
  });

  expect(result.inputCost).toBe(0);
  expect(result.totalCost).toBe(0);
});
