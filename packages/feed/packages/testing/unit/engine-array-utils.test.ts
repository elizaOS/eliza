import { describe, expect, it } from "bun:test";
import {
  assertNonEmpty,
  at,
  atOrThrow,
  first,
  firstOrThrow,
  isNonEmpty,
  last,
  lastOrThrow,
} from "../../engine/src/utils/array-utils";

/**
 * Safe array-access helpers replace `arr[0]!` non-null assertions. The
 * undefined-vs-throw contract and negative-index handling are pinned so an
 * empty/short array can't silently produce undefined downstream.
 */

describe("first / last (undefined on empty)", () => {
  it("returns the ends or undefined", () => {
    expect(first([1, 2, 3])).toBe(1);
    expect(last([1, 2, 3])).toBe(3);
    expect(first([])).toBeUndefined();
    expect(last([])).toBeUndefined();
  });
});

describe("*OrThrow (throw on empty)", () => {
  it("returns elements or throws with the given message", () => {
    expect(firstOrThrow([1])).toBe(1);
    expect(lastOrThrow([1, 2])).toBe(2);
    expect(() => firstOrThrow([])).toThrow(/non-empty/);
    expect(() => lastOrThrow([], "no rows")).toThrow("no rows");
  });
});

describe("non-empty guards", () => {
  it("isNonEmpty narrows; assertNonEmpty throws on empty", () => {
    expect(isNonEmpty([1])).toBe(true);
    expect(isNonEmpty([])).toBe(false);
    expect(() => assertNonEmpty([])).toThrow(/Empty array/);
    expect(() => assertNonEmpty([], "users")).toThrow(/users/);
  });
});

describe("at / atOrThrow (negative indices, bounds)", () => {
  it("supports negative indices and returns undefined out of bounds", () => {
    const arr = [10, 20, 30];
    expect(at(arr, 0)).toBe(10);
    expect(at(arr, -1)).toBe(30);
    expect(at(arr, 10)).toBeUndefined();
    expect(at(arr, -10)).toBeUndefined();
    expect(atOrThrow(arr, -1)).toBe(30);
    expect(() => atOrThrow(arr, 10)).toThrow(/out of bounds/);
  });
});
