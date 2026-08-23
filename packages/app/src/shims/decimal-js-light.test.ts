/**
 * Unit tests for the browser `decimal.js-light` shim. The suite drives the real
 * default-exported `Decimal` class (not a mock) and records constructor
 * coercion, arithmetic, optional-base log, comparison ties, integer detection,
 * and number/string conversion as native JS `Number` semantics — the shim's
 * actual backing, not arbitrary-precision math.
 */
import { describe, expect, it } from "vitest";

import Decimal from "./decimal-js-light.js";

describe("decimal-js-light constructor", () => {
  it("coerces a number, a numeric string, and a Decimal instance", () => {
    expect(new Decimal(4.5).toNumber()).toBe(4.5);
    expect(new Decimal("4.5").toNumber()).toBe(4.5);
    expect(new Decimal(new Decimal(4.5)).toNumber()).toBe(4.5);
  });

  it("coerces an empty string to 0 and a non-numeric string to NaN", () => {
    expect(new Decimal("").toNumber()).toBe(0);
    expect(Number.isNaN(new Decimal("not-a-number").toNumber())).toBe(true);
  });

  it("preserves Infinity, -Infinity, and NaN", () => {
    expect(new Decimal(Number.POSITIVE_INFINITY).toNumber()).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(new Decimal(Number.NEGATIVE_INFINITY).toNumber()).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(Number.isNaN(new Decimal(Number.NaN).toNumber())).toBe(true);
  });
});

describe("decimal-js-light arithmetic", () => {
  it("returns a new Decimal from abs of a negative, positive, and zero", () => {
    const negative = new Decimal(-7);
    const result = negative.abs();
    expect(result.toNumber()).toBe(7);
    expect(negative.toNumber()).toBe(-7);
    expect(new Decimal(7).abs().toNumber()).toBe(7);
    expect(new Decimal(0).abs().toNumber()).toBe(0);
  });

  it("adds, subtracts, multiplies, and divides number, string, and Decimal inputs", () => {
    const base = new Decimal(10);
    expect(base.add(2).toNumber()).toBe(12);
    expect(base.add("2").toNumber()).toBe(12);
    expect(base.add(new Decimal(2)).toNumber()).toBe(12);
    expect(base.sub(3).toNumber()).toBe(7);
    expect(base.sub("3").toNumber()).toBe(7);
    expect(base.mul(4).toNumber()).toBe(40);
    expect(base.div(5).toNumber()).toBe(2);
    expect(base.toNumber()).toBe(10);
  });

  it("uses JS remainder for mod and exponentiation for pow", () => {
    expect(new Decimal(10).mod(3).toNumber()).toBe(1);
    expect(new Decimal(-10).mod(3).toNumber()).toBe(-1);
    expect(new Decimal(10).mod(new Decimal(3)).toNumber()).toBe(1);
    expect(new Decimal(2).pow(3).toNumber()).toBe(8);
    expect(new Decimal(2).pow("3").toNumber()).toBe(8);
    expect(new Decimal(4).pow(0.5).toNumber()).toBe(2);
  });

  it("divides by zero to Infinity and mods by zero to NaN", () => {
    expect(new Decimal(1).div(0).toNumber()).toBe(Number.POSITIVE_INFINITY);
    expect(new Decimal(-1).div(0).toNumber()).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(new Decimal(0).div(0).toNumber())).toBe(true);
    expect(Number.isNaN(new Decimal(10).mod(0).toNumber())).toBe(true);
  });

  it("keeps native IEEE addition rather than decimal rounding", () => {
    expect(new Decimal(0.1).add(0.2).toNumber()).toBe(0.1 + 0.2);
    expect(new Decimal(0.1).add(0.2).toNumber()).not.toBe(0.3);
  });
});

describe("decimal-js-light log", () => {
  it("returns the natural log when no base is given", () => {
    expect(new Decimal(1).log().toNumber()).toBe(0);
    expect(new Decimal(Math.E).log().toNumber()).toBeCloseTo(1);
    expect(new Decimal(0).log().toNumber()).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(new Decimal(-1).log().toNumber())).toBe(true);
  });

  it("divides the natural log by Math.log(base) when a base is given", () => {
    expect(new Decimal(100).log(10).toNumber()).toBeCloseTo(2);
    expect(new Decimal(8).log("2").toNumber()).toBeCloseTo(3);
    expect(new Decimal(16).log(new Decimal(4)).toNumber()).toBeCloseTo(2);
  });
});

describe("decimal-js-light comparison and integer detection", () => {
  it("lt is strict and lte is true on ties", () => {
    const left = new Decimal(5);
    expect(left.lt(6)).toBe(true);
    expect(left.lt("5")).toBe(false);
    expect(left.lt(new Decimal(5))).toBe(false);
    expect(left.lt(4)).toBe(false);
    expect(left.lte(6)).toBe(true);
    expect(left.lte(5)).toBe(true);
    expect(left.lte("5")).toBe(true);
    expect(left.lte(new Decimal(5))).toBe(true);
    expect(left.lte(4)).toBe(false);
  });

  it("treats NaN comparisons as false", () => {
    const nan = new Decimal(Number.NaN);
    expect(nan.lt(0)).toBe(false);
    expect(nan.lte(0)).toBe(false);
    expect(new Decimal(0).lt(Number.NaN)).toBe(false);
    expect(new Decimal(0).lte(Number.NaN)).toBe(false);
  });

  it("isint follows Number.isInteger", () => {
    expect(new Decimal(3).isint()).toBe(true);
    expect(new Decimal(0).isint()).toBe(true);
    expect(new Decimal(-4).isint()).toBe(true);
    expect(new Decimal(3.5).isint()).toBe(false);
    expect(new Decimal(Number.NaN).isint()).toBe(false);
    expect(new Decimal(Number.POSITIVE_INFINITY).isint()).toBe(false);
  });
});

describe("decimal-js-light coercion", () => {
  it("toNumber, valueOf, and toString expose the backing number", () => {
    const value = new Decimal(12.5);
    expect(value.toNumber()).toBe(12.5);
    expect(value.valueOf()).toBe(12.5);
    expect(Number(value)).toBe(12.5);
    expect(value.toString()).toBe("12.5");
    expect(String(value)).toBe("12.5");
  });

  it("stringifies NaN and Infinity the way String(number) does", () => {
    expect(new Decimal(Number.NaN).toString()).toBe("NaN");
    expect(new Decimal(Number.POSITIVE_INFINITY).toString()).toBe("Infinity");
    expect(new Decimal(Number.NEGATIVE_INFINITY).toString()).toBe("-Infinity");
  });
});
