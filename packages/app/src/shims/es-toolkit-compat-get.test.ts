/**
 * Unit tests for the `es-toolkit/compat/get` browser shim. The suite drives
 * the real re-export (named and default) and asserts lodash-style path reads,
 * defaultValue fallback, prototype-pollution key rejection, and the string
 * path grammar the Vite alias maps this module onto.
 */
import { describe, expect, it } from "vitest";
import defaultGet, { get } from "./es-toolkit-compat-get.js";

describe("es-toolkit-compat-get exports", () => {
  it("exposes the same function as the named and default export", () => {
    expect(typeof get).toBe("function");
    expect(typeof defaultGet).toBe("function");
    expect(defaultGet).toBe(get);
  });
});

describe("get nullish source", () => {
  it("returns undefined when the source is null or undefined and no default is given", () => {
    expect(get(null, "a")).toBeUndefined();
    expect(get(undefined, "a.b")).toBeUndefined();
    expect(get(null, ["a"])).toBeUndefined();
  });

  it("returns defaultValue when the source is null or undefined", () => {
    expect(get(null, "a", "fallback")).toBe("fallback");
    expect(get(undefined, ["a", "b"], 0)).toBe(0);
  });
});

describe("get simple and array paths", () => {
  const source = {
    a: { b: { c: 3 } },
    items: [{ name: "first" }, { name: "second" }],
    zero: 0,
    empty: "",
    flag: false,
    none: null,
    missing: undefined,
  };

  it("reads a single own key", () => {
    expect(get({ a: 1 }, "a")).toBe(1);
  });

  it("reads a nested dot path", () => {
    expect(get(source, "a.b.c")).toBe(3);
  });

  it("reads an array path", () => {
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

  it("reads an empty-string key only when that own key exists", () => {
    expect(get({ "": "empty-key" }, "")).toBe("empty-key");
    expect(get(source, "")).toBeUndefined();
  });
});

describe("get defaultValue", () => {
  const source = {
    zero: 0,
    empty: "",
    flag: false,
    none: null,
    missing: undefined,
  };

  it("returns defaultValue for a missing path", () => {
    expect(get(source, "nope", "fallback")).toBe("fallback");
    expect(get(source, "a.b.c", "fallback")).toBe("fallback");
    expect(get(source, ["zero", "child"], "fallback")).toBe("fallback");
  });

  it("returns defaultValue when the resolved value is undefined", () => {
    expect(get(source, "missing", "fallback")).toBe("fallback");
  });

  it("preserves falsy values that are not undefined", () => {
    expect(get(source, "zero", "fallback")).toBe(0);
    expect(get(source, "empty", "fallback")).toBe("");
    expect(get(source, "flag", "fallback")).toBe(false);
    expect(get(source, "none", "fallback")).toBeNull();
  });

  it("returns defaultValue when an intermediate value is nullish", () => {
    expect(get({ a: null }, "a.b", "fallback")).toBe("fallback");
    expect(get({ a: undefined }, "a.b", "fallback")).toBe("fallback");
    expect(get({ a: { b: null } }, ["a", "b", "c"], "fallback")).toBe(
      "fallback",
    );
  });

  it("returns defaultValue for a hole in a sparse array", () => {
    const sparse: unknown[] = [];
    sparse[1] = "present";
    expect(get(sparse, 0, "fallback")).toBe("fallback");
    expect(get(sparse, 1, "fallback")).toBe("present");
  });
});

describe("get string path grammar", () => {
  it("walks bracket numeric indexes mixed with dots", () => {
    const source = { items: [{ name: "n0" }, { name: "n1" }] };
    expect(get(source, "items[1].name")).toBe("n1");
    expect(get(source, "[0][0][0]", "fallback")).toBe("fallback");
    expect(get([[["z"]]], "[0][0][0]")).toBe("z");
    expect(get([[["z"]]], "0.0.0")).toBe("z");
  });

  it("reads quoted bracket keys that contain dots", () => {
    const source = { a: { "b.c": 11, "d'e": 12 } };
    expect(get(source, 'a["b.c"]')).toBe(11);
    expect(get(source, "a['d\\'e']")).toBe(12);
  });

  it("unescapes quoted bracket contents", () => {
    const source = { a: { 'x"y': 13 } };
    expect(get(source, 'a["x\\"y"]')).toBe(13);
  });

  it("treats a bracket number as a string key, including negatives", () => {
    expect(get({ a: { "-1": "neg" } }, "a[-1]")).toBe("neg");
    expect(get([1, 2, 3], "[-1]", "fallback")).toBe("fallback");
    expect(get({ a: { "1.5": "frac" } }, "a[1.5]")).toBe("frac");
  });

  it("returns the source for a path of only dots, which parses to no segments", () => {
    const source = { a: 1 };
    expect(get(source, ".")).toBe(source);
    expect(get(source, "..")).toBe(source);
  });
});

describe("get prototype-pollution guards", () => {
  it("refuses __proto__, constructor, and prototype string segments", () => {
    expect(get({}, "__proto__", "fallback")).toBe("fallback");
    expect(
      get({ constructor: { name: "own" } }, "constructor"),
    ).toBeUndefined();
    expect(
      get({ constructor: { name: "own" } }, "constructor", "fallback"),
    ).toBe("fallback");
    expect(get({ prototype: { x: 1 } }, "prototype", "fallback")).toBe(
      "fallback",
    );
  });

  it("stops walking when an unsafe segment appears in the middle of a path", () => {
    const source = { a: { b: 2 } };
    expect(get(source, "a.constructor.b", "fallback")).toBe("fallback");
    expect(get(source, ["a", "__proto__", "b"], "fallback")).toBe("fallback");
    expect(get(source, ["a", "prototype"], "fallback")).toBe("fallback");
  });

  it("does not treat a differently cased name as unsafe", () => {
    expect(get({ Constructor: 4 }, "Constructor")).toBe(4);
    expect(get({ Prototype: 5 }, "Prototype")).toBe(5);
  });
});
