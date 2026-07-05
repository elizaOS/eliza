/**
 * Error-policy contract for the pricing-catalog dispatch choke point (#13415).
 *
 * `fetchEntriesForSource` sits between every external pricing-provider fetch and
 * the inference-billing price lookup (`lookup.ts` treats its result as the live
 * catalog and falls back to persisted/seed pricing on `[]`). Its catch is a
 * DELIBERATE money-path degrade: a provider outage must resolve to no fresh
 * entries so cached/seed pricing still prices the completion — it must NOT
 * propagate and 500 the billing path. This pins that behavior and, crucially,
 * proves an internal fetch FAILURE stays observably distinct from a
 * legitimately-empty catalog (the failure warns; a no-fetch source is silent),
 * without asserting any monetary value the source does not already fix.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../../utils/logger";
import type { PreparedPricingEntry } from "../types";

const cerebrasFetch = mock<() => Promise<PreparedPricingEntry[]>>(async () => []);

mock.module("../../../services/ai-pricing/providers/cerebras", () => ({
  fetchCerebrasPublicCatalogEntries: cerebrasFetch,
}));
mock.module("./cerebras", () => ({
  fetchCerebrasPublicCatalogEntries: cerebrasFetch,
}));

// Entries the test itself fixes — the gateway must pass these through byte-for-
// byte, performing no pricing arithmetic of its own.
const SENTINEL_ENTRIES: PreparedPricingEntry[] = [
  {
    billingSource: "cerebras",
    provider: "cerebras",
    model: "cerebras/gpt-oss-120b",
    productFamily: "language",
    chargeType: "input",
    unit: "token",
    unitPrice: 0.00005,
    sourceKind: "cerebras_public_catalog",
    sourceUrl: "https://example.test/models",
  },
];

const realFetch = globalThis.fetch;

async function loadGateway() {
  return await import("./gateway");
}

beforeEach(() => {
  cerebrasFetch.mockReset();
  // Fail closed against accidental real network for any non-mocked provider.
  globalThis.fetch = mock(async () => {
    throw new Error("network disabled in error-policy test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchEntriesForSource — error-policy (money-path-flagged degrade)", () => {
  test("a provider fetch failure degrades to [] and never propagates", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    cerebrasFetch.mockRejectedValueOnce(
      new Error(
        "Request failed for https://api.cerebras.ai/public/v1/models?format=openrouter: 404",
      ),
    );

    const { fetchEntriesForSource } = await loadGateway();

    // Must NOT throw: propagating would 500 the completion-pricing path.
    const result = await fetchEntriesForSource("cerebras");

    expect(result).toEqual([]);
    // The failure is surfaced observably, not swallowed silently.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("an internal failure is observably DISTINCT from a legitimately-empty catalog", async () => {
    const { fetchEntriesForSource } = await loadGateway();

    // Legitimately-empty source: no provider fetch is attempted, no warning.
    const warnSilent = spyOn(logger, "warn").mockImplementation(() => {});
    const seedResult = await fetchEntriesForSource("seed");
    expect(seedResult).toEqual([]);
    expect(cerebrasFetch).not.toHaveBeenCalled();
    expect(warnSilent).not.toHaveBeenCalled();
    warnSilent.mockRestore();

    // Failure path: same [] shape, but the warn log makes it distinguishable
    // from the silent legitimately-empty result above.
    const warnFail = spyOn(logger, "warn").mockImplementation(() => {});
    cerebrasFetch.mockRejectedValueOnce(new Error("upstream 503"));
    const failResult = await fetchEntriesForSource("cerebras");
    expect(failResult).toEqual([]);
    expect(warnFail).toHaveBeenCalledTimes(1);
    warnFail.mockRestore();
  });

  test("successful catalog entries pass through unchanged (no monetary mutation)", async () => {
    cerebrasFetch.mockResolvedValueOnce(SENTINEL_ENTRIES);

    const { fetchEntriesForSource } = await loadGateway();
    const result = await fetchEntriesForSource("cerebras");

    expect(result).toEqual(SENTINEL_ENTRIES);
  });
});
