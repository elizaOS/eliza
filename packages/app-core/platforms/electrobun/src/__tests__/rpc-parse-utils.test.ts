/** Verifies the Electrobun RPC boundary's strict primitive and record parsers. */

import { describe, expect, it } from "vitest";
import {
  finiteNumber,
  hasBooleanFields,
  isRecord,
  nullableString,
  optionalFiniteNumber,
  optionalString,
  parseStringArray,
  requiredBoolean,
  requiredString,
} from "../rpc-parse-utils.ts";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it("rejects non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("finiteNumber", () => {
  it("accepts finite numbers", () => {
    expect(finiteNumber(3.14)).toBe(3.14);
    expect(finiteNumber(0)).toBe(0);
  });
  it("rejects non-finite and non-numbers", () => {
    expect(finiteNumber(NaN)).toBeNull();
    expect(finiteNumber(Infinity)).toBeNull();
    expect(finiteNumber("3")).toBeNull();
  });
});

describe("nullableString", () => {
  it("handles null, strings, and other types", () => {
    expect(nullableString(null)).toBeNull();
    expect(nullableString("hi")).toBe("hi");
    expect(nullableString(42)).toBeUndefined();
  });
});

describe("parseStringArray", () => {
  it("parses homogeneous string arrays", () => {
    expect(parseStringArray(["a", "b"])).toEqual(["a", "b"]);
  });
  it("returns null for non-arrays and mixed arrays", () => {
    expect(parseStringArray("x")).toBeNull();
    expect(parseStringArray(["a", 2])).toBeNull();
    expect(parseStringArray([])).toEqual([]);
  });
});

describe("optionalString", () => {
  it("returns undefined for undefined, string for strings, false otherwise", () => {
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString("ok")).toBe("ok");
    expect(optionalString(5)).toBe(false);
  });
});

describe("requiredString / requiredBoolean", () => {
  it("extracts present fields and null for missing/wrong types", () => {
    expect(requiredString({ name: "x" }, "name")).toBe("x");
    expect(requiredString({ name: 5 }, "name")).toBeNull();
    expect(requiredString({}, "name")).toBeNull();
    expect(requiredBoolean({ flag: true }, "flag")).toBe(true);
    expect(requiredBoolean({ flag: "yes" }, "flag")).toBeNull();
  });
});

describe("hasBooleanFields", () => {
  it("checks all keys are booleans", () => {
    expect(hasBooleanFields({ a: true, b: false }, ["a", "b"])).toBe(true);
    expect(hasBooleanFields({ a: true, b: 1 }, ["a", "b"])).toBe(false);
    expect(hasBooleanFields({}, [])).toBe(true);
  });
});

describe("optionalFiniteNumber", () => {
  it("returns undefined for undefined, number for finite, false otherwise", () => {
    expect(optionalFiniteNumber(undefined)).toBeUndefined();
    expect(optionalFiniteNumber(2.5)).toBe(2.5);
    expect(optionalFiniteNumber(NaN)).toBe(false);
    expect(optionalFiniteNumber("2")).toBe(false);
  });
});
