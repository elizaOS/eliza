/**
 * Unit tests for the `es-toolkit/compat/sumBy` browser shim. The suite drives
 * the real re-export (named and default) and records empty/nullish collections,
 * identity vs iteratee (function, path, matcher), NaN-as-zero, numeric
 * coercion, IEEE overflow of the running total, and array-like/iterable input.
 * There is no removal, comparator, or capacity API.
 */
import { describe, expect, it } from "vitest";

import sumByDefault, { sumBy } from "./es-toolkit-compat-sumBy.js";

describe("es-toolkit-compat-sumBy exports", () => {
  it("re-exports the same function as both named sumBy and default", () => {
    expect(sumBy).toBeTypeOf("function");
    expect(sumByDefault).toBe(sumBy);
  });

  it("totals through the default export identically to the named export", () => {
    const items = [{ n: 1 }, { n: 4 }, { n: 2 }];
    expect(sumByDefault(items, "n")).toBe(7);
    expect(sumByDefault(items, "n")).toBe(sumBy(items, "n"));
  });
});

describe("sumBy empty, nullish, and single-element collections", () => {
  it("returns 0 for an empty array, with or without an iteratee", () => {
    expect(sumBy([])).toBe(0);
    expect(sumBy([], (n: number) => n)).toBe(0);
  });

  it("returns 0 for an empty array-like object and empty iterable", () => {
    expect(sumBy({ length: 0 })).toBe(0);
    expect(sumBy(new Set<number>())).toBe(0);
  });

  it("returns 0 when the runtime collection is nullish (toArray yields [])", () => {
    expect(sumBy(null as unknown as number[])).toBe(0);
    expect(sumBy(undefined as unknown as number[])).toBe(0);
  });

  it("returns the only numeric identity element", () => {
    expect(sumBy([7])).toBe(7);
    expect(sumBy([0])).toBe(0);
    expect(sumBy([-7], (n: number) => n)).toBe(-7);
  });

  it("returns 0 when the sole element's iteratee is NaN (counted as zero)", () => {
    expect(sumBy([Number.NaN])).toBe(0);
    expect(sumBy([{ n: Number.NaN }], "n")).toBe(0);
  });
});

describe("sumBy identity totals without iteratee", () => {
  it("adds Number-coerced primitives in encounter order", () => {
    expect(sumBy([3, 1, 2])).toBe(6);
    expect(sumBy(["10", "2", "3"])).toBe(15);
  });

  it("treats an empty string as 0", () => {
    expect(sumBy(["", "1"])).toBe(1);
  });

  it("treats null identity as 0 and false as 0, true as 1", () => {
    expect(sumBy([null, 2, 1])).toBe(3);
    expect(sumBy([true, false, true])).toBe(2);
  });

  it("adds Infinity and -Infinity as IEEE values, including a NaN total", () => {
    expect(sumBy([Number.POSITIVE_INFINITY, 1])).toBe(Number.POSITIVE_INFINITY);
    expect(sumBy([Number.NEGATIVE_INFINITY, 1])).toBe(Number.NEGATIVE_INFINITY);
    expect(
      Number.isNaN(sumBy([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])),
    ).toBe(true);
  });
});

describe("sumBy function and path iteratees", () => {
  const alpha = { n: 3, nested: { v: 9 } };
  const beta = { n: 1, nested: { v: 4 } };
  const gamma = { n: 2, nested: { v: 1 } };

  it("totals a function iteratee", () => {
    expect(sumBy([alpha, beta, gamma], (item: { n: number }) => item.n)).toBe(
      6,
    );
  });

  it("totals a string property path", () => {
    expect(sumBy([alpha, beta, gamma], "n")).toBe(6);
  });

  it("totals a dotted nested path and an array path", () => {
    expect(sumBy([alpha, beta, gamma], "nested.v")).toBe(14);
    expect(sumBy([alpha, beta, gamma], ["nested", "v"])).toBe(14);
  });

  it("totals a symbol key", () => {
    const key = Symbol("n");
    const first = { [key]: 8 };
    const second = { [key]: 3 };
    expect(sumBy([first, second], key)).toBe(11);
  });

  it("totals a numeric path segment on arrays", () => {
    const items = [
      [0, 10],
      [0, 20],
      [0, 5],
    ];
    expect(sumBy(items, 1)).toBe(35);
  });

  it("uses the item itself when iteratee is omitted, null, or undefined", () => {
    expect(sumBy([1, 3, 2])).toBe(6);
    expect(sumBy([1, 3, 2], null)).toBe(6);
    expect(sumBy([1, 3, 2], undefined)).toBe(6);
  });
});

