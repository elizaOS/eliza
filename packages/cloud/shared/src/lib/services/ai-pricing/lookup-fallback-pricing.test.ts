/**
 * #11532: an uncatalogued-but-servable model must never be UNDER-billed.
 *
 * When the exact pricing row is missing, `calculateTextCostFromCatalog` used to
 * degrade the missing side to $0 — silently under-billing every request for a
 * model absent from the catalog (new releases, ingest lag). The fix falls back
 * to a CONSERVATIVE price instead: the provider's most expensive catalogued rate
 * for the same family+chargeType (an upper bound that can only over-estimate),
 * or the env default `AI_PRICING_FALLBACK_{INPUT,OUTPUT}_USD_PER_M` when the
 * provider has no rows at all. It only keeps $0 when neither source yields one.
 *
 * Both the pair lookup and the live gateway are mocked to MISS the requested
 * model, so the fallback path is exercised end to end.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// The provider has OTHER catalogued language rows (not the requested model).
// The fallback must select the MAX rate per charge type.
const providerRows: Record<string, string[]> = {
  input: ["0.000001", "0.000005"], // max input = 0.000005 /token
  output: ["0.000010", "0.000030"], // max output = 0.000030 /token
};

function rawEntry(unitPrice: string, chargeType: string) {
  return {
    billing_source: "someprovider",
    provider: "someprovider",
    model: "some-other-catalogued-model",
    product_family: "language",
    charge_type: chargeType,
    unit: "token",
    unit_price: unitPrice,
    dimensions: null,
    source_kind: "test",
    source_url: null,
    fetched_at: null,
    stale_after: null,
    priority: 0,
    is_override: false,
    metadata: null,
  };
}

let providerHasRows = true;

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    // The requested model is absent from both the pair lookup and the gateway.
    listActiveEntriesForProviderModelPairs: async () => [],
    // The provider-wide fallback query: rows only when providerHasRows.
    listActiveEntries: async (f: { chargeType?: string }) =>
      providerHasRows
        ? (providerRows[f.chargeType ?? "input"] ?? []).map((p) =>
            rawEntry(p, f.chargeType ?? "input"),
          )
        : [],
  },
}));
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog } = await import("./lookup");

const ENV_KEYS = [
  "AI_PRICING_FALLBACK_INPUT_USD_PER_M",
  "AI_PRICING_FALLBACK_OUTPUT_USD_PER_M",
] as const;

beforeEach(() => {
  providerHasRows = true;
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  providerHasRows = true;
  for (const k of ENV_KEYS) delete process.env[k];
});

test("uncatalogued model bills at the provider's MAX catalogued rate, never $0 (#11532)", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "brand-new-unlisted-model",
    provider: "someprovider",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  // base input = max input rate (0.000005) * 1e6 = 5 ; output = 0.000030 * 1e6 = 30
  expect(result.baseInputCost).toBeCloseTo(5, 4);
  expect(result.baseOutputCost).toBeCloseTo(30, 4);
  // The whole point: NOT under-billed to $0.
  expect(result.totalCost).toBeGreaterThan(0);
});

test("provider with zero catalogued rows falls back to the env default, never $0 (#11532)", async () => {
  providerHasRows = false;
  process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M = "2"; // $2 / 1e6 tok = 0.000002/tok
  process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M = "6"; // 0.000006/tok

  const result = await calculateTextCostFromCatalog({
    model: "unlisted-model",
    provider: "provider-with-no-catalog",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  expect(result.baseInputCost).toBeCloseTo(2, 4);
  expect(result.baseOutputCost).toBeCloseTo(6, 4);
  expect(result.totalCost).toBeGreaterThan(0);
});

test("no provider rows AND no env default → keeps the historical $0 (never fails the request)", async () => {
  providerHasRows = false; // and no env set (beforeEach cleared it)

  const result = await calculateTextCostFromCatalog({
    model: "unlisted-model",
    provider: "provider-with-no-catalog",
    inputTokens: 1000,
    outputTokens: 500,
  });

  // Degrades to $0 rather than throwing — request stays servable.
  expect(result.totalCost).toBe(0);
});
