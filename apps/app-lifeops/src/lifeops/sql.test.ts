import { describe, expect, it } from "vitest";
import { parseJsonArray, parseJsonRecord, parseJsonValue } from "./sql.js";

describe("LifeOps SQL JSON helpers", () => {
  it("keeps nullish database JSON values as explicit empty containers", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonValue("", { fallback: true })).toEqual({ fallback: true });
  });

  it("throws instead of replacing malformed JSON with fake empty data", () => {
    expect(() => parseJsonRecord("{bad json")).toThrow(/Invalid JSON value/);
    expect(() => parseJsonArray("{\"not\":\"array\"}")).toThrow(
      /Expected JSON array/,
    );
    expect(() => parseJsonRecord("[1,2,3]")).toThrow(/Expected JSON object/);
  });
});
