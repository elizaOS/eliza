/**
 * Unit tests for the `es-toolkit/compat/maxBy` browser shim. The suite drives
 * the real re-export (named and default) and records empty/single collections,
 * first-wins ties, NaN skip, numeric coercion, iteratee forms (function, path,
 * matcher), and array-like/iterable input. There is no removal or capacity API.
 */
import { describe, expect, it } from "vitest";

import defaultMaxBy, { maxBy } from "./es-toolkit-compat-maxBy";

describe("es-toolkit-compat-maxBy exports", () => {
  it("re-exports the same function as both named maxBy and default", () => {
    expect(maxBy).toBeTypeOf("function");
    expect(defaultMaxBy).toBe(maxBy);
  });

  it("selects through the default export identically to the named export", () => {
    const items = [{ n: 1 }, { n: 4 }, { n: 2 }];
    expect(defaultMaxBy(items, "n")).toBe(items[1]);
  });
});

describe("maxBy empty and single-element collections", () => {
  it("returns undefined for an empty array", () => {
    expect(maxBy([] as number[])).toBeUndefined();
    expect(maxBy([] as number[], (n) => n)).toBeUndefined();
  });

  it("returns undefined for an empty iterable", () => {
    expect(maxBy(new Set<number>())).toBeUndefined();
  });

  it("returns the sole element when its iteratee is numeric", () => {
    const only = { n: 42 };
    expect(maxBy([only], "n")).toBe(only);
    expect(maxBy([0])).toBe(0);
    expect(maxBy([-7], (n) => n)).toBe(-7);
  });

  it("returns undefined when the sole element's iteratee is NaN", () => {
    expect(maxBy([Number.NaN])).toBeUndefined();
    expect(maxBy([{ n: Number.NaN }], "n")).toBeUndefined();
  });
});

describe("maxBy ordering and ties", () => {
  it("returns the element whose iteratee value is strictly greatest", () => {
    const items = [{ n: 1 }, { n: 9 }, { n: 4 }];
    expect(maxBy(items, "n")).toBe(items[1]);
  });

  it("keeps the first element when two iteratee values compare equal", () => {
    const first = { n: 5, id: "first" };
    const second = { n: 5, id: "second" };
    const lower = { n: 3, id: "lower" };
    expect(maxBy([first, lower, second], "n")).toBe(first);
    expect(maxBy([lower, first, second], "n")).toBe(first);
  });

  it("keeps the first of 0 and -0 because neither is strictly greater", () => {
    expect(Object.is(maxBy([-0, 0]), -0)).toBe(true);
    expect(Object.is(maxBy([0, -0]), 0)).toBe(true);
  });

  it("selects a later greater value after a smaller start", () => {
    const items = [{ n: -10 }, { n: -3 }, { n: -20 }];
    expect(maxBy(items, "n")).toBe(items[1]);
  });
});

describe("maxBy NaN skip and numeric coercion", () => {
  it("skips NaN iteratee values and still returns the numeric maximum", () => {
    const items = [{ n: Number.NaN }, { n: 2 }, { n: Number.NaN }, { n: 8 }];
    expect(maxBy(items, "n")).toBe(items[3]);
  });

  it("returns undefined when every iteratee value is NaN", () => {
    expect(maxBy([{ n: Number.NaN }, { n: Number.NaN }], "n")).toBeUndefined();
    expect(maxBy(["x", "y", {}])).toBeUndefined();
  });

  it("coerces identity values with Number, including numeric strings", () => {
    expect(maxBy(["10", "2", "8"])).toBe("10");
    expect(maxBy(["", "1"])).toBe("1");
  });

  it("treats null identity as 0 and skips undefined identity as NaN", () => {
    const withNull: Array<number | null> = [null, 1, -1];
    expect(maxBy(withNull)).toBe(1);

    const withUndefined: Array<number | undefined> = [undefined, 2, 1];
    expect(maxBy(withUndefined)).toBe(2);
  });

  it("coerces booleans: true (1) outranks false (0)", () => {
    expect(maxBy([false, true, false])).toBe(true);
  });

  it("selects Infinity over finite numbers including Number.MAX_VALUE", () => {
    const items = [
      { n: Number.MAX_VALUE },
      { n: Number.POSITIVE_INFINITY },
      { n: 1 },
    ];
    expect(maxBy(items, "n")).toBe(items[1]);
  });

  it("treats MAX_VALUE and MAX_VALUE + 1 as a tie because they are the same IEEE value", () => {
    expect(Number.MAX_VALUE + 1).toBe(Number.MAX_VALUE);
    expect(maxBy([Number.MAX_VALUE, Number.MAX_VALUE + 1])).toBe(
      Number.MAX_VALUE,
    );
  });

  it("selects a finite number over -Infinity", () => {
    const items = [{ n: Number.NEGATIVE_INFINITY }, { n: -100 }];
    expect(maxBy(items, "n")).toBe(items[1]);
  });
});

