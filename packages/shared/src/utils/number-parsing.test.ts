/**
 * Coverage for the strict numeric parsers used to
 * sanitize config / env / form inputs. Pins the fallback behaviour and the
 * rejection of partial, malformed, non-finite, and unsafe-integer strings
 * rather than silently coercing them.
 */
import { describe, expect, it } from "vitest";

import {
  parseCanonicalInteger,
  parseClampedFloat,
  parseClampedInteger,
  parseNonNegativeInteger,
  parsePositiveFloat,
  parsePositiveInteger,
} from "./number-parsing";

describe("parseCanonicalInteger", () => {
  it("distinguishes omission from malformed and unsafe input", () => {
    expect(parseCanonicalInteger(null, { min: 1 })).toBeUndefined();
    expect(parseCanonicalInteger("", { min: 1 })).toBeUndefined();
    expect(parseCanonicalInteger("1e2", { min: 1 })).toBe("invalid");
    expect(parseCanonicalInteger("007", { min: 1 })).toBe("invalid");
    expect(parseCanonicalInteger("0x10", { min: 1 })).toBe("invalid");
    expect(parseCanonicalInteger("9007199254740992", { min: 1 })).toBe(
      "invalid",
    );
  });

  it("supports explicit bounds and clamping", () => {
    expect(parseCanonicalInteger("0")).toBe(0);
    expect(parseCanonicalInteger("3", { min: 1 })).toBe(3);
    expect(parseCanonicalInteger("0", { min: 1 })).toBe("invalid");
    expect(parseCanonicalInteger("101", { min: 1, max: 100 })).toBe("invalid");
    expect(
      parseCanonicalInteger("101", { min: 1, max: 100, clamp: true }),
    ).toBe(100);
  });
});

describe("number parsing utilities", () => {
  it("parses positive integers strictly", () => {
    expect(parsePositiveInteger(" 12 ")).toBe(12);
    expect(parsePositiveInteger("0", 7)).toBe(7);
    expect(parsePositiveInteger("-1", 7)).toBe(7);
    expect(parsePositiveInteger("12abc", 7)).toBe(7);
  });

  it("parses non-negative integers without accepting alternate syntax", () => {
    expect(parseNonNegativeInteger("0", 7)).toBe(0);
    expect(parseNonNegativeInteger(" 12 ", 7)).toBe(12);
    expect(parseNonNegativeInteger("1e3", 7)).toBe(7);
    expect(parseNonNegativeInteger("5junk", 7)).toBe(7);
    expect(parseNonNegativeInteger("-1", 7)).toBe(7);
    expect(parseNonNegativeInteger("9007199254740993", 7)).toBe(7);
  });

  it("parses positive floats with optional flooring", () => {
    expect(parsePositiveFloat("1.5")).toBe(1.5);
    expect(parsePositiveFloat("1.9", { floor: true })).toBe(1);
    expect(parsePositiveFloat("0.5", { floor: true, fallback: 3 })).toBe(3);
    expect(parsePositiveFloat("0.5", { floor: true })).toBeUndefined();
    expect(parsePositiveFloat("-1", { fallback: 3 })).toBe(3);
    expect(parsePositiveFloat("abc", { fallback: 3 })).toBe(3);
  });

  it("clamps floats and rejects non-finite values", () => {
    expect(parseClampedFloat("12.5", { min: 1, max: 10 })).toBe(10);
    expect(parseClampedFloat("-5", { min: 1, max: 10 })).toBe(1);
    expect(parseClampedFloat("Infinity", { fallback: 4 })).toBe(4);
  });

  it("parses clamped integers without accepting partial strings", () => {
    expect(parseClampedInteger(" 12 ", { min: 1, max: 50 })).toBe(12);
    expect(parseClampedInteger("+12", { min: 1, max: 50 })).toBe(12);
    expect(parseClampedInteger("-12", { min: -10, max: 50 })).toBe(-10);
    expect(parseClampedInteger("99", { min: 1, max: 50 })).toBe(50);
  });

  it("rejects malformed clamped integers instead of coercing them", () => {
    const options = { min: 1, max: 50, fallback: 15 };

    expect(parseClampedInteger("12abc", options)).toBe(15);
    expect(parseClampedInteger("1.9", options)).toBe(15);
    expect(parseClampedInteger("0x10", options)).toBe(15);
    expect(parseClampedInteger("1e2", options)).toBe(15);
    expect(parseClampedInteger("", options)).toBe(15);
  });

  it("rejects unsafe clamped integers", () => {
    expect(
      parseClampedInteger("9007199254740993", {
        min: 1,
        max: 100,
        fallback: 15,
      }),
    ).toBe(15);
  });
});
