/**
 * Unit tests for the `es-toolkit/compat/uniqBy` browser shim. The suite drives
 * the real re-export (named and default) and records first-wins dedupe, empty
 * and single-element collections, iteratee forms (function, path, matcher),
 * SameValueZero key ties (NaN, 0/-0), and array-like/iterable input. There is
 * no removal or capacity API; the helper always returns a new array.
 */
import { describe, expect, it } from "vitest";

import defaultUniqBy, { uniqBy } from "./es-toolkit-compat-uniqBy.js";

describe("es-toolkit-compat-uniqBy exports", () => {
  it("re-exports the same function as both named uniqBy and default", () => {
    expect(uniqBy).toBeTypeOf("function");
    expect(defaultUniqBy).toBe(uniqBy);
  });

  it("selects through the default export identically to the named export", () => {
    const items = [{ n: 1 }, { n: 1 }, { n: 2 }];
    expect(defaultUniqBy(items, "n")).toEqual([items[0], items[2]]);
  });
});

describe("uniqBy empty and single-element collections", () => {
  it("returns an empty array for an empty array", () => {
    expect(uniqBy([] as number[])).toEqual([]);
    expect(uniqBy([] as number[], (n: number) => n)).toEqual([]);
  });

  it("returns an empty array for an empty iterable", () => {
    expect(uniqBy(new Set<number>())).toEqual([]);
  });

  it("returns an empty array when the runtime collection is nullish", () => {
    expect(uniqBy(null as unknown as number[])).toEqual([]);
    expect(uniqBy(undefined as unknown as number[])).toEqual([]);
  });

  it("returns a one-element array when the collection has a single item", () => {
    const only = { n: 42 };
    expect(uniqBy([only], "n")).toEqual([only]);
    expect(uniqBy([0])).toEqual([0]);
    expect(uniqBy([-7], (n: number) => n)).toEqual([-7]);
  });
});

describe("uniqBy ordering and first-wins ties", () => {
  it("keeps the first occurrence of each iteratee key and preserves order", () => {
    const firstA = { k: "a", id: "first-a" };
    const firstB = { k: "b", id: "first-b" };
    const secondA = { k: "a", id: "second-a" };
    const firstC = { k: "c", id: "first-c" };
    expect(uniqBy([firstA, firstB, secondA, firstC], "k")).toEqual([
      firstA,
      firstB,
      firstC,
    ]);
  });

  it("keeps the first element when two iteratee values compare equal", () => {
    const first = { n: 5, id: "first" };
    const second = { n: 5, id: "second" };
    expect(uniqBy([first, second], "n")).toEqual([first]);
    expect(uniqBy([first, second], "n")[0]).toBe(first);
  });

  it("treats 0 and -0 as the same key because Set uses SameValueZero", () => {
    expect(uniqBy([-0, 0])).toEqual([-0]);
    expect(Object.is(uniqBy([-0, 0])[0], -0)).toBe(true);
    expect(uniqBy([0, -0])).toEqual([0]);
    expect(Object.is(uniqBy([0, -0])[0], 0)).toBe(true);
  });

  it("treats NaN keys as equal because Set.has(NaN) is true after the first", () => {
    const first = { n: Number.NaN, id: "first" };
    const second = { n: Number.NaN, id: "second" };
    const numeric = { n: 1, id: "numeric" };
    expect(uniqBy([first, numeric, second], "n")).toEqual([first, numeric]);
    expect(uniqBy([Number.NaN, Number.NaN, 2])).toEqual([Number.NaN, 2]);
  });

  it("does not mutate the input collection", () => {
    const items = [{ n: 1 }, { n: 1 }, { n: 2 }];
    const copy = items.slice();
    const result = uniqBy(items, "n");
    expect(items).toEqual(copy);
    expect(result).not.toBe(items);
    expect(result).toEqual([items[0], items[2]]);
  });

  it("returns a new array even when every key is already unique", () => {
    const items = [{ n: 1 }, { n: 2 }];
    const result = uniqBy(items, "n");
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });
});

