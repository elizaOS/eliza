/**
 * Unit coverage for goals SQL value coercers.
 *
 * Behavioral risk: these helpers shape untrusted DB/JSON values into typed
 * primitives for the goals back-end. A wrong coercion (e.g. `"false"` treated
 * as truthy, `NaN` accepted as a number, JSON arrays passed as objects)
 * would silently corrupt goal records or crash the write path.
 */
import { describe, expect, it } from "vitest";
import {
  asObject,
  parseJsonRecord,
  parseJsonValue,
  toBoolean,
  toNumber,
  toText,
} from "./sql.ts";

describe("asObject", () => {
  it("returns null for null/undefined", () => {
    expect(asObject(null)).toBeNull();
    expect(asObject(undefined)).toBeNull();
  });

  it("returns null for non-objects", () => {
    expect(asObject("str")).toBeNull();
    expect(asObject(42)).toBeNull();
    expect(asObject(true)).toBeNull();
  });

  it("returns null for arrays", () => {
    expect(asObject([])).toBeNull();
    expect(asObject([1, 2])).toBeNull();
  });

  it("passes plain objects through", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("toText", () => {
  it("passes strings through", () => {
    expect(toText("hello")).toBe("hello");
  });

  it("uses the fallback for null/undefined", () => {
    expect(toText(null, "fb")).toBe("fb");
    expect(toText(undefined, "fb")).toBe("fb");
  });

  it("stringifies numbers and booleans", () => {
    expect(toText(42)).toBe("42");
    expect(toText(true)).toBe("true");
    expect(toText(0)).toBe("0");
  });
});

describe("toNumber", () => {
  it("passes finite numbers through", () => {
    expect(toNumber(3.5)).toBe(3.5);
    expect(toNumber(0)).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber("-1.5")).toBe(-1.5);
  });

  it("rejects non-finite numbers", () => {
    expect(toNumber(Number.NaN, 7)).toBe(7);
    expect(toNumber(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });

  it("falls back for unparseable input", () => {
    expect(toNumber("abc", 7)).toBe(7);
    expect(toNumber(null, 7)).toBe(7);
    expect(toNumber({}, 7)).toBe(7);
  });
});

describe("toBoolean", () => {
  it("passes booleans through", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });

  it("treats non-zero numbers as true", () => {
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(-3)).toBe(true);
    expect(toBoolean(0)).toBe(false);
  });

  it("parses truthy string spellings case-insensitively", () => {
    for (const v of ["1", "true", "yes", "on", " TRUE ", "Yes", "ON"]) {
      expect(toBoolean(v)).toBe(true);
    }
  });

  it("parses falsy string spellings", () => {
    for (const v of ["0", "false", "no", "off", " FALSE "]) {
      expect(toBoolean(v)).toBe(false);
    }
  });

  it("falls back for unknown spellings", () => {
    expect(toBoolean("maybe", true)).toBe(true);
    expect(toBoolean("maybe", false)).toBe(false);
  });
});

describe("parseJsonValue", () => {
  it("returns fallback for missing JSON values", () => {
    expect(parseJsonValue(null, "fb")).toBe("fb");
    expect(parseJsonValue(undefined, "fb")).toBe("fb");
    expect(parseJsonValue("", "fb")).toBe("fb");
  });

  it("passes objects through untouched", () => {
    const obj = { x: 1 };
    expect(parseJsonValue(obj, null)).toBe(obj);
  });

  it("parses JSON strings", () => {
    expect(parseJsonValue('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJsonValue("[1,2]", [])).toEqual([1, 2]);
  });

  it("throws a prefixed error on invalid JSON strings", () => {
    expect(() => parseJsonValue("{oops", null)).toThrow(
      /\[GoalsSql\] Invalid JSON value/,
    );
  });

  it("throws on non-object, non-string scalars", () => {
    expect(() => parseJsonValue(42, null)).toThrow(
      /\[GoalsSql\] Expected JSON string or object, received number/,
    );
  });
});

describe("parseJsonRecord", () => {
  it("returns {} for missing values", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonRecord("")).toEqual({});
  });

  it("parses a JSON object string", () => {
    expect(parseJsonRecord('{"k":"v"}')).toEqual({ k: "v" });
  });

  it("throws for JSON arrays", () => {
    expect(() => parseJsonRecord("[1]")).toThrow(
      /\[GoalsSql\] Expected JSON object/,
    );
  });

  it("throws for JSON scalars", () => {
    expect(() => parseJsonRecord('"str"')).toThrow(
      /\[GoalsSql\] Expected JSON object/,
    );
  });
});