describe("maxBy iteratee forms", () => {
  it("uses the item itself when iteratee is omitted, null, or undefined", () => {
    expect(maxBy([1, 3, 2])).toBe(3);
    expect(maxBy([1, 3, 2], null)).toBe(3);
    expect(maxBy([1, 3, 2], undefined)).toBe(3);
  });

  it("accepts a function iteratee", () => {
    const items = [{ n: 1 }, { n: 4 }, { n: 2 }];
    expect(maxBy(items, (item) => item.n)).toBe(items[1]);
  });

  it("accepts a string property path, including nested dots", () => {
    const items = [{ a: { b: 1 } }, { a: { b: 7 } }, { a: { b: 3 } }];
    expect(maxBy(items, "a.b")).toBe(items[1]);
  });

  it("accepts an array path", () => {
    const items = [{ a: { b: 1 } }, { a: { b: 7 } }, { a: { b: 3 } }];
    expect(maxBy(items, ["a", "b"])).toBe(items[1]);
  });

  it("accepts a numeric path segment on arrays", () => {
    const items = [
      [0, 10],
      [0, 20],
      [0, 5],
    ];
    expect(maxBy(items, 1)).toBe(items[1]);
  });

  it("accepts a symbol path as a single segment", () => {
    const key = Symbol("score");
    const items = [{ [key]: 1 }, { [key]: 4 }, { [key]: 2 }];
    expect(maxBy(items, key)).toBe(items[1]);
  });

  it("skips items whose path is missing, because get yields undefined (NaN)", () => {
    const withA = { a: 1 };
    const withoutA = { b: 99 };
    expect(maxBy([withA, withoutA], "a")).toBe(withA);
    expect(maxBy([withoutA, withoutA], "a")).toBeUndefined();
  });

  it("skips unsafe __proto__, constructor, and prototype string paths", () => {
    expect(maxBy([{ n: 1 }, { n: 5 }], "__proto__")).toBeUndefined();
    expect(
      maxBy(
        [{ constructor: { name: "own" } }, { constructor: { name: "x" } }],
        "constructor",
      ),
    ).toBeUndefined();
    expect(maxBy([{ prototype: { x: 1 } }], "prototype")).toBeUndefined();
    expect(maxBy([{ a: { b: 9 } }], ["a", "__proto__"])).toBeUndefined();
  });

  it("ranks matcher-object matches (true→1) above non-matches (false→0)", () => {
    const matchFirst = { a: 1, id: "first" };
    const matchSecond = { a: 1, id: "second" };
    const nonMatch = { a: 2, id: "other" };
    expect(maxBy([nonMatch, matchFirst, matchSecond], { a: 1 })).toBe(
      matchFirst,
    );
    expect(maxBy([nonMatch, { a: 3 }], { a: 1 })).toBe(nonMatch);
  });
});

describe("maxBy array-like and iterable collections", () => {
  it("walks a non-array ArrayLike by index and length", () => {
    const arrayLike: ArrayLike<{ n: number }> = {
      0: { n: 1 },
      1: { n: 9 },
      2: { n: 4 },
      length: 3,
    };
    expect(maxBy(arrayLike, "n")).toBe(arrayLike[1]);
  });

  it("walks a Set in insertion order", () => {
    const low = { n: 1 };
    const high = { n: 9 };
    const mid = { n: 4 };
    expect(maxBy(new Set([low, high, mid]), "n")).toBe(high);
  });

  it("walks a generator iterable", () => {
    const high = { n: 9 };
    function* items() {
      yield { n: 1 };
      yield high;
      yield { n: 4 };
    }
    expect(maxBy(items(), "n")).toBe(high);
  });

  it("walks a typed array with the identity iteratee", () => {
    expect(maxBy(Int8Array.from([1, 9, 3]))).toBe(9);
  });

  it("skips sparse-array holes, which Array.from materializes as undefined", () => {
    const sparse: Array<{ n: number } | undefined> = [];
    const present = { n: 3 };
    sparse[2] = present;
    expect(maxBy(sparse, "n")).toBe(present);
  });
});
