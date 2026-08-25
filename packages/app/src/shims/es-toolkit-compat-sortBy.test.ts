/**
 * Unit tests for the `es-toolkit/compat/sortBy` browser shim. The suite drives
 * the real named and default re-exports and records empty/nullish collections,
 * identity and multi-iteratee ascending order, stable ties, nullish-last
 * placement, matcher/path/function iteratees, and array-like/iterable input.
 * There is no removal or capacity API; every input element is present in the
 * returned array.
 */
import { describe, expect, it } from "vitest";

import sortByDefault, { sortBy } from "./es-toolkit-compat-sortBy.js";

describe("es-toolkit-compat-sortBy exports", () => {
  it("re-exports the same function as both named sortBy and default", () => {
    expect(sortBy).toBeTypeOf("function");
    expect(sortByDefault).toBe(sortBy);
  });

  it("sorts through the default export identically to the named export", () => {
    const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(sortByDefault(items, "n")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(sortByDefault(items, "n")).toEqual(sortBy(items, "n"));
  });
});

describe("sortBy empty, nullish, and single-element collections", () => {
  it("returns an empty array for an empty array, with or without an iteratee", () => {
    expect(sortBy([] as number[])).toEqual([]);
    expect(sortBy([] as number[], (n: number) => n)).toEqual([]);
  });

  it("returns an empty array for an empty array-like and an empty iterable", () => {
    expect(sortBy({ length: 0 })).toEqual([]);
    expect(sortBy(new Set<number>())).toEqual([]);
  });

  it("returns an empty array when the runtime collection is nullish", () => {
    expect(sortBy(null as unknown as number[])).toEqual([]);
    expect(sortBy(undefined as unknown as number[])).toEqual([]);
  });

  it("returns a one-element array for a single primitive or record", () => {
    expect(sortBy([7])).toEqual([7]);
    const only = { n: 4 };
    expect(sortBy([only], "n")).toEqual([only]);
    expect(sortBy([only], (item: { n: number }) => item.n)[0]).toBe(only);
  });

  it("does not mutate the input array and returns a new array", () => {
    const items = [3, 1, 2];
    const result = sortBy(items);
    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(items);
    expect(items).toEqual([3, 1, 2]);
  });
});

describe("sortBy identity ordering without iteratee", () => {
  it("sorts numbers ascending by the identity iteratee", () => {
    expect(sortBy([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sortBy([3, 1, 2], null)).toEqual([1, 2, 3]);
    expect(sortBy([3, 1, 2], undefined)).toEqual([1, 2, 3]);
  });

  it("sorts strings lexicographically, not by numeric coercion", () => {
    expect(sortBy(["10", "2", "3"])).toEqual(["10", "2", "3"]);
  });

  it("places nullish identity values after every non-nullish value", () => {
    expect(sortBy([null, 2, 1, undefined])).toEqual([1, 2, null, undefined]);
    expect(sortBy([undefined, null])).toEqual([undefined, null]);
  });

  it("sorts -Infinity, finite numbers, and Infinity in numeric order", () => {
    expect(
      sortBy([Number.POSITIVE_INFINITY, 0, Number.NEGATIVE_INFINITY, 4]),
    ).toEqual([Number.NEGATIVE_INFINITY, 0, 4, Number.POSITIVE_INFINITY]);
  });

  it("keeps 0 and -0 in original order because neither compares less", () => {
    expect(Object.is(sortBy([-0, 0])[0], -0)).toBe(true);
    expect(Object.is(sortBy([0, -0])[0], 0)).toBe(true);
  });
});

describe("sortBy function, path, and multi-iteratee forms", () => {
  const alpha = { n: 3, nested: { v: 9 }, label: "alpha" };
  const beta = { n: 1, nested: { v: 4 }, label: "beta" };
  const gamma = { n: 2, nested: { v: 1 }, label: "gamma" };

  it("sorts by a function iteratee", () => {
    expect(
      sortBy([alpha, beta, gamma], (item: { n: number }) => item.n),
    ).toEqual([beta, gamma, alpha]);
  });

  it("sorts by a string property path", () => {
    expect(sortBy([alpha, beta, gamma], "n")).toEqual([beta, gamma, alpha]);
  });

  it("sorts by a dotted nested path as a single iteratee", () => {
    expect(sortBy([alpha, beta, gamma], "nested.v")).toEqual([
      gamma,
      beta,
      alpha,
    ]);
  });

  it("treats a top-level string array as multiple iteratees, not one path", () => {
    const first = { nested: { v: 9 }, v: 1 };
    const second = { nested: { v: 1 }, v: 9 };
    // First key "nested" yields objects that compare equal; second key "v" is
    // the own property, so original first (v: 1) precedes original second.
    expect(sortBy([first, second], ["nested", "v"])).toEqual([first, second]);
  });

  it("sorts by a nested array path when that path is one iteratee in a list", () => {
    expect(sortBy([alpha, beta, gamma], [["nested", "v"]])).toEqual([
      gamma,
      beta,
      alpha,
    ]);
  });

  it("uses later iteratees only when earlier keys tie", () => {
    const a1 = { a: 1, b: 2 };
    const a0 = { a: 0, b: 9 };
    const a1b0 = { a: 1, b: 0 };
    expect(sortBy([a1, a0, a1b0], ["a", "b"])).toEqual([a0, a1b0, a1]);
  });

  it("preserves original order when the iteratee list is empty", () => {
    expect(sortBy([3, 1, 2], [])).toEqual([3, 1, 2]);
  });

  it("sorts by a symbol key", () => {
    const key = Symbol("n");
    const first = { [key]: 8 };
    const second = { [key]: 3 };
    expect(sortBy([first, second], key)).toEqual([second, first]);
  });

  it("sorts array rows by a numeric index path", () => {
    const rows = [
      [0, 10],
      [0, 20],
      [0, 5],
    ];
    expect(sortBy(rows, 1)).toEqual([
      [0, 5],
      [0, 10],
      [0, 20],
    ]);
  });
});

describe("sortBy ties, nullish keys, and missing items", () => {
  it("keeps original order when iteratee values compare equal (stable)", () => {
    const first = { n: 1, id: "first" };
    const second = { n: 1, id: "second" };
    const lower = { n: 0, id: "lower" };
    expect(sortBy([first, lower, second], "n")).toEqual([lower, first, second]);
  });

  it("does not drop an item whose iteratee is missing; missing keys sort last", () => {
    const withA = { a: 1, id: "with" };
    const withoutA = { b: 99, id: "without" };
    const result = sortBy([withoutA, withA], "a");
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(withA);
    expect(result[1]).toBe(withoutA);
  });

  it("places NaN with other non-nullish values by original index", () => {
    const nanItem = { n: Number.NaN, id: "nan" };
    const two = { n: 2, id: "two" };
    const one = { n: 1, id: "one" };
    // NaN is not == null, and NaN < x / x < NaN are both false, so the
    // comparator falls through to original-index order against numbers.
    expect(sortBy([nanItem, two, one], "n")).toEqual([nanItem, one, two]);
  });

  it("materializes sparse holes as undefined, which sort last", () => {
    const sparse: number[] = [];
    sparse[2] = 5;
    sparse[4] = 1;
    expect(sortBy(sparse)).toEqual([1, 5, undefined, undefined, undefined]);
  });

  it("keeps every element when a pollution path resolves to undefined", () => {
    const first = { constructor: 1, id: "first" };
    const second = { constructor: 0, id: "second" };
    expect(sortBy([first, second], "constructor")).toEqual([first, second]);
    expect(
      sortBy([{ a: { n: 1 } }, { a: { n: 0 } }], ["a", "__proto__"]),
    ).toEqual([{ a: { n: 1 } }, { a: { n: 0 } }]);
    expect(sortBy([{ n: 2 }, { n: 1 }], "__proto__")).toEqual([
      { n: 2 },
      { n: 1 },
    ]);
    expect(sortBy([{ prototype: { x: 1 } }], "prototype")).toEqual([
      { prototype: { x: 1 } },
    ]);
  });
});

describe("sortBy matcher-object iteratee", () => {
  it("orders the boolean match so a non-match (false) precedes a match (true)", () => {
    const matching = { t: true, id: "match" };
    const nonMatching = { t: false, id: "miss" };
    const alsoMatching = { t: true, id: "match-2" };
    expect(sortBy([matching, nonMatching, alsoMatching], { t: true })).toEqual([
      nonMatching,
      matching,
      alsoMatching,
    ]);
  });
});

describe("sortBy array-like and iterable collections", () => {
  it("walks a non-array ArrayLike by numeric indexes", () => {
    const first = { n: 5 };
    const second = { n: 2 };
    const like = { 0: first, 1: second, length: 2 };
    expect(sortBy(like, "n")).toEqual([second, first]);
  });

  it("walks a Set of primitives in identity order after sorting", () => {
    expect(sortBy(new Set([3, 1, 2]))).toEqual([1, 2, 3]);
  });

  it("walks a generator iterable", () => {
    function* records() {
      yield { n: 4 };
      yield { n: 1 };
      yield { n: 8 };
    }
    expect(sortBy(records(), "n")).toEqual([{ n: 1 }, { n: 4 }, { n: 8 }]);
  });

  it("walks a typed array with the identity iteratee", () => {
    expect(sortBy(Int8Array.from([3, 1, 2]))).toEqual([1, 2, 3]);
  });
});
