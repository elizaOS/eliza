/**
 * Regression (#13415 fallback-slop): a corrupt persisted catalog price must
 * never bill a NaN charge through the cost boundary.
 *
 * `aiEntryToPrepared` reads `unitPrice = Number(entry.unit_price)` over a
 * Postgres NUMERIC column; a corrupt row (`'NaN'::numeric` reads back as
 * "NaN") yields `unitPrice: NaN`. Before the fix, such an entry could reach
 * `asDecimal(entry.unitPrice).mul(quantity)` (flat path) or
 * `asDecimal(inputEntry.unitPrice)` (token path) and produce a `NaN` cost that
 * silently poisons the credit debit / earnings ledger.
 *
 * The fix (a) filters non-finite prices out of candidate selection so a corrupt
 * row can't be chosen, degrading the token side to the provider-max/env
 * fallback tier, and (b) fails closed with an explicit error at the flat-cost
 * boundary if a corrupt price ever reaches it. Both are exercised here.
 *
 * Both DB seams are mocked; the gateway (live) seam is emptied so only the
 * seeded persisted catalog is in play.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const USD_PER_M = 1_000_000;

type CatalogRow = {
  billing_source: string;
  provider: string;
  model: string;
  product_family: string;
  charge_type: string;
  unit: string;
  unit_price: string;
  dimensions: Record<string, unknown>;
  source_kind: string;
  source_url: string;
  fetched_at: Date;
  stale_after: Date | null;
  priority: number;
  is_override: boolean;
  metadata: Record<string, unknown>;
};

function row(
  model: string,
  chargeType: "input" | "output" | "generation",
  productFamily: string,
  unit: string,
  unitPrice: string,
): CatalogRow {
  return {
    billing_source: "bitrouter",
    provider: "anthropic",
    model,
    product_family: productFamily,
    charge_type: chargeType,
    unit,
    unit_price: unitPrice,
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

// The exact-model rows for the model under test carry a CORRUPT price ("NaN").
// A SEPARATE valid, more-expensive model exists for the same provider so the
// provider-max fallback tier has a real rate to fall back to for the token
// path.
const seedCatalog: CatalogRow[] = [
  // corrupt exact-model rows
  row("anthropic/corrupt-priced-model", "input", "language", "token", "NaN"),
  row("anthropic/corrupt-priced-model", "output", "language", "token", "NaN"),
  // valid fallback rows for the same provider (provider-max upper bound)
  row("anthropic/claude-opus-4-8", "input", "language", "token", String(5 / USD_PER_M)),
  row("anthropic/claude-opus-4-8", "output", "language", "token", String(25 / USD_PER_M)),
  // a corrupt flat (image:generation) row with NO valid sibling -> flat boundary
  row("anthropic/corrupt-image", "generation", "image", "image", "NaN"),
  row("anthropic/valid-image", "generation", "image", "image", "0.05"),
];

function matchProviderModelPairs(filters: {
  billingSource?: string;
  productFamily?: string;
  chargeType?: string;
  pairs: readonly { provider: string; model: string }[];
}): CatalogRow[] {
  return seedCatalog.filter(
    (r) =>
      (!filters.billingSource || r.billing_source === filters.billingSource) &&
      (!filters.productFamily || r.product_family === filters.productFamily) &&
      (!filters.chargeType || r.charge_type === filters.chargeType) &&
      filters.pairs.some((p) => p.provider === r.provider && p.model === r.model),
  );
}

function matchListActive(filters?: {
  billingSource?: string;
  provider?: string;
  productFamily?: string;
  chargeType?: string;
  model?: string;
}): CatalogRow[] {
  return seedCatalog.filter(
    (r) =>
      (!filters?.billingSource || r.billing_source === filters.billingSource) &&
      (!filters?.provider || r.provider === filters.provider) &&
      (!filters?.productFamily || r.product_family === filters.productFamily) &&
      (!filters?.chargeType || r.charge_type === filters.chargeType) &&
      (!filters?.model || r.model === filters.model),
  );
}

const errorSpy = mock((..._args: unknown[]) => {});

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async (
      filters: Parameters<typeof matchProviderModelPairs>[0],
    ) => matchProviderModelPairs(filters),
    listActiveEntries: async (filters?: Parameters<typeof matchListActive>[0]) =>
      matchListActive(filters),
  },
}));
mock.module("../../utils/logger", () => ({
  logger: {
    warn: mock(() => {}),
    error: errorSpy,
  },
}));
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog, calculateImageGenerationCostFromCatalog } = await import(
  "./lookup"
);
const { __clearPersistedPricingCache } = await import("./cache");

beforeEach(() => {
  __clearPersistedPricingCache();
  delete process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M;
  delete process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M;
  errorSpy.mockClear();
});

afterEach(() => {
  delete process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M;
  delete process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M;
});

test("token path: a corrupt exact-model price degrades to provider-max fallback, never NaN", async () => {
  const result = await calculateTextCostFromCatalog({
    model: "corrupt-priced-model",
    provider: "anthropic",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  // The corrupt exact-model rows are dropped at selection, so the token side
  // falls back to the provider's MOST EXPENSIVE catalogued rate (claude-opus
  // input 5 / output 25 per million) + 20% markup — a REAL, finite charge.
  expect(Number.isFinite(result.inputCost)).toBe(true);
  expect(Number.isFinite(result.outputCost)).toBe(true);
  expect(Number.isFinite(result.totalCost)).toBe(true);
  expect(result.inputCost).toBe(6); // 5 * 1M * 1.2
  expect(result.outputCost).toBe(30); // 25 * 1M * 1.2
});

test("token path: corrupt exact price + NO valid fallback + no env default => fails closed (never $0/NaN)", async () => {
  // Isolate a provider whose ONLY row is corrupt so there is no provider-max
  // fallback either. A non-zero token side must refuse, not bill NaN or $0.
  const onlyCorrupt: CatalogRow[] = [
    row("solo/only-corrupt", "input", "language", "token", "NaN"),
    row("solo/only-corrupt", "output", "language", "token", "NaN"),
  ];
  onlyCorrupt.forEach((r) => {
    r.provider = "solo";
  });
  seedCatalog.push(...onlyCorrupt);
  try {
    __clearPersistedPricingCache();
    await expect(
      calculateTextCostFromCatalog({
        model: "only-corrupt",
        provider: "solo",
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).rejects.toThrow("refusing to bill unknown-priced inference");
  } finally {
    seedCatalog.splice(seedCatalog.length - onlyCorrupt.length, onlyCorrupt.length);
    __clearPersistedPricingCache();
  }
});

test("flat path: a corrupt-only image price fails closed before billing (never NaN)", async () => {
  // The corrupt image row is dropped at selection, so
  // resolvePreparedPricingEntry throws "Pricing unavailable" before any ledger
  // math. The selected-row test below covers the cost-boundary quantity guard.
  await expect(
    calculateImageGenerationCostFromCatalog({
      model: "corrupt-image",
      provider: "anthropic",
      imageCount: 1,
    }),
  ).rejects.toThrow(/Pricing unavailable|non-finite rate/);
});

test("token path: a corrupt input token quantity fails closed before multiplication", async () => {
  await expect(
    calculateTextCostFromCatalog({
      model: "corrupt-priced-model",
      provider: "anthropic",
      inputTokens: Number.NaN,
      outputTokens: 1,
    }),
  ).rejects.toThrow("refusing to bill an invalid quantity");
});

test("token path: a negative output token quantity fails closed before multiplication", async () => {
  await expect(
    calculateTextCostFromCatalog({
      model: "corrupt-priced-model",
      provider: "anthropic",
      inputTokens: 1,
      outputTokens: -1,
    }),
  ).rejects.toThrow("refusing to bill an invalid quantity");
});

test("flat path: a selected image row with a corrupt quantity fails closed at the cost boundary", async () => {
  await expect(
    calculateImageGenerationCostFromCatalog({
      model: "valid-image",
      provider: "anthropic",
      imageCount: Number.NaN,
    }),
  ).rejects.toThrow("refusing to bill an invalid quantity");
});

test("REGRESSION: cost is never returned as NaN for a corrupt catalog price", async () => {
  // Belt-and-suspenders: prove the old fabricated-NaN outcome is gone. A NaN
  // result would silently poison the ledger; assert we NEVER get one.
  const result = await calculateTextCostFromCatalog({
    model: "corrupt-priced-model",
    provider: "anthropic",
    inputTokens: 500,
    outputTokens: 250,
  });
  expect(Number.isNaN(result.totalCost)).toBe(false);
  expect(Number.isNaN(result.inputCost)).toBe(false);
  expect(Number.isNaN(result.outputCost)).toBe(false);
});

test("REGRESSION: a negative catalog price never returns a negative charge", async () => {
  const negativeOnly: CatalogRow[] = [
    row("solo/negative-price", "input", "language", "token", "-0.000001"),
    row("solo/negative-price", "output", "language", "token", "-0.000002"),
  ];
  negativeOnly.forEach((r) => {
    r.provider = "solo";
  });
  seedCatalog.push(...negativeOnly);
  try {
    __clearPersistedPricingCache();
    await expect(
      calculateTextCostFromCatalog({
        model: "negative-price",
        provider: "solo",
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).rejects.toThrow("refusing to bill unknown-priced inference");
  } finally {
    seedCatalog.splice(seedCatalog.length - negativeOnly.length, negativeOnly.length);
    __clearPersistedPricingCache();
  }
});
