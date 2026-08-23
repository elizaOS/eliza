/**
 * Unit tests for the `es-toolkit/compat/omit` browser shim. The suite drives
 * the real re-export (named and default) and records nullish/falsy sources,
 * string vs array path lists, missing-key no-ops, Object.keys ordering, shallow
 * copies, and the own-enumerable-only copy the lodash-compatible reimplementation
 * actually performs. There is no comparator, queue, or capacity API.
 */
import { describe, expect, it } from "vitest";

import omitDefault, { omit } from "./es-toolkit-compat-omit.js";

describe("es-toolkit-compat-omit exports", () => {
  it("re-exports the same function as both named omit and default", () => {
    expect(omit).toBeTypeOf("function");
    expect(omitDefault).toBe(omit);
  });

  it("omits through the default export identically to the named export", () => {
    const source = { keep: 1, drop: 2 };
    expect(omitDefault(source, "drop")).toEqual({ keep: 1 });
    expect(omitDefault(source, ["drop"])).toEqual(omit(source, "drop"));
  });
});

describe("omit nullish, falsy, and empty sources", () => {
  it("returns a fresh empty object for null and undefined", () => {
    const fromNull = omit(null, "a");
    const fromUndefined = omit(undefined, ["a", "b"]);
    expect(fromNull).toEqual({});
    expect(fromUndefined).toEqual({});
    expect(fromNull).not.toBe(fromUndefined);
  });

  it("returns {} when the runtime source is falsy (the `!object` gate)", () => {
    expect(omit(false as unknown as Record<string, unknown>, "a")).toEqual({});
    expect(omit(0 as unknown as Record<string, unknown>, "a")).toEqual({});
    expect(omit("" as unknown as Record<string, unknown>, "a")).toEqual({});
  });

  it("returns {} for an empty object and an empty array", () => {
    expect(omit({}, "a")).toEqual({});
    expect(omit({} as Record<string, unknown>, [])).toEqual({});
    expect(omit([] as unknown as Record<string, unknown>, "0")).toEqual({});
  });
});

describe("omit single key, many keys, and missing keys", () => {
  it("returns the remaining own keys when omitting one listed string path", () => {
    expect(omit({ a: 1, b: 2, c: 3 }, "b")).toEqual({ a: 1, c: 3 });
  });

  it("returns the only remaining key when the source has two own keys", () => {
    expect(omit({ keep: "yes", drop: "no" }, "drop")).toEqual({ keep: "yes" });
  });

  it("returns {} when every own key is listed", () => {
    expect(omit({ a: 1 }, "a")).toEqual({});
    expect(omit({ a: 1, b: 2 }, ["a", "b"])).toEqual({});
  });

  it("omits every listed array path and ignores duplicate listings", () => {
    const source = { a: 1, b: 2, c: 3 };
    expect(omit(source, ["a", "c"])).toEqual({ b: 2 });
    expect(omit(source, ["a", "a"])).toEqual({ b: 2, c: 3 });
  });

  it("leaves the object unchanged when the listed path is missing", () => {
    const source = { a: 1, b: 2 };
    expect(omit(source, "z")).toEqual({ a: 1, b: 2 });
    expect(omit(source, ["missing", "also-missing"])).toEqual({ a: 1, b: 2 });
  });

  it("copies every own enumerable key when the path list is empty", () => {
    expect(omit({ a: 1, b: 2 }, [])).toEqual({ a: 1, b: 2 });
  });

  it("omits an empty-string key only when that own key is listed", () => {
    const source = { "": 1, a: 2 };
    expect(omit(source, "")).toEqual({ a: 2 });
    expect(omit(source, "a")).toEqual({ "": 1 });
  });
});

