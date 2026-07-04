/**
 * Runtime type guards used to validate untrusted/unknown payloads at boundaries
 * before they're treated as records. They must distinguish plain objects from
 * arrays and null, and asNonEmptyString must reject whitespace-only strings so
 * blank values don't pass as present.
 */
import { describe, expect, it } from "vitest";
import {
  asNonEmptyString,
  asObjectArray,
  asRecord,
  asRecordOrUndefined,
  isPlainObject,
} from "./type-guards.ts";

describe("isPlainObject", () => {
  it("accepts plain objects, rejects arrays / null / primitives", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe("asRecord / asRecordOrUndefined", () => {
  it("returns the object or null/undefined for non-records", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecordOrUndefined([])).toBeUndefined();
    expect(asRecordOrUndefined(obj)).toBe(obj);
  });
});

describe("asObjectArray", () => {
  it("keeps only the record elements, drops primitives/arrays/null", () => {
    expect(asObjectArray([{ a: 1 }, "x", null, [1], { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(asObjectArray("not array")).toEqual([]);
  });
});

describe("asNonEmptyString", () => {
  it("trims and returns the string, undefined when blank or non-string", () => {
    expect(asNonEmptyString("  hi  ")).toBe("hi");
    expect(asNonEmptyString("   ")).toBeUndefined();
    expect(asNonEmptyString("")).toBeUndefined();
    expect(asNonEmptyString(123)).toBeUndefined();
  });
});
