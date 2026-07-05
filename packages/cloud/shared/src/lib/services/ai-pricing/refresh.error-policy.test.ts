/**
 * Error-policy guard for the per-source pricing-catalog refresh (#13415). Proves that a
 * provider FETCH failure surfaces as a structured { success:false } result and that an
 * empty catalog is a DISTINCT-but-also-fail-closed outcome from a successful refresh —
 * critically, neither failure nor empty runs the catalog-replace transaction, so a failed
 * refresh never wipes the last-good active prices (money-path fail-closed). The DB layer
 * and every provider loader are mocked at the module boundary; the real refreshPricingCatalog
 * drives the outcome. No monetary value is asserted.
 */
import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { PreparedPricingEntry } from "./types";

// Mutable per-test provider behavior, read at call time by the mocked loader closures.
const providerBehavior: { bitrouter: () => Promise<PreparedPricingEntry[]> } = {
  bitrouter: async () => [],
};

// Observable side effects captured from the mocked DB + logger.
const state = {
  transactionRan: false,
  runUpdates: [] as Array<Record<string, unknown>>,
  loggerErrors: [] as Array<{ msg: string; ctx: unknown }>,
};

const chainableUpdate = () => ({
  set: (values: Record<string, unknown>) => ({
    where: async () => {
      state.runUpdates.push(values);
    },
  }),
});

const chainableInsert = () => ({
  values: () => ({ returning: async () => [{ id: "run-1" }] }),
});

const tx = { update: chainableUpdate, insert: chainableInsert };

mock.module("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (...args: unknown[]) => ({ __eq: args }),
}));

mock.module("../../../db/helpers", () => ({
  dbWrite: {
    insert: chainableInsert,
    update: chainableUpdate,
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      state.transactionRan = true;
      return await fn(tx);
    },
  },
}));

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: { listActiveEntries: async () => [] },
}));

mock.module("../../../db/schemas/ai-pricing", () => ({
  aiPricingEntries: {},
  aiPricingRefreshRuns: {},
}));

mock.module("./dimensions", () => ({
  toDbEntry: (entry: { source_kind?: string }) => ({
    source_kind: entry.source_kind ?? "bitrouter",
    ...entry,
  }),
}));

mock.module("../../utils/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (msg: string, ctx: unknown) => {
      state.loggerErrors.push({ msg, ctx });
    },
  },
}));

mock.module("./providers/bitrouter", () => ({
  fetchBitRouterCatalogEntries: () => providerBehavior.bitrouter(),
}));
mock.module("./providers/fal", () => ({ fetchFalCatalogEntries: async () => [] }));
mock.module("./providers/elevenlabs", () => ({ fetchElevenLabsEntries: async () => [] }));
mock.module("./providers/suno", () => ({ fetchSunoEntries: async () => [] }));
mock.module("./providers/vast", () => ({ fetchVastSnapshotEntries: async () => [] }));

let refreshPricingCatalog: typeof import("./refresh").refreshPricingCatalog;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ refreshPricingCatalog } = await import("./refresh"));
});

beforeEach(() => {
  state.transactionRan = false;
  state.runUpdates = [];
  state.loggerErrors = [];
  // No provider bytes should ever hit the network here; a leaked real fetch must throw.
  globalThis.fetch = (() => {
    throw new Error("network disabled in ai-pricing error-policy test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const entry = (over: Partial<PreparedPricingEntry> = {}) =>
  ({
    source_kind: "bitrouter",
    model: "m",
    provider: "openrouter",
    ...over,
  }) as unknown as PreparedPricingEntry;

test("a provider FETCH failure surfaces as a structured failure and never wipes the catalog", async () => {
  providerBehavior.bitrouter = async () => {
    throw new Error("openrouter 503 upstream");
  };

  const result = await refreshPricingCatalog(["bitrouter"]);

  // The failure propagates observably as success:false with the error text preserved.
  expect(result.success).toBe(false);
  expect(result.results[0].success).toBe(false);
  expect(result.results[0].error).toContain("openrouter 503 upstream");
  expect(result.results[0].fetchedEntries).toBe(0);

  // Money-path fail-closed: the deactivate-all + reinsert transaction never ran, so the
  // last-good active prices are untouched. A failed fetch does NOT blank the catalog.
  expect(state.transactionRan).toBe(false);

  // The failure was recorded (status:"failed" run row) and logged via the structured logger.
  expect(state.runUpdates.some((u) => u.status === "failed")).toBe(true);
  expect(state.loggerErrors.length).toBeGreaterThan(0);
});

test("an empty catalog is a DISTINCT fail-closed outcome — empty never reads as success", async () => {
  providerBehavior.bitrouter = async () => [];

  const result = await refreshPricingCatalog(["bitrouter"]);

  // Zero fetched entries is treated as a failure by design, not a silent "empty catalog"
  // success — otherwise a bad fetch would deactivate every active price and leave nothing.
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("No pricing entries");
  expect(state.transactionRan).toBe(false);
});

test("a real catalog succeeds and runs the replace transaction — the distinct healthy path", async () => {
  providerBehavior.bitrouter = async () => [entry()];

  const result = await refreshPricingCatalog(["bitrouter"]);

  expect(result.success).toBe(true);
  expect(result.results[0].success).toBe(true);
  expect(result.results[0].fetchedEntries).toBe(1);
  // Only real data drives the catalog-replace transaction — the outcome is distinguishable
  // from both the fetch-failure and empty-catalog paths above.
  expect(state.transactionRan).toBe(true);
  expect(state.runUpdates.some((u) => u.status === "failed")).toBe(false);
});
