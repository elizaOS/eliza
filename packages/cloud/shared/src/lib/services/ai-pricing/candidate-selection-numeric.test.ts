/**
 * Regression (#13415 fallback-slop): a corrupt persisted catalog price must
 * never be SELECTED, and must never silently bill NaN.
 *
 * `aiEntryToPrepared` builds `unitPrice = Number(entry.unit_price)` over a
 * Postgres NUMERIC column. A corrupt row (`'NaN'::numeric` is a valid Postgres
 * NUMERIC that reads back as the string "NaN") therefore yields a candidate
 * whose `unitPrice` is `NaN`. Before this fix `chooseBestCandidatePricingEntry`:
 *   (a) did NOT filter such a candidate out, and
 *   (b) used `right.entry.unitPrice - left.entry.unitPrice` as a tie-break,
 *       which returns `NaN` for a corrupt entry — an INCONSISTENT sort
 *       comparator that could non-deterministically let the corrupt entry WIN
 *       over a valid one — after which `asDecimal(NaN).mul(quantity)` bills a
 *       `NaN` charge that poisons the credit debit / earnings ledger.
 *
 * The fix drops any candidate whose `unitPrice` is not a finite, positive
 * number, mirroring the finite guard already present in
 * `resolveFallbackTokenRate`. This file locks in that selection behavior; the
 * cost-boundary defense-in-depth guard is exercised in
 * lookup-corrupt-price.test.ts.
 */
import { expect, test } from "bun:test";
import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import { chooseBestCandidatePricingEntry } from "./candidate-selection";
import type { CandidatePreparedPricingEntry, PreparedPricingEntry } from "./types";

function candidate(
  overrides: Partial<PreparedPricingEntry> & { unitPrice: number },
  modelId = "anthropic/claude-sonnet-5",
): CandidatePreparedPricingEntry {
  const entry: PreparedPricingEntry = {
    billingSource: "bitrouter",
    provider: "anthropic",
    model: modelId,
    productFamily: "language",
    chargeType: "input",
    unit: "token",
    dimensions: {},
    sourceKind: "bitrouter_catalog",
    sourceUrl: "https://example.test/catalog",
    priority: 200,
    isOverride: false,
    metadata: {},
    ...overrides,
  };
  return { entry, modelId, logicalProvider: "anthropic" };
}

const NO_DIMENSIONS: PricingDimensions = {};
const CANONICAL = "anthropic/claude-sonnet-5";

test("a corrupt (NaN) unit price is never selected — a valid entry wins", () => {
  // NaN entry declares a HIGHER priority than the valid one, so without the
  // fail-closed filter it would win priority-first. It must be dropped instead.
  const corrupt = candidate({ unitPrice: Number("NaN"), priority: 999 });
  const valid = candidate({ unitPrice: 0.000003, priority: 200 });

  const chosen = chooseBestCandidatePricingEntry([corrupt, valid], NO_DIMENSIONS, CANONICAL);

  expect(chosen).not.toBeNull();
  expect(chosen?.entry.unitPrice).toBe(0.000003);
  expect(Number.isFinite(chosen?.entry.unitPrice ?? Number.NaN)).toBe(true);
});

test("when the ONLY matching entry is corrupt, selection returns null (fail closed)", () => {
  // A null return degrades the caller to the fallback tier (provider-max / env
  // default) or fails closed — exactly as an ABSENT price does — instead of
  // billing a NaN rate.
  const corrupt = candidate({ unitPrice: Number("NaN") });

  const chosen = chooseBestCandidatePricingEntry([corrupt], NO_DIMENSIONS, CANONICAL);

  expect(chosen).toBeNull();
});

test("non-positive and non-finite prices are all dropped (0, -1, Infinity, NaN)", () => {
  const zero = candidate({ unitPrice: 0 });
  const negative = candidate({ unitPrice: -0.001 });
  const infinite = candidate({ unitPrice: Number.POSITIVE_INFINITY });
  const nan = candidate({ unitPrice: Number("NaN") });

  expect(
    chooseBestCandidatePricingEntry([zero, negative, infinite, nan], NO_DIMENSIONS, CANONICAL),
  ).toBeNull();
});

test("a healthy set of finite prices selects the highest by the conservative tie-break", () => {
  // Same priority/specificity/canonical/provider → the tie-break prefers the
  // higher unitPrice (never under-bill). Verifies the fix didn't change the
  // healthy-path ordering.
  const cheap = candidate({ unitPrice: 0.000001 });
  const pricey = candidate({ unitPrice: 0.000009 });

  const chosen = chooseBestCandidatePricingEntry([cheap, pricey], NO_DIMENSIONS, CANONICAL);

  expect(chosen?.entry.unitPrice).toBe(0.000009);
});

test("REGRESSION: a corrupt entry cannot poison the tie-break comparator to win", () => {
  // The old `right.unitPrice - left.unitPrice` tie-break returns NaN when either
  // side is corrupt. Depending on the engine's sort, an inconsistent comparator
  // can leave a corrupt element first. Prove the corrupt one is gone BEFORE the
  // sort so ordering is always over finite prices only.
  const corrupt = candidate({ unitPrice: Number("NaN") });
  const valid = candidate({ unitPrice: 0.000004 });

  // Both orderings must select the same valid entry.
  expect(
    chooseBestCandidatePricingEntry([corrupt, valid], NO_DIMENSIONS, CANONICAL)?.entry.unitPrice,
  ).toBe(0.000004);
  expect(
    chooseBestCandidatePricingEntry([valid, corrupt], NO_DIMENSIONS, CANONICAL)?.entry.unitPrice,
  ).toBe(0.000004);
});
