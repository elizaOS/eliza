/**
 * Unit tests for the `es-toolkit/compat/range` browser shim. The suite drives
 * the real named and default re-exports and records lodash-style start/end/step
 * sequences, inferred direction, empty/single-element intervals, mismatched
 * step direction, zero step, and IEEE float accumulation. There is no
 * comparator, removal, or capacity API on this module.
 */
import { describe, expect, it } from "vitest";

import defaultRange, { range } from "./es-toolkit-compat-range.js";

describe("es-toolkit-compat-range exports", () => {
  it("re-exports the same function as both named range and default", () => {
    expect(range).toBeTypeOf("function");
    expect(defaultRange).toBe(range);
  });

  it("produces the same sequence through the default export as the named export", () => {
    expect(defaultRange(4)).toEqual([0, 1, 2, 3]);
    expect(defaultRange(1, 5, 2)).toEqual(range(1, 5, 2));
  });
});

describe("range single-argument end (start inferred as 0)", () => {
  it("builds [0, end) with a positive integer end", () => {
    expect(range(4)).toEqual([0, 1, 2, 3]);
  });

  it("returns a single-element sequence for end 1", () => {
    expect(range(1)).toEqual([0]);
  });

  it("returns an empty array for end 0, whose inferred step is -1 and whose bounds are equal", () => {
    expect(range(0)).toEqual([]);
  });

  it("walks downward from 0 when end is negative, exclusive of end", () => {
    expect(range(-3)).toEqual([0, -1, -2]);
    expect(range(-1)).toEqual([0]);
  });
});

describe("range start and end with inferred step", () => {
  it("walks upward by 1 when start is less than end", () => {
    expect(range(1, 5)).toEqual([1, 2, 3, 4]);
    expect(range(-5, -1)).toEqual([-5, -4, -3, -2]);
    expect(range(-2, 3)).toEqual([-2, -1, 0, 1, 2]);
  });

  it("walks downward by -1 when start is greater than end", () => {
    expect(range(5, 1)).toEqual([5, 4, 3, 2]);
    expect(range(-1, -5)).toEqual([-1, -2, -3, -4]);
    expect(range(2, -2)).toEqual([2, 1, 0, -1]);
  });

  it("returns a single-element sequence when the exclusive end is one inferred step away", () => {
    expect(range(0, 1)).toEqual([0]);
    expect(range(1, 0)).toEqual([1]);
  });

  it("returns an empty array when start equals end", () => {
    expect(range(3, 3)).toEqual([]);
    expect(range(0, 0)).toEqual([]);
    expect(range(-4, -4)).toEqual([]);
  });
});

describe("range explicit step", () => {
  it("walks by a positive integer step, exclusive of end", () => {
    expect(range(0, 10, 2)).toEqual([0, 2, 4, 6, 8]);
    expect(range(1, 10, 3)).toEqual([1, 4, 7]);
  });

  it("walks by a negative integer step, exclusive of end", () => {
    expect(range(5, 0, -2)).toEqual([5, 3, 1]);
    expect(range(0, -5, -2)).toEqual([0, -2, -4]);
  });

  it("walks by a fractional step whose IEEE additions are left unrounded", () => {
    expect(range(0, 1, 0.5)).toEqual([0, 0.5]);
    expect(range(0, 1, 0.2)).toEqual([0, 0.2, 0.4, 0.6000000000000001, 0.8]);
  });

  it("returns an empty array when step is 0, including negative zero", () => {
    expect(range(0, 10, 0)).toEqual([]);
    expect(range(10, 0, 0)).toEqual([]);
    expect(range(0, 10, -0)).toEqual([]);
  });

  it("returns an empty array when the explicit step points away from end", () => {
    expect(range(5, 1, 1)).toEqual([]);
    expect(range(1, 5, -1)).toEqual([]);
    expect(range(-5, -1, -1)).toEqual([]);
    expect(range(-1, -5, 1)).toEqual([]);
  });

  it("emits the start once when the step is infinite and still points toward end", () => {
    expect(range(0, 10, Number.POSITIVE_INFINITY)).toEqual([0]);
    expect(range(10, 0, Number.NEGATIVE_INFINITY)).toEqual([10]);
  });
});

describe("range NaN bounds and step", () => {
  it("returns an empty array when any bound or the step is NaN", () => {
    expect(range(Number.NaN)).toEqual([]);
    expect(range(0, Number.NaN)).toEqual([]);
    expect(range(Number.NaN, 5)).toEqual([]);
    expect(range(0, 5, Number.NaN)).toEqual([]);
  });
});
