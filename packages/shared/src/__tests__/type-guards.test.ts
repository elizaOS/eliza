import { describe, expect, it } from "vitest";
import {
  asNonEmptyString,
  asObjectArray,
  asRecord,
  asRecordOrUndefined,
  isPlainObject,
} from "./type-guards.ts";

describe("isPlainObject", () => {
  it("accepts plain objects only", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe("asRecord", () => {
  it("narrows objects to records", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asRecord(0)).toBeNull();
  });
});

describe("asRecordOrUndefined", () => {
  it("maps null to undefined", () => {
    expect(asRecordOrUndefined(null)).toBeUndefined();
    expect(asRecordOrUndefined({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("asObjectArray", () => {
  it("filters non-object entries", () => {
    expect(asObjectArray([{ a: 1 }, "x", null, [1], { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(asObjectArray("not-array")).toEqual([]);
  });
});

describe("asNonEmptyString", () => {
  it("trims and rejects empties", () => {
    expect(asNonEmptyString(" hello ")).toBe("hello");
    expect(asNonEmptyString("")).toBeUndefined();
    expect(asNonEmptyString("   ")).toBeUndefined();
    expect(asNonEmptyString(42)).toBeUndefined();
  });
});