describe("omit copy identity, order, and preserved values", () => {
  it("returns a new object and does not mutate the source", () => {
    const nested = { x: 1 };
    const source = { keep: nested, drop: 2 };
    const result = omit(source, "drop");
    expect(result).not.toBe(source);
    expect(source).toEqual({ keep: nested, drop: 2 });
    expect(result.keep).toBe(nested);
    expect(result).toEqual({ keep: nested });
  });

  it("preserves Object.keys insertion order of the keys that remain", () => {
    const source = { z: 1, a: 2, m: 3 };
    expect(Object.keys(omit(source, "a"))).toEqual(["z", "m"]);
    expect(Object.keys(omit(source, []))).toEqual(["z", "a", "m"]);
  });

  it("preserves falsy own values that are not omitted, including undefined", () => {
    const source = {
      a: 0,
      b: false,
      c: "",
      d: null,
      e: undefined,
      f: 1,
    };
    const result = omit(source, "f");
    expect(result).toEqual({
      a: 0,
      b: false,
      c: "",
      d: null,
      e: undefined,
    });
    expect(Object.hasOwn(result, "e")).toBe(true);
    expect(result.e).toBeUndefined();
  });

  it("materialises an enumerable getter as a data property on the copy", () => {
    const source: Record<string, unknown> = { keep: 1 };
    Object.defineProperty(source, "got", {
      enumerable: true,
      get: () => 7,
    });
    expect(omit(source, "keep")).toEqual({ got: 7 });
  });

  it("copies many remaining keys with no capacity or overflow cap", () => {
    const source: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      source[`k${index}`] = index;
    }
    const result = omit(source, ["k0", "k39"]);
    expect(Object.keys(result)).toHaveLength(38);
    expect(result.k1).toBe(1);
    expect(result.k38).toBe(38);
    expect(result.k0).toBeUndefined();
    expect(result.k39).toBeUndefined();
  });
});

describe("omit own-enumerable copy and literal path matching", () => {
  it("does not copy inherited enumerable keys", () => {
    const source = Object.create({ inherited: 9 }) as Record<string, unknown>;
    source.own = 1;
    expect(omit(source, [])).toEqual({ own: 1 });
    expect(omit(source, "own")).toEqual({});
  });

  it("drops symbol own keys because Object.keys never yields them", () => {
    const source: Record<string, unknown> = { a: 1 };
    const key = Symbol("s");
    Object.defineProperty(source, key, {
      value: 2,
      enumerable: true,
    });
    const result = omit(source, []);
    expect(result).toEqual({ a: 1 });
    expect(Object.getOwnPropertySymbols(result)).toEqual([]);
  });

  it("drops non-enumerable own keys because Object.keys skips them", () => {
    const source: Record<string, unknown> = { visible: 2 };
    Object.defineProperty(source, "secret", {
      value: 1,
      enumerable: false,
    });
    expect(omit(source, [])).toEqual({ visible: 2 });
  });

  it("treats a dotted path as a literal own key, not a nested walk", () => {
    const source = { a: { b: 1 }, "a.b": 9, b: 2 };
    expect(omit(source, "a.b")).toEqual({ a: { b: 1 }, b: 2 });
    expect(omit(source, ["a.b"])).toEqual({ a: { b: 1 }, b: 2 });
    expect(omit({ a: { b: 1 }, b: 2 }, "a.b")).toEqual({ a: { b: 1 }, b: 2 });
  });

  it("omits array index keys via Object.keys string names", () => {
    expect(
      omit(["x", "y", "z"] as unknown as Record<string, unknown>, "1"),
    ).toEqual({
      0: "x",
      2: "z",
    });
  });

  it("does not create an own __proto__ key when copying that enumerable name", () => {
    const source: Record<string, unknown> = { a: 1 };
    Object.defineProperty(source, "__proto__", {
      value: "x",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.keys(source).sort()).toEqual(["__proto__", "a"]);
    expect(omit(source, "__proto__")).toEqual({ a: 1 });
    expect(omit(source, "a")).toEqual({});
    expect(Object.hasOwn(omit(source, "a"), "__proto__")).toBe(false);
  });
});
