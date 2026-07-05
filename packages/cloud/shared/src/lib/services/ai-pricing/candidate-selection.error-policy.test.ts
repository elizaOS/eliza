/**
 * Error-policy pin for candidate-selection (#13415): the pricing-row selector
 * must keep a legitimately-empty result DISTINCT from a fabricated price. This
 * file is pure sorting/string logic — no fetch, no try/catch, no console — so
 * there is no transport failure to propagate here (fetch mocking is N/A); the
 * fail-closed contract that matters is that "no matching candidate" resolves to
 * an honest `null` (caller in lookup.ts throws "Pricing unavailable") and NEVER
 * to a fabricated zero-price / stand-in entry that would read as a valid price.
 * The monetary tie-break value itself is money-path and asserted elsewhere
 * (ai-pricing-variant-indexing.test.ts); this pin asserts identity, not amounts.
 */
import { expect, test } from "bun:test";
import { chooseBestCandidatePricingEntry } from "./candidate-selection";
import type { CandidatePreparedPricingEntry } from "./types";

const CANONICAL = "google/gemini-2.0-flash";

function candidate(
  dimensions: Record<string, unknown> | undefined,
  unitPrice: number,
): CandidatePreparedPricingEntry {
  return {
    entry: {
      billingSource: "bitrouter",
      provider: "google",
      model: CANONICAL,
      productFamily: "language",
      chargeType: "input",
      unit: "token",
      unitPrice,
      dimensions,
      sourceKind: "bitrouter_catalog",
      sourceUrl: "https://api.bitrouter.ai/v1/models",
      priority: -1,
    },
    modelId: CANONICAL,
    logicalProvider: "google",
  };
}

test("empty candidate set → null, never a fabricated zero-price entry", () => {
  // Fail-closed: no rows in means no price out. The caller relies on this null
  // to try the next source and ultimately throw "Pricing unavailable"; a
  // fabricated { unitPrice: 0 } stand-in would silently zero-bill the platform.
  const result = chooseBestCandidatePricingEntry([], {}, CANONICAL);
  expect(result).toBeNull();
});

test("candidates present but none dimension-match → null (empty stays distinct from a match)", () => {
  // The only candidate carries a dimension the request does not satisfy
  // (`resolution` absent from requested {}), so it is not a subset and must be
  // filtered out — a legitimately-empty selection, indistinguishable in shape
  // from a real match ONLY if it were fabricated. It must be null instead.
  const nonMatching = candidate({ resolution: "1080p" }, 0.00000015);
  const result = chooseBestCandidatePricingEntry([nonMatching], {}, CANONICAL);
  expect(result).toBeNull();
});

test("a genuinely matching candidate resolves to that real entry, not null", () => {
  // Proves the null above is an honest 'no match' signal, not a blanket null:
  // the same request WITH a subset-matching candidate returns the input entry
  // by identity (no synthesized/defaulted row).
  const matching = candidate({}, 0.0000001);
  const result = chooseBestCandidatePricingEntry([matching], {}, CANONICAL);
  expect(result).not.toBeNull();
  expect(result?.entry).toBe(matching.entry);
});

test("no-match vs match are the two distinguishable outcomes on the same request", () => {
  // Error-policy core: a failed/absent lookup (null) can never be confused with
  // a successful one (the real entry). Same requested dimensions, different
  // candidate pools, provably different outcomes.
  const matching = candidate({}, 0.0000001);
  const nonMatching = candidate({ resolution: "4k" }, 0.0000001);

  const hit = chooseBestCandidatePricingEntry([matching], {}, CANONICAL);
  const miss = chooseBestCandidatePricingEntry([nonMatching], {}, CANONICAL);

  expect(hit?.entry).toBe(matching.entry);
  expect(miss).toBeNull();
});
