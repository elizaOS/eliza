/**
 * Uncatalogued-but-servable models must bill at a conservative fallback rate.
 *
 * A model id can be servable before its price lands in the pricing catalog
 * (newly released ids, catalog ingest lag). Failing the request at billing was
 * the original bug; degrading to $0 (the interim behavior) silently
 * under-bills. The contract under test:
 *
 *   1. Catalogued models bill at their exact catalog rate — unchanged.
 *   2. An unknown model from a catalogued provider bills at that provider's
 *      MOST EXPENSIVE catalogued token rate (upper bound — never under-bills).
 *   3. A provider with no catalogued entries falls back to the env-configured
 *      defaults AI_PRICING_FALLBACK_INPUT_USD_PER_M /
 *      AI_PRICING_FALLBACK_OUTPUT_USD_PER_M.
 *   4. With no catalog and no env default, the request stays servable at $0
 *      (last resort; covered in lookup-missing-pricing.test.ts as well).
 *   5. Reserve (estimated tokens) and settle (actual tokens) resolve the same
 *      fallback rate, so billing stays consistent across the request.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const USD_PER_M = 1_000_000;

function catalogRow(model: string, chargeType: "input" | "output", usdPerMillion: number) {
  return {
    billing_source: "bitrouter",
    provider: "anthropic",
    model,
    product_family: "language",
    charge_type: chargeType,
    unit: "token",
    unit_price: String(usdPerMillion / USD_PER_M),
    dimensions: {},
    source_kind: "bitrouter_catalog",
    source_url: "https://example.test/catalog",
    fetched_at: new Date(),
    stale_after: null,
    priority: 200,
    is_override: false,
    metadata: {},
  };
}

// Current-generation public models with their per-million-token USD rates.
const seedCatalog = [
  catalogRow("anthropic/claude-opus-4-8", "input", 5),
  catalogRow("anthropic/claude-opus-4-8", "output", 25),
  catalogRow("anthropic/claude-sonnet-5", "input", 3),
  catalogRow("anthropic/claude-sonnet-5", "output", 15),
  catalogRow("anthropic/claude-haiku-4-5", "input", 1),
  catalogRow("anthropic/claude-haiku-4-5", "output", 5),
];

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async (filters: {
      billingSource: string;
      productFamily: string;
      chargeType: string;
      pairs: readonly { provider: string; model: string }[];
    }) =>
      seedCatalog.filter(
        (row) =>
          row.billing_source === filters.billingSource &&
          row.product_family === filters.productFamily &&
          row.charge_type === filters.chargeType &&
          filters.pairs.some((p) => p.provider === row.provider && p.model === row.model),
      ),
    listActiveEntries: async (filters?: {
      billingSource?: string;
      provider?: string;
      productFamily?: string;
      chargeType?: string;
    }) =>
      seedCatalog.filter(
        (row) =>
          (!filters?.billingSource || row.billing_source === filters.billingSource) &&
          (!filters?.provider || row.provider === filters.provider) &&
          (!filters?.productFamily || row.product_family === filters.productFamily) &&
          (!filters?.chargeType || row.charge_type === filters.chargeType),
      ),
  },
}));
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog } = await import("./lookup");
const { __clearPersistedPricingCache } = await import("./cache");

beforeEach(() => {
  __clearPersistedPricingCache();
  delete process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M;
  delete process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M;
});

afterEach(() => {
  delete process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M;
  delete process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M;
});

test("catalogued current-generation models bill at their exact catalog rate", async () => {
  // Expected values are Decimal-exact (catalog rate × 1M tokens, +20% markup),
  // written as literals because JS float math (e.g. 3 * 1.2) drifts.
  const cases = [
    // [model, inputCost, outputCost, totalCost, baseTotalCost]
    ["claude-opus-4-8", 6, 30, 36, 30],
    ["claude-sonnet-5", 3.6, 18, 21.6, 18],
    ["claude-haiku-4-5", 1.2, 6, 7.2, 6],
  ] as const;

  for (const [model, inputCost, outputCost, totalCost, baseTotalCost] of cases) {
    const result = await calculateTextCostFromCatalog({
      model,
      provider: "anthropic",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(result.inputCost).toBe(inputCost);
    expect(result.outputCost).toBe(outputCost);
    expect(result.totalCost).toBe(totalCost);
    expect(result.baseTotalCost).toBe(baseTotalCost);
  }
});

test("unknown model from a catalogued provider bills at the provider's most expensive rate", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "claude-unknown-test-9",
    provider: "anthropic",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  // Provider max = the $5/M-in $25/M-out entry. Never $0, never a throw.
  expect(result.inputCost).toBe(5 * 1.2);
  expect(result.outputCost).toBe(25 * 1.2);
  expect(result.totalCost).toBe(30 * 1.2);
  expect(result.totalCost).toBeGreaterThan(0);
});

test("reserve-style and settle-style calls resolve the same fallback rate", async () => {
  // Pre-flight reserve estimates tokens; settle uses actual usage. Both flow
  // through calculateTextCostFromCatalog, so the resolved rate must be equal.
  const reserve = await calculateTextCostFromCatalog({
    model: "claude-unknown-test-9",
    provider: "anthropic",
    inputTokens: 2_000,
    outputTokens: 500,
  });
  const settle = await calculateTextCostFromCatalog({
    model: "claude-unknown-test-9",
    provider: "anthropic",
    inputTokens: 1_234,
    outputTokens: 987,
  });

  // Provider-max rate: $5/M input, $25/M output (Decimal-exact base costs).
  expect(reserve.baseInputCost).toBe(0.01); // 2_000 × 5e-6
  expect(reserve.baseOutputCost).toBe(0.0125); // 500 × 25e-6
  expect(settle.baseInputCost).toBe(0.00617); // 1_234 × 5e-6
  expect(settle.baseOutputCost).toBe(0.024675); // 987 × 25e-6
});

test("env-configured default applies when the provider has no catalogued entries", async () => {
  process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M = "2.5";
  process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M = "10";

  const result = await calculateTextCostFromCatalog({
    model: "mystery-model-1",
    provider: "someprovider",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  expect(result.baseInputCost).toBe(2.5);
  expect(result.baseOutputCost).toBe(10);
  expect(result.totalCost).toBe(12.5 * 1.2);
});

test("invalid env default is ignored (falls through to $0 last resort)", async () => {
  process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M = "not-a-number";
  process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M = "-4";

  const result = await calculateTextCostFromCatalog({
    model: "mystery-model-1",
    provider: "someprovider",
    inputTokens: 1_000,
    outputTokens: 1_000,
  });

  expect(result.totalCost).toBe(0);
});

test("no catalog and no env default keeps the request servable at $0", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "mystery-model-1",
    provider: "someprovider",
    inputTokens: 1_000,
    outputTokens: 1_000,
  });

  expect(result.inputCost).toBe(0);
  expect(result.outputCost).toBe(0);
  expect(result.totalCost).toBe(0);
});
