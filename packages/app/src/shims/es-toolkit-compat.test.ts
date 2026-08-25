/**
 * Unit tests for the `es-toolkit/compat` browser shim. The suite drives the
 * real aggregator module (not mocks, not the per-helper re-export files) and
 * records every named export: get path grammar and prototype-pollution
 * rejection, isPlainObject prototype checks, uniqBy first-wins, sortBy
 * nullish-last stable order, throttle leading/trailing/cancel/flush, last,
 * maxBy/minBy ties, range step/empty intervals, omit missing keys, and sumBy
 * NaN-as-zero. There is no removal or capacity API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as compat from "./es-toolkit-compat.js";
import {
  get,
  isPlainObject,
  last,
  maxBy,
  minBy,
  omit,
  range,
  sortBy,
  sumBy,
  throttle,
  uniqBy,
} from "./es-toolkit-compat.js";

describe("es-toolkit-compat exports", () => {
  it("exposes only the named helpers the renderer alias actually ships", () => {
    expect(Object.keys(compat).sort()).toEqual([
      "get",
      "isPlainObject",
      "last",
      "maxBy",
      "minBy",
      "omit",
      "range",
      "sortBy",
      "sumBy",
      "throttle",
      "uniqBy",
    ]);
    expect(compat).not.toHaveProperty("default");
  });

  it("exports each helper as a function", () => {
    expect(get).toBeTypeOf("function");
    expect(isPlainObject).toBeTypeOf("function");
    expect(uniqBy).toBeTypeOf("function");
    expect(sortBy).toBeTypeOf("function");
    expect(throttle).toBeTypeOf("function");
    expect(last).toBeTypeOf("function");
    expect(maxBy).toBeTypeOf("function");
    expect(minBy).toBeTypeOf("function");
    expect(range).toBeTypeOf("function");
    expect(omit).toBeTypeOf("function");
    expect(sumBy).toBeTypeOf("function");
  });
});

describe("get nullish source and defaultValue", () => {
  it("returns undefined when the source is null or undefined and no default is given", () => {
    expect(get(null, "a")).toBeUndefined();
    expect(get(undefined, "a.b")).toBeUndefined();
    expect(get(null, ["a"])).toBeUndefined();
  });

  it("returns defaultValue when the source is null or undefined", () => {
    expect(get(null, "a", "fallback")).toBe("fallback");
    expect(get(undefined, ["a", "b"], 0)).toBe(0);
  });

  it("returns a present 0, empty string, false, or null rather than defaultValue", () => {
    expect(get({ a: 0 }, "a", "d")).toBe(0);
    expect(get({ a: "" }, "a", "d")).toBe("");
    expect(get({ a: false }, "a", "d")).toBe(false);
    expect(get({ a: null }, "a", "d")).toBeNull();
  });

  it("returns defaultValue only when the resolved value is undefined", () => {
    expect(get({ a: undefined }, "a", "d")).toBe("d");
    expect(get({ a: {} }, "a.b", "d")).toBe("d");
  });
});

describe("get path grammar", () => {
  const source = {
    a: { b: { c: 3 } },
    items: [{ name: "first" }, { name: "second" }],
    "b.c": 1,
  };

  it("reads a single own key", () => {
    expect(get({ a: 1 }, "a")).toBe(1);
  });

  it("reads a nested dot path", () => {
    expect(get(source, "a.b.c")).toBe(3);
  });

  it("reads a numeric bracket segment", () => {
    expect(get(source, "items[1].name")).toBe("second");
    expect(get(source, "items[0].name")).toBe("first");
  });

  it("reads a quoted bracket key, including a key that contains a dot", () => {
    expect(get({ a: { "b.c": 1 } }, 'a["b.c"]')).toBe(1);
    expect(get({ a: { "b.c": 1 } }, "a['b.c']")).toBe(1);
  });

  it("unescapes a quoted-bracket backslash sequence", () => {
    expect(get({ a: { 'x"y': 2 } }, 'a["x\\"y"]')).toBe(2);
  });

  it("reads an array path, including numeric and nested segments", () => {
    expect(get(source, ["a", "b", "c"])).toBe(3);
    expect(get(source, ["items", 1, "name"])).toBe("second");
  });

  it("reads a numeric path segment on arrays and objects", () => {
    expect(get(["x", "y"], 1)).toBe("y");
    expect(get({ 2: "two" }, 2)).toBe("two");
  });

  it("reads a symbol path as a single segment", () => {
    const key = Symbol("k");
    expect(get({ [key]: 7 }, key)).toBe(7);
  });

  it("returns the source when the path array is empty", () => {
    expect(get(source, [])).toBe(source);
  });

  it("returns the source for string paths whose grammar yields no segments", () => {
    expect(get(source, ".")).toBe(source);
    expect(get(source, "[]")).toBe(source);
  });

  it("reads an empty-string key only when that own key exists", () => {
    expect(get({ "": "empty-key" }, "")).toBe("empty-key");
    expect(get(source, "")).toBeUndefined();
  });
});

describe("get prototype-pollution key rejection", () => {
  it("returns defaultValue for __proto__, constructor, and prototype string segments", () => {
    expect(get({ __proto__: { x: 1 } }, "__proto__")).toBeUndefined();
    expect(
      get({ constructor: { name: "own" } }, "constructor", "blocked"),
    ).toBe("blocked");
    expect(get({ prototype: { x: 1 } }, "prototype", "blocked")).toBe(
      "blocked",
    );
  });

  it("stops at an unsafe segment in a nested path and does not walk further", () => {
    expect(get({ a: { b: 9 } }, ["a", "__proto__", "b"], "d")).toBe("d");
    expect(get({ a: { constructor: { n: 1 } } }, "a.constructor.n", "d")).toBe(
      "d",
    );
  });
});

describe("isPlainObject", () => {
  class Example {}

  it("returns true for object literals and Object.create(null)", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(Object.create(Object.prototype))).toBe(true);
  });

  it("returns false for null, undefined, primitives, and arrays", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(0)).toBe(false);
    expect(isPlainObject("")).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1])).toBe(false);
  });

  it("returns false for class instances, dates, and objects with a parent prototype", () => {
    expect(isPlainObject(new Example())).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(Object.create({ x: 1 }))).toBe(false);
    expect(isPlainObject(new Boolean(true))).toBe(false);
    expect(isPlainObject(() => undefined)).toBe(false);
  });
});

describe("uniqBy empty, single-element, and first-wins", () => {
  it("returns an empty array for empty, nullish, and empty-iterable input", () => {
    expect(uniqBy([] as number[])).toEqual([]);
    expect(uniqBy(new Set<number>())).toEqual([]);
    expect(uniqBy(null as unknown as number[])).toEqual([]);
    expect(uniqBy(undefined as unknown as number[])).toEqual([]);
  });

  it("returns a one-element array for a single item", () => {
    const only = { n: 42 };
    expect(uniqBy([only], "n")).toEqual([only]);
    expect(uniqBy([0])).toEqual([0]);
  });

  it("keeps the first occurrence of each iteratee key and preserves order", () => {
    const firstA = { k: "a", id: "first-a" };
    const firstB = { k: "b", id: "first-b" };
    const secondA = { k: "a", id: "second-a" };
    expect(uniqBy([firstA, firstB, secondA], "k")).toEqual([firstA, firstB]);
    expect(uniqBy([firstA, secondA], "k")[0]).toBe(firstA);
  });

  it("treats 0/-0 and NaN as the same Set key", () => {
    expect(Object.is(uniqBy([-0, 0])[0], -0)).toBe(true);
    expect(uniqBy([Number.NaN, Number.NaN, 2])).toEqual([Number.NaN, 2]);
  });

  it("accepts function, path, array-path, and matcher iteratees", () => {
    const items = [
      { n: 1, nested: { v: 1 } },
      { n: 1, nested: { v: 1 } },
      { n: 2, nested: { v: 2 } },
    ];
    expect(uniqBy(items, (item) => item.n)).toEqual([items[0], items[2]]);
    expect(uniqBy(items, "nested.v")).toEqual([items[0], items[2]]);
    expect(uniqBy(items, ["nested", "v"])).toEqual([items[0], items[2]]);
    expect(uniqBy(items, { n: 1 }).map((item) => item.n)).toEqual([1, 2]);
  });

  it("walks a Set and a non-array ArrayLike", () => {
    const a = { n: 1 };
    const b = { n: 1 };
    const c = { n: 2 };
    expect(uniqBy(new Set([a, b, c]), "n")).toEqual([a, c]);
    const arrayLike: ArrayLike<{ n: number }> = {
      0: a,
      1: b,
      2: c,
      length: 3,
    };
    expect(uniqBy(arrayLike, "n")).toEqual([a, c]);
  });
});

describe("sortBy empty, identity, ties, and iteratees", () => {
  it("returns an empty array for empty and nullish collections", () => {
    expect(sortBy([] as number[])).toEqual([]);
    expect(sortBy(null as unknown as number[])).toEqual([]);
    expect(sortBy(undefined as unknown as number[])).toEqual([]);
  });

  it("returns a one-element array unchanged in identity", () => {
    expect(sortBy([7])).toEqual([7]);
  });

  it("does not mutate the input array", () => {
    const items = [3, 1, 2];
    const result = sortBy(items);
    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(items);
    expect(items).toEqual([3, 1, 2]);
  });

  it("sorts numbers ascending and places nullish identity values last", () => {
    expect(sortBy([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sortBy([null, 2, 1, undefined])).toEqual([1, 2, null, undefined]);
  });

  it("keeps equal keys in original order, including 0 and -0", () => {
    const first = { n: 1, id: "first" };
    const second = { n: 1, id: "second" };
    expect(sortBy([second, first], "n")).toEqual([second, first]);
    expect(Object.is(sortBy([-0, 0])[0], -0)).toBe(true);
  });

  it("uses later iteratees only after an earlier resolver ties, including both-nullish", () => {
    const left = { a: null as number | null, b: 2 };
    const right = { a: null as number | null, b: 1 };
    expect(sortBy([left, right], ["a", "b"])).toEqual([right, left]);
  });

  it("sorts by function, string path, nested array path, and matcher object", () => {
    const alpha = { n: 3, nested: { v: 9 } };
    const beta = { n: 1, nested: { v: 4 } };
    const gamma = { n: 2, nested: { v: 1 } };
    expect(sortBy([alpha, beta, gamma], (item) => item.n)).toEqual([
      beta,
      gamma,
      alpha,
    ]);
    expect(sortBy([alpha, beta, gamma], "n")).toEqual([beta, gamma, alpha]);
    // A top-level array is a list of iteratees, not a path. A nested array
    // is the lodash array-path form (`get(item, ["nested", "v"])`).
    expect(sortBy([alpha, beta, gamma], ["nested", "v"])).toEqual([
      alpha,
      beta,
      gamma,
    ]);
    expect(sortBy([alpha, beta, gamma], [["nested", "v"]])).toEqual([
      gamma,
      beta,
      alpha,
    ]);
    const matchFirst = { a: 1, id: "first" };
    const nonMatch = { a: 2, id: "other" };
    expect(sortBy([nonMatch, matchFirst], { a: 1 })).toEqual([
      nonMatch,
      matchFirst,
    ]);
  });
});

describe("throttle leading, trailing, cancel, and flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes immediately on the first call once Date.now is past the zero lastCall", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBe("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("returns lastResult and schedules a trailing invoke while inside the wait window", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBe("a");
    expect(throttled("b")).toBe("a");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]?.[0]).toBe("b");
  });

  it("coalesces extra calls in the window onto the pending trailing args", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    throttled("a");
    throttled("b");
    throttled("c");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]?.[0]).toBe("c");
  });

  it("invokes immediately again once the wait has elapsed", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    throttled("a");
    vi.advanceTimersByTime(100);
    expect(throttled("b")).toBe("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("invokes every call immediately when wait is the default 0", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn);
    expect(throttled("a")).toBe("a");
    expect(throttled("b")).toBe("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies this and the stored args on both leading and trailing invokes", () => {
    const fn = vi.fn(function (this: { id: string }, x: unknown) {
      return `${this.id}:${String(x)}`;
    });
    const throttled = throttle(fn, 50);
    expect(throttled.call({ id: "lead" }, "a")).toBe("lead:a");
    throttled.call({ id: "trail" }, "b");
    vi.advanceTimersByTime(50);
    expect(fn.mock.instances[1]).toEqual({ id: "trail" });
    expect(fn.mock.results[1]?.value).toBe("trail:b");
  });

  it("cancel drops a pending trailing invoke and does not call the function again", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    throttled("a");
    throttled("b");
    throttled.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush invokes pending trailing args immediately and returns that result", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    throttled("a");
    throttled("b");
    expect(throttled.flush()).toBe("b");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush returns lastResult without re-invoking when no timer is pending", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBe("a");
    expect(throttled.flush()).toBe("a");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush on a never-called throttle returns undefined", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    expect(throttled.flush()).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("invokes immediately when remaining exceeds wait (clock moving backwards)", () => {
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBe("a");
    vi.setSystemTime(1_000_000 - 1_000);
    expect(throttled("b")).toBe("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("defers the first call when Date.now is still 0, matching lastCall's initial value", () => {
    vi.setSystemTime(0);
    const fn = vi.fn((x: unknown) => x);
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });
});

describe("last empty, single-element, and array-like", () => {
  it("returns undefined for null, undefined, empty arrays, and falsy length", () => {
    expect(last(null)).toBeUndefined();
    expect(last(undefined)).toBeUndefined();
    expect(last([])).toBeUndefined();
    expect(last("")).toBeUndefined();
    expect(last({ length: 0 })).toBeUndefined();
  });

  it("returns the only element of a one-item array, including falsy values", () => {
    expect(last(["solo"])).toBe("solo");
    expect(last([0])).toBe(0);
    expect(last([false])).toBe(false);
  });

  it("returns the final element of a multi-item array", () => {
    expect(last(["first", "middle", "last"])).toBe("last");
    expect(last([1, 2, 3])).toBe(3);
  });

  it("reads length-1 from strings, typed arrays, and generic array-likes", () => {
    expect(last("abc")).toBe("c");
    expect(last(new Uint8Array([9, 8, 7]))).toBe(7);
    const arrayLike: ArrayLike<string> = { 0: "a", 1: "b", 2: "c", length: 3 };
    expect(last(arrayLike)).toBe("c");
  });
});

describe("maxBy and minBy empty, ties, and NaN skip", () => {
  it("returns undefined for empty collections", () => {
    expect(maxBy([] as number[])).toBeUndefined();
    expect(minBy([] as number[])).toBeUndefined();
    expect(maxBy(new Set<number>())).toBeUndefined();
  });

  it("returns the sole numeric element", () => {
    expect(maxBy([4])).toBe(4);
    expect(minBy([4])).toBe(4);
    const only = { n: 42 };
    expect(maxBy([only], "n")).toBe(only);
    expect(minBy([only], "n")).toBe(only);
  });

  it("selects the strict maximum / minimum and keeps the first on a tie", () => {
    const items = [{ n: 1 }, { n: 9 }, { n: 4 }, { n: 9 }];
    expect(maxBy(items, "n")).toBe(items[1]);
    expect(minBy(items, "n")).toBe(items[0]);
    const first = { n: 5, id: "first" };
    const second = { n: 5, id: "second" };
    expect(maxBy([first, second], "n")).toBe(first);
    expect(minBy([first, second], "n")).toBe(first);
  });

  it("skips NaN iteratee values and returns undefined when every value is NaN", () => {
    const items = [{ n: Number.NaN }, { n: 2 }, { n: Number.NaN }, { n: 8 }];
    expect(maxBy(items, "n")).toBe(items[3]);
    expect(minBy(items, "n")).toBe(items[1]);
    expect(maxBy([{ n: Number.NaN }], "n")).toBeUndefined();
    expect(minBy(["x", "y"])).toBeUndefined();
  });

  it("accepts function, path, and identity iteratees, including numeric strings", () => {
    const items = [{ n: 1 }, { n: 4 }, { n: 2 }];
    expect(maxBy(items, (item) => item.n)).toBe(items[1]);
    expect(minBy(items, "n")).toBe(items[0]);
    expect(maxBy(["10", "2", "8"])).toBe("10");
    expect(minBy(["10", "2", "8"])).toBe("2");
  });
});

describe("range start, end, step, and empty intervals", () => {
  it("builds [0, end) when only end is given", () => {
    expect(range(4)).toEqual([0, 1, 2, 3]);
    expect(range(1)).toEqual([0]);
    expect(range(0)).toEqual([]);
    expect(range(-3)).toEqual([0, -1, -2]);
  });

  it("infers step 1 or -1 from the start/end direction", () => {
    expect(range(1, 5)).toEqual([1, 2, 3, 4]);
    expect(range(5, 1)).toEqual([5, 4, 3, 2]);
    expect(range(2, 2)).toEqual([]);
  });

  it("honors an explicit step, including a step that overshoots in one element", () => {
    expect(range(0, 5, 2)).toEqual([0, 2, 4]);
    expect(range(0, 5, 10)).toEqual([0]);
    expect(range(0, 1, 0.5)).toEqual([0, 0.5]);
  });

  it("returns [] when step is 0 or the step sign cannot make progress", () => {
    expect(range(0, 5, 0)).toEqual([]);
    expect(range(5, 1, 1)).toEqual([]);
    expect(range(1, 5, -1)).toEqual([]);
  });
});

describe("omit nullish source, listed keys, and missing keys", () => {
  it("returns a fresh empty object for null, undefined, and other falsy sources", () => {
    expect(omit(null, "a")).toEqual({});
    expect(omit(undefined, ["a"])).toEqual({});
    expect(omit(0 as unknown as Record<string, unknown>, "a")).toEqual({});
  });

  it("returns the remaining own keys for a string path or an array of paths", () => {
    expect(omit({ a: 1, b: 2, c: 3 }, "b")).toEqual({ a: 1, c: 3 });
    expect(omit({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ b: 2 });
  });

  it("leaves the object unchanged when the listed path is missing", () => {
    const source = { a: 1, b: 2 };
    expect(omit(source, "z")).toEqual({ a: 1, b: 2 });
    expect(omit(source, ["missing"])).toEqual({ a: 1, b: 2 });
    expect(source).toEqual({ a: 1, b: 2 });
  });

  it("does not mutate the source and returns a new object", () => {
    const source = { a: 1, b: 2 };
    const result = omit(source, "a");
    expect(result).toEqual({ b: 2 });
    expect(result).not.toBe(source);
    expect(source).toEqual({ a: 1, b: 2 });
  });

  it("copies every own enumerable key when the path list is empty", () => {
    expect(omit({ a: 1, b: 2 }, [])).toEqual({ a: 1, b: 2 });
  });
});

describe("sumBy empty, coercion, and NaN-as-zero", () => {
  it("returns 0 for empty and nullish collections", () => {
    expect(sumBy([])).toBe(0);
    expect(sumBy(null as unknown as number[])).toBe(0);
    expect(sumBy(new Set<number>())).toBe(0);
  });

  it("returns the only numeric identity element and 0 when that element is NaN", () => {
    expect(sumBy([7])).toBe(7);
    expect(sumBy([Number.NaN])).toBe(0);
  });

  it("adds Number-coerced values and treats NaN contributions as 0", () => {
    expect(sumBy([3, 1, 2])).toBe(6);
    expect(sumBy(["10", "2", "3"])).toBe(15);
    expect(sumBy([null, 2, 1])).toBe(3);
    expect(sumBy([true, false, true])).toBe(2);
    expect(sumBy([{ n: 1 }, { n: Number.NaN }, { n: 4 }], "n")).toBe(5);
  });

  it("totals Infinity as an IEEE value, including a NaN total of infinities", () => {
    expect(sumBy([Number.POSITIVE_INFINITY, 1])).toBe(Number.POSITIVE_INFINITY);
    expect(
      Number.isNaN(sumBy([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])),
    ).toBe(true);
  });

  it("accepts function and path iteratees", () => {
    const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(sumBy(items, (item) => item.n)).toBe(6);
    expect(sumBy(items, "n")).toBe(6);
  });
});
