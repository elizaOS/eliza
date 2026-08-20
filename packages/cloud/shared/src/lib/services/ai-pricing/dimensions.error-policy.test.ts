/**
 * Error-path guard for the price-parse boundary in dimensions.ts. `dimensions.ts`
 * is a pure normalization/mapping + markup-math module with no fetch/transport and
 * no try/catch, so the only failure-vs-empty decision to pin is parseNumericPrice:
 * an unparseable / non-finite / absent provider price must resolve to a DISTINCT
 * absent signal (null) that callers (cerebras/openrouter/bitrouter provider
 * parsers) skip, never a fabricated numeric price that would silently enter
 * billing. Drives the real exported function; asserts only pass-through and the
 * null boundary, never a specific invented monetary value.
 */
import { expect, test } from "bun:test";
import { parseNumericPrice } from "./dimensions";

test("a valid positive numeric price passes through unchanged", () => {
  expect(parseNumericPrice(1.5)).toBe(1.5);
  expect(parseNumericPrice("0.000002")).toBe(0.000002);
});

test("an unparseable, non-positive, non-finite, or absent price returns the null absent-signal", () => {
  // Failed/garbage/sentinel upstream values must NOT enter the billing catalogue.
  for (const bad of [
    "abc",
    "",
    "   ",
    0,
    "0",
    -1,
    "-0.000001",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    {},
    [],
  ]) {
    expect(parseNumericPrice(bad)).toBeNull();
  }
});

test("a provider sentinel is distinguishable from a genuine positive price", () => {
  const absent = parseNumericPrice("not-a-price");
  const price = parseNumericPrice(0.000001);
  expect(absent).toBeNull();
  expect(price).toBe(0.000001);
  expect(absent).not.toBe(price);
});