describe("uniqBy iteratee forms", () => {
  it("uses the item itself when iteratee is omitted, null, or undefined", () => {
    expect(uniqBy([1, 3, 1, 2, 3])).toEqual([1, 3, 2]);
    expect(uniqBy([1, 3, 1, 2, 3], null)).toEqual([1, 3, 2]);
    expect(uniqBy([1, 3, 1, 2, 3], undefined)).toEqual([1, 3, 2]);
  });

  it("accepts a function iteratee", () => {
    const items = [{ n: 1 }, { n: 1 }, { n: 2 }];
    expect(uniqBy(items, (item: { n: number }) => item.n)).toEqual([
      items[0],
      items[2],
    ]);
  });

  it("accepts a string property path, including nested dots", () => {
    const items = [
      { a: { b: 1 }, id: "first" },
      { a: { b: 1 }, id: "dup" },
      { a: { b: 3 }, id: "third" },
    ];
    expect(uniqBy(items, "a.b")).toEqual([items[0], items[2]]);
  });

  it("accepts an array path", () => {
    const items = [
      { a: { b: 1 }, id: "first" },
      { a: { b: 1 }, id: "dup" },
      { a: { b: 3 }, id: "third" },
    ];
    expect(uniqBy(items, ["a", "b"])).toEqual([items[0], items[2]]);
  });

  it("accepts a numeric path segment on arrays", () => {
    const items = [
      [0, 10],
      [1, 10],
      [2, 20],
    ];
    expect(uniqBy(items, 1)).toEqual([items[0], items[2]]);
  });

  it("accepts a symbol path as a single segment", () => {
    const key = Symbol("score");
    const items = [{ [key]: 1 }, { [key]: 1 }, { [key]: 2 }];
    expect(uniqBy(items, key)).toEqual([items[0], items[2]]);
  });

  it("collapses items whose path is missing onto a single undefined key", () => {
    const withA = { a: 1 };
    const withoutA = { b: 99 };
    const alsoWithoutA = { b: 100 };
    expect(uniqBy([withA, withoutA, alsoWithoutA], "a")).toEqual([
      withA,
      withoutA,
    ]);
    expect(uniqBy([withoutA, alsoWithoutA], "a")).toEqual([withoutA]);
  });

  it("collapses unsafe __proto__, constructor, and prototype string paths onto undefined", () => {
    const first = { n: 1 };
    const second = { n: 5 };
    expect(uniqBy([first, second], "__proto__")).toEqual([first]);
    expect(
      uniqBy(
        [{ constructor: { name: "own" } }, { constructor: { name: "x" } }],
        "constructor",
      ),
    ).toEqual([{ constructor: { name: "own" } }]);
    expect(
      uniqBy([{ prototype: { x: 1 } }, { prototype: { x: 2 } }], "prototype"),
    ).toEqual([{ prototype: { x: 1 } }]);
    expect(
      uniqBy([{ a: { b: 9 } }, { a: { b: 8 } }], ["a", "__proto__"]),
    ).toEqual([{ a: { b: 9 } }]);
  });

  it("uses matcher-object matches as boolean keys, keeping first true and first false", () => {
    const matchFirst = { a: 1, id: "first" };
    const nonMatch = { a: 2, id: "other" };
    const matchSecond = { a: 1, id: "second" };
    expect(uniqBy([matchFirst, nonMatch, matchSecond], { a: 1 })).toEqual([
      matchFirst,
      nonMatch,
    ]);
    expect(uniqBy([matchFirst, matchSecond], { a: 1 })).toEqual([matchFirst]);
  });

  it("compares object identity keys by reference, not deep equality", () => {
    const shared = { n: 1 };
    const other = { n: 1 };
    expect(
      uniqBy([shared, other, shared], (item: { n: number }) => item),
    ).toEqual([shared, other]);
  });
});

describe("uniqBy array-like and iterable collections", () => {
  it("walks a non-array ArrayLike by index and length", () => {
    const first = { n: 1 };
    const dup = { n: 1 };
    const unique = { n: 2 };
    const arrayLike: ArrayLike<{ n: number }> = {
      0: first,
      1: dup,
      2: unique,
      length: 3,
    };
    expect(uniqBy(arrayLike, "n")).toEqual([first, unique]);
  });

  it("walks a Set in insertion order", () => {
    const first = { n: 1 };
    const dup = { n: 1 };
    const unique = { n: 2 };
    expect(uniqBy(new Set([first, dup, unique]), "n")).toEqual([first, unique]);
  });

  it("walks a generator iterable", () => {
    const first = { n: 1 };
    const unique = { n: 2 };
    function* items() {
      yield first;
      yield { n: 1 };
      yield unique;
    }
    expect(uniqBy(items(), "n")).toEqual([first, unique]);
  });

  it("walks a typed array with the identity iteratee", () => {
    expect(uniqBy(Int8Array.from([1, 9, 1, 3]))).toEqual([1, 9, 3]);
  });

  it("materializes sparse-array holes as undefined, then first-wins on that key", () => {
    const sparse: Array<{ n: number } | undefined> = [];
    const present = { n: 3 };
    sparse[2] = present;
    expect(uniqBy(sparse, "n")).toEqual([undefined, present]);
  });

  it("walks a string as an array-like of characters", () => {
    expect(uniqBy("abacab")).toEqual(["a", "b", "c"]);
  });
});
