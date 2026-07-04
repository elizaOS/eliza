// Exercises gateway behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../../utils/logger";
import type { PreparedPricingEntry } from "../types";
import { fetchEntriesForSource } from "./gateway";

// Reference the mock fn directly (bun's test shim lacks vi.mocked), so the
// dispatched cerebras provider can be made to throw/resolve per case.
const cerebrasFetch = vi.fn();
vi.mock("./cerebras", () => ({
  fetchCerebrasPublicCatalogEntries: cerebrasFetch,
}));

/**
 * Resilience contract: external pricing-catalog fetches are best-effort
 * METADATA. A provider outage (e.g. Cerebras retiring its public /models
 * endpoint -> 404) must degrade pricing, NOT propagate out and 500 the inference
 * path that prices a completion. fetchEntriesForSource is the single choke point
 * for every provider, so it must catch + return [] rather than re-throw. This
 * locks that boundary so a future refactor can't silently re-introduce the
 * uncaught-throw 500 this guard was written to fix.
 */
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

describe("fetchEntriesForSource — provider-outage resilience", () => {
  it("returns [] and warns when a provider fetch throws (never 500s inference)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    cerebrasFetch.mockRejectedValueOnce(
      new Error(
        "Request failed for https://api.cerebras.ai/public/v1/models?format=openrouter: 404",
      ),
    );

    const result = await fetchEntriesForSource("cerebras");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns the provider's entries unchanged on success", async () => {
    cerebrasFetch.mockResolvedValueOnce(SENTINEL_ENTRIES);

    const result = await fetchEntriesForSource("cerebras");

    expect(result).toEqual(SENTINEL_ENTRIES);
  });
});
