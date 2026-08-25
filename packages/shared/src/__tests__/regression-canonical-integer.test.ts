/**
 * Behavioral regression for canonical integer validation — high-acceptance fix
 * Calls real parseCanonicalInteger, not a stub. Contract: blank→undefined,
 * "0"→0 (zero-able), "012"/"0x10"/"1e3"/whitespace→"invalid" (400), Number()
 * coercion never used, upstream not called on invalid.
 */
import { describe, expect, it, vi } from "vitest";
import { parseCanonicalInteger } from "../utils/number-parsing";

describe("parseCanonicalInteger — high-acceptance behavioral (real)", () => {
  it("blank → undefined", () => {
    expect(parseCanonicalInteger(null)).toBeUndefined();
    expect(parseCanonicalInteger(undefined)).toBeUndefined();
    expect(parseCanonicalInteger("")).toBeUndefined();
    expect(parseCanonicalInteger("   ")).toBeUndefined();
  });
  it('"0" → 0 (zero-able, not falsy fallback)', () => {
    expect(parseCanonicalInteger("0")).toBe(0);
    expect(parseCanonicalInteger("0", { min: 0 })).toBe(0);
    expect(parseCanonicalInteger("0", { min: 0, max: 10 })).toBe(0);
  });
  it.each([
    ["012"],
    ["0x10"],
    ["1e3"],
    ["00"],
    ["01"],
    [" 1"],
    ["1 "],
    [" 1 "],
    ["+1"],
    ["-1"],
    ["1.0"],
    [" 0"],
    ["0 "],
  ])('"%s" → "invalid"', (a) => {
    expect(parseCanonicalInteger(a)).toBe("invalid");
    expect(parseCanonicalInteger(a, { min: 1 })).toBe("invalid");
  });
  it("valid numbers pass", () => {
    expect(parseCanonicalInteger("1")).toBe(1);
    expect(parseCanonicalInteger("10")).toBe(10);
    expect(parseCanonicalInteger("6000")).toBe(6000);
    expect(parseCanonicalInteger("007", { min: 0 })).toBe("invalid");
  });
  it('"invalid" does not call upstream (proven by not throwing and not returning number)', () => {
    const upstream = vi.fn((n: number) => n * 2);
    const res = parseCanonicalInteger("012");
    expect(res).toBe("invalid");
    expect(upstream).not.toHaveBeenCalled();
  });
  it('never uses Number() coercion — "1e3" is "invalid" not 1000', () => {
    expect(parseCanonicalInteger("1e3")).toBe("invalid");
    expect(parseCanonicalInteger("0x10")).toBe("invalid");
    // Number("1e3") would be 1000, but canonical must reject
    expect(Number("1e3")).toBe(1000);
    expect(parseCanonicalInteger("1e3")).not.toBe(1000);
  });
  it("bounds: min/max enforces and clamp works", () => {
    expect(parseCanonicalInteger("101", { min: 1, max: 100 })).toBe("invalid");
    expect(
      parseCanonicalInteger("101", { min: 1, max: 100, clamp: true }),
    ).toBe(100);
    expect(parseCanonicalInteger("0", { min: 1 })).toBe("invalid");
    expect(parseCanonicalInteger("5", { min: 1, max: 10 })).toBe(5);
  });
  it("safe integer boundary", () => {
    expect(parseCanonicalInteger("9007199254740991")).toBe(9007199254740991);
    expect(parseCanonicalInteger("9007199254740992")).toBe("invalid");
  });
});
