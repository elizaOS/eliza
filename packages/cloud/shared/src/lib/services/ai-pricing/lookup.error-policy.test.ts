/**
 * Error-policy pins for the pricing-catalog lookup (#13415).
 *
 * `calculateTextCostFromCatalog` sits on the inference-billing hot path. Its two
 * catch sites are money-path decisions and are LEFT UNCHANGED: the exact-price
 * `.catch(() => null)` (a catalog miss/DB failure degrades to the conservative
 * fallback tier) and the fallback-read `.catch(() => [])` (a DB read failure is
 * observed via the logger, then the remaining fallback tiers decide the rate).
 * These tests pin the documented behavior — never asserting a specific dollar
 * value beyond the never-$0 / never-crash money-safety property — and prove a
 * transport FAILURE stays observably DISTINCT from a legitimately-absent price:
 * both fail closed on unknown price, but only the failure is surfaced via the
 * structured logger, and neither ever silently bills $0.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const USD_PER_M = 1_000_000;

type Filters = {
  billingSource?: string;
  provider?: string;
  productFamily?: string;
  chargeType?: string;
};

function catalogRow(
  provider: string,
  model: string,
  chargeType: "input" | "output",
  usdPerMillion: number,
) {
  return {
    billing_source: "bitrouter",
    provider,
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

// Per-test-swappable repository behavior: the mock closures read these at call
// time so each test can make a DB read succeed, return empty, or throw.
let pairsHandler: (filters: unknown) => Promise<unknown[]> = async () => [];
let listHandler: (filters: Filters) => Promise<unknown[]> = async () => [];

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: (filters: unknown) => pairsHandler(filters),
    listActiveEntries: (filters: Filters) => listHandler(filters),
  },
}));

const warnSpy = mock((_message?: string, _context?: unknown) => {});
const errorSpy = mock((_message?: string, _context?: unknown) => {});
mock.module("../../utils/logger", () => ({
  logger: { warn: warnSpy, error: errorSpy },
}));

mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async () => [],
}));

const { calculateTextCostFromCatalog } = await import("./lookup");
const { __clearPersistedPricingCache } = await import("./cache");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __clearPersistedPricingCache();
  warnSpy.mockClear();
  errorSpy.mockClear();
  pairsHandler = async () => [];
  listHandler = async () => [];
  delete process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M;
  delete process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M;
  // No real provider fetch may ever happen from this billing path.
  globalThis.fetch = (async () => {
    throw new Error("network disabled in error-policy test");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M;
  delete process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M;
});

function warnedFallbackReadFailed(): boolean {
  return warnSpy.mock.calls.some((call) => call[0] === "ai-pricing: fallback catalog read failed");
}

test("legitimately-absent price fails closed and signals NO internal read failure", async () => {
  // Every seam returns a genuinely-empty catalog (no error), no env fallback.
  pairsHandler = async () => [];
  listHandler = async () => [];

  await expect(
    calculateTextCostFromCatalog({
      model: "totally-uncatalogued-model",
      provider: "someprovider",
      inputTokens: 1_000,
      outputTokens: 500,
    }),
  ).rejects.toThrow("refusing to bill unknown-priced inference");

  // A legitimately-empty result must stay DISTINCT from an internal failure:
  // the failure-observability warn is NOT emitted for a clean empty catalog.
  expect(warnedFallbackReadFailed()).toBe(false);
});

test("fallback-catalog DB read FAILURE is surfaced via the logger, still fails closed (money-path-flagged .catch(() => []))", async () => {
  // Exact lookup misses (empty), and the fallback DB read THROWS a transport
  // error. The money-path-flagged `.catch(() => [])` must observe the failure
  // through the structured logger and let the remaining tiers (none here) fail
  // closed — never a silent $0, never an uncaught crash.
  pairsHandler = async () => [];
  listHandler = async () => {
    throw new Error("pg: connection reset");
  };

  await expect(
    calculateTextCostFromCatalog({
      model: "totally-uncatalogued-model",
      provider: "someprovider",
      inputTokens: 1_000,
      outputTokens: 500,
    }),
  ).rejects.toThrow("refusing to bill unknown-priced inference");

  // Distinct from the clean-empty case above: the transport failure IS observed.
  expect(warnedFallbackReadFailed()).toBe(true);
  const call = warnSpy.mock.calls.find((c) => c[0] === "ai-pricing: fallback catalog read failed");
  expect(call?.[1]).toMatchObject({ error: "pg: connection reset" });
});

test("exact-price read transport FAILURE degrades to the fallback tier, never crashes or bills $0 (money-path-flagged .catch(() => null))", async () => {
  // The exact-model repository read throws (transport failure). The money-path
  // `.catch(() => null)` degrades that to the miss path, where a catalogued
  // provider-max entry resolves the rate. We assert only the money-safety
  // invariant — resolves without throwing and bills a positive, finite amount —
  // not any specific dollar figure.
  pairsHandler = async () => {
    throw new Error("pg: statement timeout");
  };
  listHandler = async (filters: Filters) =>
    [
      catalogRow("anthropic", "anthropic/claude-opus-4-8", "input", 5),
      catalogRow("anthropic", "anthropic/claude-opus-4-8", "output", 25),
    ].filter((row) => !filters.chargeType || row.charge_type === filters.chargeType);

  const result = await calculateTextCostFromCatalog({
    model: "claude-unknown-transient-9",
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 500,
  });

  expect(Number.isFinite(result.totalCost)).toBe(true);
  expect(result.totalCost).toBeGreaterThan(0);
  expect(result.inputCost).toBeGreaterThan(0);
  expect(result.outputCost).toBeGreaterThan(0);
});

test("starts input and output pricing reads concurrently on the inference hot path", async () => {
  const started = new Set<string>();
  let signalBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    signalBothStarted = resolve;
  });
  let releaseReads!: () => void;
  const readsReleased = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });

  pairsHandler = async (filters: unknown) => {
    const chargeType = (filters as { chargeType: "input" | "output" }).chargeType;
    started.add(chargeType);
    if (started.size === 2) signalBothStarted();
    await readsReleased;
    return [
      catalogRow(
        "anthropic",
        "anthropic/claude-opus-4-8",
        chargeType,
        chargeType === "input" ? 5 : 25,
      ),
    ];
  };

  const calculation = calculateTextCostFromCatalog({
    model: "claude-opus-4-8",
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 500,
  });

  await Promise.race([
    bothStarted,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("pricing reads started serially")), 250),
    ),
  ]);
  expect(started).toEqual(new Set(["input", "output"]));
  releaseReads();

  const result = await calculation;
  expect(result.inputCost).toBeGreaterThan(0);
  expect(result.outputCost).toBeGreaterThan(0);
});

test("starts both missing-side fallback reads concurrently", async () => {
  const started = new Set<string>();
  let signalBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    signalBothStarted = resolve;
  });
  let releaseReads!: () => void;
  const readsReleased = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });

  pairsHandler = async () => [];
  listHandler = async (filters: Filters) => {
    const chargeType = filters.chargeType as "input" | "output";
    started.add(chargeType);
    if (started.size === 2) signalBothStarted();
    await readsReleased;
    return [
      catalogRow(
        "anthropic",
        "anthropic/claude-opus-4-8",
        chargeType,
        chargeType === "input" ? 5 : 25,
      ),
    ];
  };

  const calculation = calculateTextCostFromCatalog({
    model: "claude-new-model-without-an-exact-price",
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 500,
  });

  await Promise.race([
    bothStarted,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("fallback reads started serially")), 250),
    ),
  ]);
  expect(started).toEqual(new Set(["input", "output"]));
  releaseReads();

  const result = await calculation;
  expect(result.inputCost).toBeGreaterThan(0);
  expect(result.outputCost).toBeGreaterThan(0);
});

test("uses a valid environment fallback while skipping an unused zero-token side", async () => {
  process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M = "2.5";

  const result = await calculateTextCostFromCatalog({
    model: "uncatalogued-input-only-model",
    provider: "someprovider",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });

  expect(result.baseInputCost).toBe(2.5);
  expect(result.baseOutputCost).toBe(0);
  expect(result.totalCost).toBe(3);
});

test("rejects invalid fallback environment rates instead of under-billing", async () => {
  process.env.AI_PRICING_FALLBACK_INPUT_USD_PER_M = "not-a-number";
  process.env.AI_PRICING_FALLBACK_OUTPUT_USD_PER_M = "-4";

  await expect(
    calculateTextCostFromCatalog({
      model: "uncatalogued-model",
      provider: "someprovider",
      inputTokens: 1_000,
      outputTokens: 500,
    }),
  ).rejects.toThrow("refusing to bill unknown-priced inference");

  expect(
    warnSpy.mock.calls.filter(
      (call) => call[0] === "ai-pricing: ignoring invalid fallback-rate env value",
    ),
  ).toHaveLength(2);
});

test("rejects a non-finite token quantity before catalog access", async () => {
  await expect(
    calculateTextCostFromCatalog({
      model: "claude-opus-4-8",
      provider: "anthropic",
      inputTokens: Number.NaN,
      outputTokens: 1,
    }),
  ).rejects.toThrow("refusing to bill an invalid quantity");

  expect(errorSpy.mock.calls[0]?.[0]).toBe("ai-pricing: refusing to bill an invalid quantity");
});

test("resolves and observes a persisted catalog alias", async () => {
  pairsHandler = async (filters: unknown) => {
    const chargeType = (filters as { chargeType: "input" | "output" }).chargeType;
    return [
      catalogRow(
        "anthropic",
        "anthropic:claude-opus-4-8",
        chargeType,
        chargeType === "input" ? 5 : 25,
      ),
    ];
  };

  const result = await calculateTextCostFromCatalog({
    model: "claude-opus-4-8",
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 500,
  });

  expect(result.totalCost).toBeGreaterThan(0);
  expect(
    warnSpy.mock.calls.filter((call) => call[0] === "ai-pricing: resolved pricing via alias"),
  ).toHaveLength(2);
});
