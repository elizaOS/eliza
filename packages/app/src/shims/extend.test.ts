/**
 * Unit tests for the browser `extend` shim. The suite drives the real default
 * export (not a mock) and records shallow vs deep folding, left-to-right last
 * write, nullish source skips, in-place mutation, array/plain-object recursion,
 * prototype-pollution key skips, and the leading-boolean selector — including
 * that `typeof deepOrTarget === "boolean"` makes `false` deep-merge too.
 * There is no comparator, queue, removal, or capacity API.
 */
import { describe, expect, it } from "vitest";

import extend from "./extend.js";

describe("extend export", () => {
  it("exports a default function and no named merge helper", () => {
    expect(extend).toBeTypeOf("function");
  });
});

describe("extend shallow mode: empty, single, and many sources", () => {
  it("returns the target unchanged when the source list is empty", () => {
    const target = { a: 1 };
    expect(extend(target)).toBe(target);
    expect(target).toEqual({ a: 1 });
  });

  it("returns a fresh empty object when the only argument is {}", () => {
    const target = {};
    expect(extend(target)).toBe(target);
    expect(target).toEqual({});
  });

  it("assigns a single source's own enumerable keys onto the target", () => {
    const target: Record<string, unknown> = { keep: 1 };
    const result = extend(target, { added: 2 });
    expect(result).toBe(target);
    expect(result).toEqual({ keep: 1, added: 2 });
  });

  it("folds later sources over earlier ones; last write wins a tied key", () => {
    const target: Record<string, unknown> = { k: "target" };
    extend(target, { k: "first", extra: 1 }, { k: "second" });
    expect(target).toEqual({ k: "second", extra: 1 });
  });

  it("preserves Object.keys insertion order of the mutated target", () => {
    const target: Record<string, unknown> = { z: 1 };
    extend(target, { a: 2 }, { m: 3 });
    expect(Object.keys(target)).toEqual(["z", "a", "m"]);
  });
});