describe("sumBy NaN-as-zero, missing paths, and unsafe segments", () => {
  it("counts NaN iteratee values as 0 and still adds the remaining numbers", () => {
    const nanItem = { n: Number.NaN };
    const two = { n: 2 };
    const one = { n: 1 };
    expect(sumBy([nanItem, two, one], "n")).toBe(3);
  });

  it("returns 0 when every iteratee value is NaN", () => {
    expect(sumBy([Number.NaN, Number.NaN])).toBe(0);
    expect(sumBy([{}, { x: 1 }])).toBe(0);
    expect(sumBy([undefined, undefined])).toBe(0);
    expect(sumBy(["x", "y", {}])).toBe(0);
  });

  it("counts a missing property as 0 because get yields undefined (NaN)", () => {
    const withA = { a: 1 };
    const withoutA = { b: 99 };
    expect(sumBy([withA, withoutA], "a")).toBe(1);
    expect(sumBy([withoutA, withoutA], "a")).toBe(0);
  });

  it("counts unsafe __proto__, constructor, and prototype paths as 0", () => {
    expect(sumBy([{ n: 1 }, { n: 5 }], "__proto__")).toBe(0);
    expect(
      sumBy(
        [{ constructor: { name: "own" } }, { constructor: { name: "x" } }],
        "constructor",
      ),
    ).toBe(0);
    expect(sumBy([{ prototype: { x: 1 } }], "prototype")).toBe(0);
    expect(sumBy([{ a: { b: 9 } }], ["a", "__proto__"])).toBe(0);
  });

  it("counts sparse holes as 0, which Array.from materialises as undefined", () => {
    const sparse: number[] = [];
    sparse[2] = 5;
    expect(sumBy(sparse)).toBe(5);
  });
});

describe("sumBy matcher-object iteratee", () => {
  it("numbers the boolean match result so each match adds 1 and each miss adds 0", () => {
    const matching = { t: true, id: "match" };
    const nonMatching = { t: false, id: "miss" };
    const alsoMatching = { t: true, id: "match-2" };
    expect(sumBy([matching, nonMatching, alsoMatching], { t: true })).toBe(2);
    expect(sumBy([nonMatching, { t: false }], { t: true })).toBe(0);
  });
});

describe("sumBy equal values, signed zero, and overflow", () => {
  it("adds equal iteratee values instead of keeping only the first", () => {
    const first = { n: 5, id: "first" };
    const second = { n: 5, id: "second" };
    expect(sumBy([first, second], "n")).toBe(10);
  });

  it("starts from +0 so a sum of -0 values is +0", () => {
    expect(Object.is(sumBy([-0]), 0)).toBe(true);
    expect(Object.is(sumBy([-0, -0]), 0)).toBe(true);
  });

  it("overflows IEEE MAX_VALUE + MAX_VALUE to Infinity", () => {
    expect(sumBy([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("treats MAX_VALUE and MAX_VALUE + 1 as the same IEEE addend", () => {
    expect(Number.MAX_VALUE + 1).toBe(Number.MAX_VALUE);
    expect(sumBy([Number.MAX_VALUE, Number.MAX_VALUE + 1])).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("sumBy array-like and iterable collections", () => {
  it("walks a non-array ArrayLike by numeric indexes", () => {
    const first = { n: 5 };
    const second = { n: 2 };
    const like = { 0: first, 1: second, length: 2 };
    expect(sumBy(like, "n")).toBe(7);
  });

  it("walks a Set of primitives in insertion order", () => {
    expect(sumBy(new Set([3, 1, 2]))).toBe(6);
  });

  it("walks a generator iterable", () => {
    function* records() {
      yield { n: 4 };
      yield { n: 1 };
      yield { n: 8 };
    }
    expect(sumBy(records(), "n")).toBe(13);
  });

  it("walks a typed array with the identity iteratee", () => {
    expect(sumBy(Int8Array.from([1, 9, 3]))).toBe(13);
    expect(sumBy(new Uint8Array(0))).toBe(0);
  });

  it("walks a string as an array-like of characters", () => {
    expect(sumBy("123")).toBe(6);
    expect(sumBy("")).toBe(0);
  });
});
