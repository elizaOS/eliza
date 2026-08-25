/**
 * Unit tests for the browser `es-toolkit/compat/isPlainObject` re-export shim.
 * The suite imports the real module (named and default) and asserts the
 * prototype/`[object Object]` contract callers use to distinguish plain records
 * from arrays, class instances, tagged objects, and primitives.
 */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import isPlainObjectDefault, {
  isPlainObject,
} from "./es-toolkit-compat-isPlainObject";

describe("es-toolkit-compat-isPlainObject exports", () => {
  it("exposes the same function as the named and default export", () => {
    expect(typeof isPlainObject).toBe("function");
    expect(typeof isPlainObjectDefault).toBe("function");
    expect(isPlainObjectDefault).toBe(isPlainObject);
  });
});

describe("isPlainObject accepts plain records", () => {
  it("accepts object literals, Object instances, and Object.prototype", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ key: "val" })).toBe(true);
    expect(isPlainObject(new Object())).toBe(true);
    expect(isPlainObject(Object.create(Object.prototype))).toBe(true);
    expect(isPlainObject(Object.prototype)).toBe(true);
  });

  it("accepts null-prototype objects", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(Object.setPrototypeOf({ a: 1 }, null))).toBe(true);
  });

  it("does not consult constructor, including a throwing getter", () => {
    const withArrayConstructor = { constructor: Array };
    expect(isPlainObject(withArrayConstructor)).toBe(true);

    const hostile = {};
    Object.defineProperty(hostile, "constructor", {
      get: () => {
        throw new Error("constructor getter must not run");
      },
    });
    expect(isPlainObject(hostile)).toBe(true);
  });

  it("narrows the value to a string-keyed record", () => {
    const value: unknown = { a: 1 };
    expect(isPlainObject(value)).toBe(true);
    if (isPlainObject(value)) {
      expect(value.a).toBe(1);
    }
  });
});

describe("isPlainObject rejects non-plain values", () => {
  it("rejects falsy primitives that fail the truthiness gate", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(false)).toBe(false);
    expect(isPlainObject(0)).toBe(false);
    expect(isPlainObject(-0)).toBe(false);
    expect(isPlainObject(0n)).toBe(false);
    expect(isPlainObject("")).toBe(false);
    expect(isPlainObject(Number.NaN)).toBe(false);
  });

  it("rejects truthy primitives, functions, and arrays", () => {
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(Symbol("sym"))).toBe(false);
    expect(isPlainObject(100n)).toBe(false);
    expect(isPlainObject(() => {})).toBe(false);
    expect(isPlainObject(function named() {})).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it("rejects built-ins whose toString tag is not [object Object]", () => {
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(/regex/)).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    expect(isPlainObject(new WeakMap())).toBe(false);
    expect(isPlainObject(new WeakSet())).toBe(false);
    expect(isPlainObject(new Error("err"))).toBe(false);
    expect(isPlainObject(Promise.resolve())).toBe(false);
    expect(isPlainObject(new Uint8Array())).toBe(false);
    expect(isPlainObject(new Number(1))).toBe(false);
    expect(isPlainObject(new String("x"))).toBe(false);
    expect(isPlainObject(new Boolean(true))).toBe(false);
    expect(isPlainObject(Buffer.from("x"))).toBe(false);
  });

  it("rejects class instances and objects whose prototype is neither null nor Object.prototype", () => {
    class CustomClass {
      foo = "bar";
    }
    expect(isPlainObject(new CustomClass())).toBe(false);
    expect(isPlainObject(Object.create({}))).toBe(false);

    const spoofedPrototype = { constructor: Object };
    expect(isPlainObject(Object.create(spoofedPrototype))).toBe(false);

    const hostilePrototype = Object.create(null);
    Object.defineProperty(hostilePrototype, "constructor", {
      get: () => {
        throw new Error("constructor getter must not run");
      },
    });
    expect(isPlainObject(Object.create(hostilePrototype))).toBe(false);
  });

  it("rejects objects whose @@toStringTag is not Object", () => {
    const tagged = { [Symbol.toStringTag]: "Foo" };
    expect(isPlainObject(tagged)).toBe(false);
  });

  it("rejects plain objects created in another vm realm", () => {
    const foreign = runInContext("({ a: 1 })", createContext());
    expect(isPlainObject(foreign)).toBe(false);
  });
});