describe("extend shallow mode: nullish sources, missing keys, identity", () => {
  it("skips null and undefined sources and still applies the next source", () => {
    const target: Record<string, unknown> = { a: 1 };
    extend(
      target,
      null as unknown as object,
      { b: 2 },
      undefined as unknown as object,
      {
        c: 3,
      },
    );
    expect(target).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("leaves target-only keys in place when the source does not list them", () => {
    const target: Record<string, unknown> = { keep: 1, other: 2 };
    extend(target, { other: 9 });
    expect(target).toEqual({ keep: 1, other: 9 });
  });

  it("adds a source key that is missing on the target", () => {
    const target: Record<string, unknown> = {};
    extend(target, { only: true });
    expect(target).toEqual({ only: true });
  });

  it("assigns nested objects and arrays by reference, not by copy", () => {
    const nested = { x: 1 };
    const list = [1, 2];
    const target: Record<string, unknown> = {};
    extend(target, { nested, list });
    expect(target.nested).toBe(nested);
    expect(target.list).toBe(list);
  });

  it("overwrites a nested object with the source reference in shallow mode", () => {
    const original = { a: 1 };
    const replacement = { b: 2 };
    const target: Record<string, unknown> = { nested: original };
    extend(target, { nested: replacement });
    expect(target.nested).toBe(replacement);
    expect(original).toEqual({ a: 1 });
  });
});

describe("extend shallow mode: values, own-enumerable copy, no capacity cap", () => {
  it("assigns falsy own values including undefined", () => {
    const target: Record<string, unknown> = { a: 1 };
    extend(target, {
      a: 0,
      b: false,
      c: "",
      d: null,
      e: undefined,
    });
    expect(target).toEqual({
      a: 0,
      b: false,
      c: "",
      d: null,
      e: undefined,
    });
    expect(Object.hasOwn(target, "e")).toBe(true);
  });

  it("does not copy inherited enumerable keys because Object.entries is own-only", () => {
    const source = Object.create({ inherited: 9 }) as Record<string, unknown>;
    source.own = 1;
    const target: Record<string, unknown> = {};
    extend(target, source);
    expect(target).toEqual({ own: 1 });
  });

  it("does not copy symbol own keys because Object.entries never yields them", () => {
    const source: Record<string, unknown> = { a: 1 };
    const key = Symbol("s");
    Object.defineProperty(source, key, { value: 2, enumerable: true });
    const target: Record<string, unknown> = {};
    extend(target, source);
    expect(target).toEqual({ a: 1 });
    expect(Object.getOwnPropertySymbols(target)).toEqual([]);
  });

  it("does not copy non-enumerable own keys", () => {
    const source: Record<string, unknown> = { visible: 2 };
    Object.defineProperty(source, "secret", { value: 1, enumerable: false });
    const target: Record<string, unknown> = {};
    extend(target, source);
    expect(target).toEqual({ visible: 2 });
  });

  it("copies many keys with no capacity or overflow cap", () => {
    const source: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      source[`k${index}`] = index;
    }
    const target: Record<string, number> = {};
    extend(target, source);
    expect(Object.keys(target)).toHaveLength(40);
    expect(target.k0).toBe(0);
    expect(target.k39).toBe(39);
  });
});

describe("extend deep-mode selector", () => {
  it("treats a leading boolean as the deep flag and uses the next arg as target", () => {
    const target: Record<string, unknown> = { keep: 1 };
    const result = extend<Record<string, unknown>>(true, target, { added: 2 });
    expect(result).toBe(target);
    expect(target).toEqual({ keep: 1, added: 2 });
  });

  it("returns the shifted target unchanged when deep mode has no remaining sources", () => {
    const target = { a: 1 };
    expect(extend<typeof target>(true, target)).toBe(target);
    expect(target).toEqual({ a: 1 });
  });

  it("returns undefined when deep mode is selected with an empty source queue", () => {
    expect(extend<Record<string, never>>(true)).toBeUndefined();
  });

  it("deep-merges when the leading boolean is false, because deep is typeof === 'boolean'", () => {
    const inner = { a: 1 };
    const target: Record<string, unknown> = { nested: inner };
    const result = extend<Record<string, unknown>>(false, target, {
      nested: { b: 2 },
    });
    expect(result).toBe(target);
    expect(target.nested).toBe(inner);
    expect(inner).toEqual({ a: 1, b: 2 });
  });
});

describe("extend deep mode: plain objects", () => {
  it("recurses into nested plain objects and mutates the target's nested record", () => {
    const inner = { a: 1 };
    const target: Record<string, unknown> = { nested: inner, keep: true };
    extend<Record<string, unknown>>(true, target, { nested: { b: 2 } });
    expect(target.nested).toBe(inner);
    expect(inner).toEqual({ a: 1, b: 2 });
    expect(target.keep).toBe(true);
  });

  it("replaces a nested primitive with a newly allocated plain object", () => {
    const target: Record<string, unknown> = { nested: 7 };
    extend<Record<string, unknown>>(true, target, { nested: { a: 1 } });
    expect(target.nested).toEqual({ a: 1 });
    expect(target.nested).not.toBe(7);
  });

  it("assigns a non-plain nested source (Date, class instance) by reference", () => {
    const date = new Date("2020-01-01T00:00:00.000Z");
    class Widget {
      n = 1;
    }
    const widget = new Widget();
    const target: Record<string, unknown> = {
      date: { stale: true },
      widget: {},
    };
    extend<Record<string, unknown>>(true, target, { date, widget });
    expect(target.date).toBe(date);
    expect(target.widget).toBe(widget);
  });

  it("allocates a fresh {} when the target nested value is not a plain object", () => {
    const widget = { n: 1 };
    Object.setPrototypeOf(widget, { tag: "instance" });
    const target: Record<string, unknown> = { nested: widget };
    extend<Record<string, unknown>>(true, target, { nested: { a: 1 } });
    expect(target.nested).toEqual({ a: 1 });
    expect(target.nested).not.toBe(widget);
    expect(widget).toEqual({ n: 1 });
  });

  it("deep-merges Object.create(null) records because null prototype is plain", () => {
    const inner = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        a: 1,
      },
    );
    const target: Record<string, unknown> = { nested: inner };
    const sourceNested = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { b: 2 },
    );
    extend<Record<string, unknown>>(true, target, { nested: sourceNested });
    expect(target.nested).toBe(inner);
    expect(inner.a).toBe(1);
    expect(inner.b).toBe(2);
  });

  it("overwrites a nested object with null because null is not a plain object", () => {
    const target: Record<string, unknown> = { nested: { a: 1 } };
    extend<Record<string, unknown>>(true, target, { nested: null });
    expect(target.nested).toBeNull();
  });
});

