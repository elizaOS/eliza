/**
 * Unit tests for the `es-toolkit/compat/last` browser shim. The suite drives
 * the real re-export (named and default) and asserts lodash-style last-element
 * reads for arrays, strings, and array-likes, including empty/nullish input
 * and falsy last values the length gate still returns.
 */
import { describe, expect, it } from "vitest";

import defaultLast, { last } from "./es-toolkit-compat-last.js";

describe("es-toolkit-compat-last exports", () => {
  it("re-exports the same function as both named last and default", () => {
    expect(last).toBeTypeOf("function");
    expect(defaultLast).toBe(last);
  });
});

describe("last empty and nullish collection", () => {
  it("returns undefined for null and undefined", () => {
    expect(last(null)).toBeUndefined();
    expect(last(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty array and empty string", () => {
    expect(last([])).toBeUndefined();
    expect(last("")).toBeUndefined();
  });

  it("returns undefined when length is missing or falsy", () => {
    expect(last({} as ArrayLike<unknown>)).toBeUndefined();
    expect(last({ length: 0 })).toBeUndefined();
    expect(last({ 0: "present", length: 0 })).toBeUndefined();
    expect(last({ 0: "present", length: Number.NaN })).toBeUndefined();
  });
});

describe("last single and ordered collections", () => {
  it("returns the only element of a one-item array", () => {
    expect(last(["solo"])).toBe("solo");
    expect(last([0])).toBe(0);
  });

  it("returns the final element, not the first, of a multi-item array", () => {
    expect(last(["first", "middle", "last"])).toBe("last");
    expect(last([1, 2, 3])).toBe(3);
  });

  it("returns a falsy last element when length is truthy", () => {
    expect(last([1, 0])).toBe(0);
    expect(last([1, ""])).toBe("");
    expect(last([1, false])).toBe(false);
    expect(last([1, null])).toBeNull();
    expect(last([1, undefined])).toBeUndefined();
  });
});

describe("last array-like values", () => {
  it("returns the last character of a non-empty string", () => {
    expect(last("a")).toBe("a");
    expect(last("abc")).toBe("c");
  });

  it("reads length-1 from a generic array-like object", () => {
    const arrayLike: ArrayLike<string> = { 0: "a", 1: "b", 2: "c", length: 3 };
    expect(last(arrayLike)).toBe("c");
  });

  it("ignores own keys past length when indexing the last slot", () => {
    const arrayLike: ArrayLike<string> = {
      0: "a",
      1: "b",
      5: "ignored",
      length: 2,
    };
    expect(last(arrayLike)).toBe("b");
  });

  it("returns the last typed-array byte", () => {
    expect(last(new Uint8Array([9, 8, 7]))).toBe(7);
    expect(last(new Uint8Array(0))).toBeUndefined();
  });

  it("returns the last arguments value", () => {
    const fromArguments = (...values: number[]) => last(values);
    expect(fromArguments()).toBeUndefined();
    expect(fromArguments(10)).toBe(10);
    expect(fromArguments(10, 20, 30)).toBe(30);
  });
});

describe("last sparse arrays", () => {
  it("returns the assigned last slot when earlier indexes are holes", () => {
    const sparse: string[] = [];
    sparse[2] = "tail";
    expect(last(sparse)).toBe("tail");
  });

  it("returns undefined when the last index is a hole", () => {
    const sparse: Array<string | undefined> = [];
    sparse[0] = "head";
    sparse.length = 3;
    expect(last(sparse)).toBeUndefined();
  });
});
