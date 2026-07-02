/**
 * Regression: a missing price must never bill $0 or a guessed hardcoded floor.
 *
 * `calculateTextCostFromCatalog` once left the input-price lookup unguarded, so
 * a catalog miss threw `Pricing unavailable for language:input <model>` → a 500
 * / masked "bridge unreachable". That was fixed by degrading a miss to a
 * fallback rate — but the last-resort tier was `?? 0`, so a servable model with
 * no catalog row AND no `AI_PRICING_FALLBACK_*` env default billed **$0** = free
 * inference / uncollected revenue (#11635).
 *
 * Both seams (persisted repo + live gateway) are mocked empty so EVERY lookup
 * misses — the worst case — and no env fallback is set. Post-#11635, a non-zero
 * token side rejects so we do not sell inference we do not know how to price.
 * Provider-max and env-default fallback tiers are covered in
 * lookup-fallback-pricing.test.ts.
 */
import { beforeEach, expect, mock, test } from "bun:test";

const warnSpy = mock(() => {});
const errorSpy = mock(() => {});

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async () => [],
    listActiveEntries: async () => [],
  },
}));
mock.module("../../utils/logger", () => ({
  logger: {
    warn: warnSpy,
    error: errorSpy,
  },
}));
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog } = await import("./lookup");

beforeEach(() => {
  warnSpy.mockClear();
  errorSpy.mockClear();
});

test("missing language pricing rejects instead of billing an unknown price (#11635)", async () => {
  await expect(
    calculateTextCostFromCatalog({
      model: "totally-uncatalogued-model",
      provider: "someprovider",
      inputTokens: 1000,
      outputTokens: 500,
    }),
  ).rejects.toThrow("refusing to bill unknown-priced inference");

  expect(errorSpy.mock.calls).toContainEqual([
    "ai-pricing: missing token price with no fallback; refusing request",
    {
      canonicalModel: "someprovider/totally-uncatalogued-model",
      provider: "someprovider",
      billingSource: undefined,
      productFamily: "language",
      chargeType: "input",
      tokens: 1000,
    },
  ]);
  expect(warnSpy.mock.calls).toHaveLength(0);
});

test("missing input-only embedding pricing rejects instead of billing an unknown price (#11635)", async () => {
  await expect(
    calculateTextCostFromCatalog({
      model: "uncatalogued-embedding-model",
      provider: "someprovider",
      inputTokens: 800,
      outputTokens: 0,
    }),
  ).rejects.toThrow("refusing to bill unknown-priced inference");

  expect(errorSpy.mock.calls).toContainEqual([
    "ai-pricing: missing token price with no fallback; refusing request",
    {
      canonicalModel: "someprovider/uncatalogued-embedding-model",
      provider: "someprovider",
      billingSource: undefined,
      productFamily: "embedding",
      chargeType: "input",
      tokens: 800,
    },
  ]);
  expect(warnSpy.mock.calls).toHaveLength(0);
});
