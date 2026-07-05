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

test("a valid numeric price passes through unchanged (incl. legit zero)", () => {
  expect(parseNumericPrice(0)).toBe(0);
  expect(parseNumericPrice(1.5)).toBe(1.5);
  expect(parseNumericPrice("0.000002")).toBe(0.000002);
});

test("an unparseable / non-finite / absent price returns the null absent-signal, DISTINCT from a real price", () => {
  // Failed/garbage upstream values must NOT collapse to 0 or any number.
  for (const bad of [
    "abc",
    "",
    "   ",
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

test("null (absent) is distinguishable from a genuine zero price — no failure-as-zero conflation", () => {
  const absent = parseNumericPrice("not-a-price");
  const zero = parseNumericPrice(0);
  expect(absent).toBeNull();
  expect(zero).toBe(0);
  expect(absent).not.toBe(zero);
});
