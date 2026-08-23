import { describe, expect, it } from "vitest";
import {
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "./sql.ts";

describe("toText", () => {
  it("coerces values with fallback", () => {
    expect(toText("x")).toBe("x");
    expect(toText(null)).toBe("");
    expect(toText(undefined, "fb")).toBe("fb");
    expect(toText(42)).toBe("42");
  });
});

describe("toNumber", () => {
  it("parses numbers and numeric strings", () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber("7.5")).toBe(7.5);
    expect(toNumber("abc")).toBe(0);
    expect(toNumber(undefined, 9)).toBe(9);
  });
});

describe("toBoolean", () => {
  it("parses booleans, numbers, and truthy strings", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("OFF")).toBe(false);
    expect(toBoolean("maybe")).toBe(false);
  });
});

describe("parseJsonValue", () => {
  it("parses strings and passes objects through", () => {
    expect(parseJsonValue('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJsonValue({ a: 1 }, null)).toEqual({ a: 1 });
    expect(parseJsonValue(null, { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it("throws on invalid JSON and wrong types", () => {
    expect(() => parseJsonValue("not json", null)).toThrow("Invalid JSON");
    expect(() => parseJsonValue(42, null)).toThrow("Expected JSON");
  });
});

describe("parseJsonRecord / parseJsonArray", () => {
  it("parses records and arrays with empty fallbacks", () => {
    expect(parseJsonRecord('{"k":"v"}')).toEqual({ k: "v" });
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonArray("[1,2]")).toEqual([1, 2]);
    expect(parseJsonArray("")).toEqual([]);
  });

  it("throws on type mismatches", () => {
    expect(() => parseJsonRecord("[1]")).toThrow("Expected JSON object");
    expect(() => parseJsonArray('{"a":1}')).toThrow("Expected JSON array");
  });
});

describe("sql literals", () => {
  it("quotes strings with escaping", () => {
    expect(sqlQuote("it's")).toBe("'it''s'");
    expect(sqlText("plain")).toBe("'plain'");
    expect(sqlText(null)).toBe("NULL");
  });

  it("formats integers and numbers", () => {
    expect(sqlInteger(5.7)).toBe("5");
    expect(sqlInteger(null)).toBe("NULL");
    expect(sqlNumber(3.14)).toBe("3.14");
    expect(() => sqlInteger(NaN)).toThrow("invalid");
  });

  it("serializes JSON values", () => {
    expect(sqlJson({ a: 1 })).toBe("'{\"a\":1}'");
    expect(sqlJson(null)).toBe("'null'");
  });
});
