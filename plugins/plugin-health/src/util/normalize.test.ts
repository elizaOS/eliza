/**
 * Unit test for plugin-health value-normalisation helpers.
 *
 * Materiality: `normalizeOptionalIsoString` validates timestamps via
 * `Date.parse`, which accepts non-ISO formats ("2024/01/15", "Jan 15 2024",
 * "2024-01-15 10:30:00"). The helper's contract and error message say the
 * value "must be an ISO string"; accepting Date.parse-lenient input means
 * malformed provider payloads pass validation and flow downstream with
 * non-canonical timestamps. These tests pin the ISO-8601 boundary.
 */
import { describe, expect, it } from "vitest";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalFiniteNumber,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./normalize.js";

describe("requireNonEmptyString", () => {
  it("trims and returns non-empty strings", () => {
    expect(requireNonEmptyString("  hello  ", "field")).toBe("hello");
  });

  it("rejects non-string and blank values", () => {
    expect(() => requireNonEmptyString("", "field")).toThrow(
      /non-empty string/,
    );
    expect(() => requireNonEmptyString("   ", "field")).toThrow(
      /non-empty string/,
    );
    expect(() => requireNonEmptyString(42, "field")).toThrow(
      /non-empty string/,
    );
    expect(() => requireNonEmptyString(null, "field")).toThrow(
      /non-empty string/,
    );
  });
});

describe("normalizeOptionalString", () => {
  it("returns undefined for missing values", () => {
    expect(normalizeOptionalString(undefined)).toBeUndefined();
    expect(normalizeOptionalString(null)).toBeUndefined();
  });

  it("returns undefined for non-string values", () => {
    expect(normalizeOptionalString(7)).toBeUndefined();
    expect(normalizeOptionalString({})).toBeUndefined();
  });

  it("trims strings and collapses blanks to undefined", () => {
    expect(normalizeOptionalString("  ok  ")).toBe("ok");
    expect(normalizeOptionalString("   ")).toBeUndefined();
  });
});

describe("normalizeOptionalBoolean", () => {
  it("passes booleans through", () => {
    expect(normalizeOptionalBoolean(true, "f")).toBe(true);
    expect(normalizeOptionalBoolean(false, "f")).toBe(false);
  });

  it("maps string/number truthy markers", () => {
    expect(normalizeOptionalBoolean("true", "f")).toBe(true);
    expect(normalizeOptionalBoolean(1, "f")).toBe(true);
    expect(normalizeOptionalBoolean("false", "f")).toBe(false);
    expect(normalizeOptionalBoolean(0, "f")).toBe(false);
  });

  it("returns undefined for unrecognised values", () => {
    expect(normalizeOptionalBoolean("yes", "f")).toBeUndefined();
    expect(normalizeOptionalBoolean("1", "f")).toBeUndefined();
    expect(normalizeOptionalBoolean(2, "f")).toBeUndefined();
  });
});

describe("normalizeOptionalIsoString", () => {
  it("accepts canonical ISO-8601 timestamps", () => {
    expect(normalizeOptionalIsoString("2024-01-15T10:30:00Z", "ts")).toBe(
      "2024-01-15T10:30:00Z",
    );
    expect(
      normalizeOptionalIsoString("2024-01-15T10:30:00.123+02:00", "ts"),
    ).toBe("2024-01-15T10:30:00.123+02:00");
    expect(normalizeOptionalIsoString("2024-01-15", "ts")).toBe("2024-01-15");
  });

  it("rejects Date.parse-lenient non-ISO formats", () => {
    // Date.parse accepts all of these; the ISO contract must not.
    expect(() => normalizeOptionalIsoString("2024/01/15", "ts")).toThrow(
      /must be a valid ISO timestamp/,
    );
    expect(() => normalizeOptionalIsoString("Jan 15 2024", "ts")).toThrow(
      /must be a valid ISO timestamp/,
    );
    expect(() =>
      normalizeOptionalIsoString("2024-01-15 10:30:00", "ts"),
    ).toThrow(/must be a valid ISO timestamp/);
    expect(() => normalizeOptionalIsoString("01/02/2024", "ts")).toThrow(
      /must be a valid ISO timestamp/,
    );
  });

  it("rejects unparseable and out-of-range values", () => {
    expect(() => normalizeOptionalIsoString("garbage", "ts")).toThrow(
      /must be a valid ISO timestamp/,
    );
    expect(() => normalizeOptionalIsoString("2024-13-45", "ts")).toThrow(
      /must be a valid ISO timestamp/,
    );
    expect(() => normalizeOptionalIsoString(123, "ts")).toThrow(
      /must be an ISO string/,
    );
  });

  it("returns undefined for missing and blank values", () => {
    expect(normalizeOptionalIsoString(undefined, "ts")).toBeUndefined();
    expect(normalizeOptionalIsoString(null, "ts")).toBeUndefined();
    expect(normalizeOptionalIsoString("   ", "ts")).toBeUndefined();
  });
});

describe("normalizeOptionalFiniteNumber", () => {
  it("passes finite numbers through", () => {
    expect(normalizeOptionalFiniteNumber(3.5, "n")).toBe(3.5);
    expect(normalizeOptionalFiniteNumber(0, "n")).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(normalizeOptionalFiniteNumber("42", "n")).toBe(42);
    expect(normalizeOptionalFiniteNumber("3.14", "n")).toBe(3.14);
  });

  it("rejects non-finite and non-numeric values", () => {
    expect(() => normalizeOptionalFiniteNumber(Number.NaN, "n")).toThrow(
      /finite number/,
    );
    expect(() =>
      normalizeOptionalFiniteNumber(Number.POSITIVE_INFINITY, "n"),
    ).toThrow(/finite number/);
    expect(() => normalizeOptionalFiniteNumber("abc", "n")).toThrow(
      /finite number/,
    );
    expect(() => normalizeOptionalFiniteNumber({}, "n")).toThrow(
      /finite number/,
    );
  });

  it("returns null for missing values", () => {
    expect(normalizeOptionalFiniteNumber(undefined, "n")).toBeNull();
    expect(normalizeOptionalFiniteNumber(null, "n")).toBeNull();
  });
});

describe("fail", () => {
  it("throws an error carrying status and optional code", () => {
    try {
      fail(422, "bad payload", "BAD_PAYLOAD");
    } catch (error) {
      const e = error as Error & { status?: number; code?: string };
      expect(e.message).toBe("bad payload");
      expect(e.status).toBe(422);
      expect(e.code).toBe("BAD_PAYLOAD");
      return;
    }
    throw new Error("fail() did not throw");
  });
});
