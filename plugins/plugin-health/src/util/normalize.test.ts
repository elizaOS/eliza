/**
 * Tests for the health-data normalization helpers.
 *
 * Materiality: these helpers gate the plugin-health HTTP surface. Accepting a
 * malformed ISO timestamp or a non-finite number as "valid" would store junk
 * in owner health facts; treating a non-string as an empty optional value
 * would silently drop data. The failure path must stay loud (400) for present
 * but malformed values, and only absent values may normalize to undefined.
 */
import { describe, expect, it } from "vitest";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalFiniteNumber,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./normalize";

function captureFailure(fn: () => unknown): {
  status: number;
  message: string;
} {
  try {
    fn();
  } catch (error) {
    const e = error as { status?: number; message?: string };
    return { status: e.status ?? -1, message: e.message ?? String(error) };
  }
  throw new Error("expected the callback to throw");
}

describe("fail", () => {
  it("throws a normalized error carrying the HTTP status", () => {
    const failure = captureFailure(() => fail(400, "bad input", "BAD_INPUT"));
    expect(failure.status).toBe(400);
    expect(failure.message).toContain("bad input");
  });
});

describe("requireNonEmptyString", () => {
  it("trims and returns a non-empty string", () => {
    expect(requireNonEmptyString("  ok  ", "field")).toBe("ok");
  });

  it("rejects empty and whitespace-only strings with 400", () => {
    for (const value of ["", "   "]) {
      const failure = captureFailure(() =>
        requireNonEmptyString(value, "title"),
      );
      expect(failure.status).toBe(400);
      expect(failure.message).toContain("title");
    }
  });

  it("rejects non-string values with 400", () => {
    const failure = captureFailure(() => requireNonEmptyString(42, "title"));
    expect(failure.status).toBe(400);
  });
});

describe("normalizeOptionalString", () => {
  it("passes absent values through as undefined", () => {
    expect(normalizeOptionalString(undefined)).toBeUndefined();
    expect(normalizeOptionalString(null)).toBeUndefined();
  });

  it("returns trimmed non-empty strings", () => {
    expect(normalizeOptionalString("  hello  ")).toBe("hello");
  });

  it("treats empty-after-trim as absent", () => {
    expect(normalizeOptionalString("   ")).toBeUndefined();
  });

  it("treats non-string values as absent (does not throw)", () => {
    expect(normalizeOptionalString(42)).toBeUndefined();
    expect(normalizeOptionalString({})).toBeUndefined();
  });
});

describe("normalizeOptionalBoolean", () => {
  it("passes booleans through", () => {
    expect(normalizeOptionalBoolean(true, "f")).toBe(true);
    expect(normalizeOptionalBoolean(false, "f")).toBe(false);
  });

  it("accepts string and numeric true/false spellings", () => {
    expect(normalizeOptionalBoolean("true", "f")).toBe(true);
    expect(normalizeOptionalBoolean(1, "f")).toBe(true);
    expect(normalizeOptionalBoolean("false", "f")).toBe(false);
    expect(normalizeOptionalBoolean(0, "f")).toBe(false);
  });

  it("treats absent values as undefined", () => {
    expect(normalizeOptionalBoolean(undefined, "f")).toBeUndefined();
    expect(normalizeOptionalBoolean(null, "f")).toBeUndefined();
  });

  it("rejects unrecognized spellings instead of guessing", () => {
    expect(normalizeOptionalBoolean("yes", "f")).toBeUndefined();
    expect(normalizeOptionalBoolean("1", "f")).toBeUndefined();
    expect(normalizeOptionalBoolean({}, "f")).toBeUndefined();
  });
});

describe("normalizeOptionalIsoString", () => {
  it("passes valid ISO timestamps through trimmed", () => {
    expect(normalizeOptionalIsoString("  2026-08-24T12:00:00Z  ", "at")).toBe(
      "2026-08-24T12:00:00Z",
    );
  });

  it("treats absent and empty values as undefined", () => {
    expect(normalizeOptionalIsoString(undefined, "at")).toBeUndefined();
    expect(normalizeOptionalIsoString("", "at")).toBeUndefined();
  });

  it("rejects unparseable timestamps with 400", () => {
    const failure = captureFailure(() =>
      normalizeOptionalIsoString("not-a-date", "at"),
    );
    expect(failure.status).toBe(400);
    expect(failure.message).toContain("at");
  });

  it("rejects non-string values with 400", () => {
    const failure = captureFailure(() => normalizeOptionalIsoString(42, "at"));
    expect(failure.status).toBe(400);
  });
});

describe("normalizeOptionalFiniteNumber", () => {
  it("passes finite numbers through", () => {
    expect(normalizeOptionalFiniteNumber(3.5, "n")).toBe(3.5);
    expect(normalizeOptionalFiniteNumber(0, "n")).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(normalizeOptionalFiniteNumber("12", "n")).toBe(12);
    expect(normalizeOptionalFiniteNumber("-1.25", "n")).toBe(-1.25);
  });

  it("treats absent values as null", () => {
    expect(normalizeOptionalFiniteNumber(undefined, "n")).toBeNull();
    expect(normalizeOptionalFiniteNumber(null, "n")).toBeNull();
  });

  it("rejects NaN/Infinity with 400", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const failure = captureFailure(() =>
        normalizeOptionalFiniteNumber(value, "n"),
      );
      expect(failure.status).toBe(400);
    }
  });

  it("rejects non-numeric strings with 400", () => {
    const failure = captureFailure(() =>
      normalizeOptionalFiniteNumber("abc", "n"),
    );
    expect(failure.status).toBe(400);
  });
});