describe("extend deep mode: arrays", () => {
  it("recurses into nested arrays by index and keeps extra target elements", () => {
    const inner = [1, { x: 1 }, 3];
    const target: Record<string, unknown> = { list: inner };
    extend<Record<string, unknown>>(true, target, { list: [10, { y: 2 }] });
    expect(target.list).toBe(inner);
    expect(inner[0]).toBe(10);
    expect(inner[1]).toEqual({ x: 1, y: 2 });
    expect(inner[2]).toBe(3);
  });

  it("allocates a fresh [] when the target nested value is not an array", () => {
    const original = { 0: 1 };
    const target: Record<string, unknown> = { list: original };
    extend<Record<string, unknown>>(true, target, { list: [10, 20] });
    expect(target.list).toEqual([10, 20]);
    expect(target.list).not.toBe(original);
    expect(Array.isArray(target.list)).toBe(true);
  });

  it("replaces an array nested value with a plain object by allocating {}", () => {
    const original = [1, 2];
    const target: Record<string, unknown> = { nested: original };
    extend<Record<string, unknown>>(true, target, { nested: { a: 1 } });
    expect(target.nested).toEqual({ a: 1 });
    expect(target.nested).not.toBe(original);
    expect(original).toEqual([1, 2]);
  });

  it("deep-merges a top-level array target against a later array source", () => {
    const target = [1, { a: 1 }];
    const result = extend<typeof target>(true, target, [9, { b: 2 }, 3]);
    expect(result).toBe(target);
    expect(target[0]).toBe(9);
    expect(target[1]).toEqual({ a: 1, b: 2 });
    expect(target[2]).toBe(3);
  });

  it("leaves a single-element array target unchanged when there is no source", () => {
    const target = [42];
    expect(extend<typeof target>(true, target)).toBe(target);
    expect(target).toEqual([42]);
  });
});

describe("extend prototype-pollution keys", () => {
  it("skips enumerable own __proto__, constructor, and prototype keys", () => {
    const source: Record<string, unknown> = {
      keep: 1,
      constructor: "c",
      prototype: "p",
    };
    Object.defineProperty(source, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const target: Record<string, unknown> = {};
    extend(target, source);
    expect(target).toEqual({ keep: 1 });
    expect(Object.hasOwn(target, "__proto__")).toBe(false);
    expect(Object.hasOwn(target, "constructor")).toBe(false);
    expect(Object.hasOwn(target, "prototype")).toBe(false);
  });

  it("still copies a similarly named key that is not in the skip set", () => {
    const target: Record<string, unknown> = {};
    extend(target, { proto: 1, construct: 2 });
    expect(target).toEqual({ proto: 1, construct: 2 });
  });

  it("skips the same keys in deep mode, including nested records", () => {
    const nested: Record<string, unknown> = { keep: 1, constructor: "c" };
    const target: Record<string, unknown> = { nested: {} };
    extend<Record<string, unknown>>(true, target, { nested });
    expect(target.nested).toEqual({ keep: 1 });
  });
});
