/**
 * Token-amount decimal conversion (#8801 — money-critical, shipped untested).
 * `toRaw` turns a human amount into raw on-chain base units and `toHuman`
 * reverses it; a bug here sends the wrong amount of money. Pin the conversions,
 * the floor-on-excess-precision behavior, the round-trip, and the
 * reject-malformed-input path.
 */
import { describe, expect, it } from "vitest";
import { parseAmount, toHuman, toRaw } from "./decimals.ts";

describe("toRaw", () => {
  it("scales integer and fractional amounts by decimals", () => {
    expect(toRaw("100", 6)).toBe(100_000_000n);
    expect(toRaw("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(toRaw("0.000001", 6)).toBe(1n);
  });

  it("FLOORS excess precision rather than rounding (no silent over-send)", () => {
    // 7 fractional digits into a 2-decimal token → keep "99", drop the rest
    expect(toRaw("1.9999999", 2)).toBe(199n);
  });

  it("treats zero / empty as 0 and passes a bigint through unchanged", () => {
    expect(toRaw("0", 18)).toBe(0n);
    expect(toRaw("", 18)).toBe(0n);
    expect(toRaw(12345n, 18)).toBe(12345n);
  });

  it("handles negative amounts", () => {
    expect(toRaw("-2.5", 6)).toBe(-2_500_000n);
  });

  it("rejects a malformed amount string", () => {
    for (const bad of ["abc", "1.2.3", "1e5", "0x10", "1,000"]) {
      expect(() => toRaw(bad, 6)).toThrow(/invalid amount/i);
    }
  });
});

describe("toHuman", () => {
  it("renders raw base units back to a human string", () => {
    expect(toHuman(1_500_000n, 6)).toBe("1.5");
    expect(toHuman(1_000_000_000_000_000_000n, 18)).toBe("1.0");
    expect(toHuman(0n, 6)).toBe("0.0");
    expect(toHuman(-2_500_000n, 6)).toBe("-2.5");
  });

  it("returns the integer string for a 0-decimal token", () => {
    expect(toHuman(42n, 0)).toBe("42");
  });
});

describe("round-trip + parseAmount", () => {
  it("toHuman(toRaw(x)) recovers the value (within the token's precision)", () => {
    expect(toHuman(toRaw("123.456", 18), 18)).toBe("123.456");
    expect(toHuman(toRaw("1000", 6), 6)).toBe("1000.0");
  });

  it("parseAmount matches toRaw and passes bigint through", () => {
    expect(parseAmount("1.5", 18)).toBe(toRaw("1.5", 18));
    expect(parseAmount(99n, 6)).toBe(99n);
  });
});
