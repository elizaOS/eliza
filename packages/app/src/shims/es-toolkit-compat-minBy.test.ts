/**
 * Unit tests for the `es-toolkit/compat/minBy` browser shim. The suite drives
 * the real re-export (named and default) and records empty-collection,
 * iteratee (function, path, matcher), NaN-skip, and first-wins-on-ties
 * behaviour of the lodash-compatible reimplementation.
 */
import { describe, expect, it } from "vitest";

import minByDefault, { minBy } from "./es-toolkit-compat-minBy.js";

describe("es-toolkit-compat-minBy exports", () => {
  it("re-exports the same function as both named minBy and default", () => {
    expect(minBy).toBeTypeOf("function");
    expect(minByDefault).toBe(minBy);
  });
});

describe("minBy empty and single-element collections", () => {
  it("returns undefined for an empty array", () => {
    expect(minBy([])).toBeUndefined();
    expect(minBy([], (n: number) => n)).toBeUndefined();
  });

  it("returns undefined for an empty array-like object", () => {
    expect(minBy({ length: 0 })).toBeUndefined();
  });

  it("returns undefined when the runtime collection is nullish", () => {
    expect(minBy(null as unknown as number[])).toBeUndefined();
    expect(minBy(undefined as unknown as number[])).toBeUndefined();
  });

  it("returns the only numeric element", () => {
    expect(minBy([7])).toBe(7);
  });

  it("returns the only record whose iteratee is numeric", () => {
    const only = { n: 4 };
    expect(minBy([only], "n")).toBe(only);
    expect(minBy([only], (item: { n: number }) => item.n)).toBe(only);
  });
});

describe("minBy numeric identity without iteratee", () => {
  it("selects the smallest Number-coerced primitive", () => {
    expect(minBy([3, 1, 2])).toBe(1);
    expect(minBy(["10", "2", "3"])).toBe("2");
  });

  it("treats an empty string as 0, which wins over positive numbers", () => {
    expect(minBy(["", "1"])).toBe("");
  });

  it("treats null as 0 and false as 0", () => {
    expect(minBy([null, 2, 1])).toBeNull();
    expect(minBy([true, false])).toBe(false);
  });

  it("selects -Infinity over finite numbers and Infinity", () => {
    expect(minBy([Number.POSITIVE_INFINITY, 0, Number.NEGATIVE_INFINITY])).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});

describe("minBy function and path iteratees", () => {
  const alpha = { n: 3, nested: { v: 9 } };
  const beta = { n: 1, nested: { v: 4 } };
  const gamma = { n: 2, nested: { v: 1 } };

  it("selects by a function iteratee", () => {
    expect(minBy([alpha, beta, gamma], (item: { n: number }) => item.n)).toBe(
      beta,
    );
  });

  it("selects by a string property path", () => {
    expect(minBy([alpha, beta, gamma], "n")).toBe(beta);
  });

  it("selects by a dotted nested path and an array path", () => {
    expect(minBy([alpha, beta, gamma], "nested.v")).toBe(gamma);
    expect(minBy([alpha, beta, gamma], ["nested", "v"])).toBe(gamma);
  });

  it("selects by a symbol key", () => {
    const key = Symbol("n");
    const first = { [key]: 8 };
    const second = { [key]: 3 };
    expect(minBy([first, second], key)).toBe(second);
  });
});

describe("minBy ties, NaN skip, and non-numeric iteratee values", () => {
  it("keeps the first element when iteratee values are equal (strict <)", () => {
    const first = { n: 1, id: "first" };
    const second = { n: 1, id: "second" };
    expect(minBy([first, second], "n")).toBe(first);
    expect(minBy([-0, 0])).toBe(-0);
  });

  it("skips NaN iteratee results and still returns the smallest remaining", () => {
    const nanItem = { n: Number.NaN };
    const two = { n: 2 };
    const one = { n: 1 };
    expect(minBy([nanItem, two, one], "n")).toBe(one);
  });

  it("returns undefined when every iteratee value is NaN", () => {
    expect(minBy([Number.NaN, Number.NaN])).toBeUndefined();
    expect(minBy([{}, { x: 1 }])).toBeUndefined();
    expect(minBy([undefined, undefined])).toBeUndefined();
  });

  it("skips sparse holes, which Array.from materialises as undefined", () => {
    const sparse: number[] = [];
    sparse[2] = 5;
    expect(minBy(sparse)).toBe(5);
  });

  it("skips prototype-pollution path segments, which resolve to undefined", () => {
    expect(minBy([{ constructor: 1 }, { constructor: 0 }], "constructor")).toBe(
      undefined,
    );
    expect(minBy([{ a: { n: 1 } }], ["a", "__proto__"])).toBeUndefined();
  });
});

describe("minBy matcher-object iteratee", () => {
  it("numbers the boolean match result so a non-match (0) wins over a match (1)", () => {
    const matching = { t: true, id: "match" };
    const nonMatching = { t: false, id: "miss" };
    const alsoMatching = { t: true, id: "match-2" };
    expect(minBy([matching, nonMatching, alsoMatching], { t: true })).toBe(
      nonMatching,
    );
  });
});

describe("minBy array-like and iterable collections", () => {
  it("walks a non-array ArrayLike by numeric indexes", () => {
    const first = { n: 5 };
    const second = { n: 2 };
    const like = { 0: first, 1: second, length: 2 };
    expect(minBy(like, "n")).toBe(second);
  });

  it("walks a Set of primitives", () => {
    expect(minBy(new Set([3, 1, 2]))).toBe(1);
  });

  it("walks a generator iterable", () => {
    function* records() {
      yield { n: 4 };
      yield { n: 1 };
      yield { n: 8 };
    }
    expect(minBy(records(), "n")).toEqual({ n: 1 });
  });
});
