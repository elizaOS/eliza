/**
 * Unit tests for the calendar input normalizers (finite number, ISO string,
 * Google capabilities, timezone) and their `CalendarServiceError` failure paths.
 * Pure functions.
 */
import { describe, expect, it } from "vitest";
import { CalendarServiceError } from "../src/internal/errors.js";
import {
  normalizeFiniteNumber,
  normalizeGoogleCapabilities,
  normalizeIsoString,
  normalizeOptionalBoolean,
  normalizeOptionalMinutes,
  normalizeOptionalString,
  normalizeValidTimeZone,
  requireNonEmptyString,
} from "../src/internal/normalize.js";

/**
 * These primitives normalize untrusted route input. They must trim/validate
 * strictly and reject malformed values with a 400 CalendarServiceError so a bad
 * request never reaches the store as a silently-coerced value.
 */

const expect400 = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CalendarServiceError);
    expect((err as CalendarServiceError).status).toBe(400);
    return;
  }
  throw new Error("expected the call to throw");
};

describe("requireNonEmptyString / normalizeOptionalString", () => {
  it("trims valid strings and rejects non-strings / empties", () => {
    expect(requireNonEmptyString("  hi  ", "f")).toBe("hi");
    expect400(() => requireNonEmptyString(42, "f"));
    expect400(() => requireNonEmptyString("   ", "f"));
    expect(normalizeOptionalString(42)).toBeUndefined();
    expect(normalizeOptionalString("   ")).toBeUndefined();
    expect(normalizeOptionalString(" x ")).toBe("x");
  });
});

describe("normalizeOptionalBoolean", () => {
  it("accepts booleans and true/false/1/0 strings, rejects junk", () => {
    expect(normalizeOptionalBoolean(undefined, "f")).toBeUndefined();
    expect(normalizeOptionalBoolean(true, "f")).toBe(true);
    expect(normalizeOptionalBoolean("TRUE", "f")).toBe(true);
    expect(normalizeOptionalBoolean("1", "f")).toBe(true);
    expect(normalizeOptionalBoolean("false", "f")).toBe(false);
    expect(normalizeOptionalBoolean("0", "f")).toBe(false);
    expect400(() => normalizeOptionalBoolean("maybe", "f"));
  });
});

describe("normalizeIsoString / normalizeFiniteNumber / normalizeOptionalMinutes", () => {
  it("canonicalizes a valid ISO datetime and rejects garbage", () => {
    expect(normalizeIsoString("2026-06-23T00:00:00Z", "f")).toBe(
      "2026-06-23T00:00:00.000Z",
    );
    expect400(() => normalizeIsoString("not-a-date", "f"));
  });

  it("accepts finite numbers / numeric strings, rejects NaN-likes", () => {
    expect(normalizeFiniteNumber(3.5, "f")).toBe(3.5);
    expect(normalizeFiniteNumber("42", "f")).toBe(42);
    expect400(() => normalizeFiniteNumber("abc", "f"));
    expect400(() => normalizeFiniteNumber(Number.POSITIVE_INFINITY, "f"));
  });

  it("truncates minutes, defaults empties, rejects negatives", () => {
    expect(normalizeOptionalMinutes("", "f")).toBeUndefined();
    expect(normalizeOptionalMinutes(null, "f")).toBeUndefined();
    expect(normalizeOptionalMinutes("15.9", "f")).toBe(15);
    expect400(() => normalizeOptionalMinutes(-1, "f"));
  });
});

describe("normalizeValidTimeZone", () => {
  it("falls back on empty, resolves aliases, rejects invalid zones", () => {
    expect(normalizeValidTimeZone(undefined, "f", "UTC")).toBe("UTC");
    expect(normalizeValidTimeZone("", "f", "UTC")).toBe("UTC");
    expect(normalizeValidTimeZone("PST", "f")).toBe("America/Los_Angeles");
    expect(normalizeValidTimeZone("America/New_York", "f")).toBe(
      "America/New_York",
    );
    expect400(() => normalizeValidTimeZone("Mars/Phobos", "f"));
    expect400(() => normalizeValidTimeZone(42, "f"));
  });
});

describe("normalizeGoogleCapabilities", () => {
  it("always includes basic_identity, filters unknowns, dedups", () => {
    expect(normalizeGoogleCapabilities(undefined)).toEqual([
      "google.basic_identity",
    ]);
    expect(normalizeGoogleCapabilities(["bogus", 7])).toEqual([
      "google.basic_identity",
    ]);
    expect(
      normalizeGoogleCapabilities([
        "google.calendar.read",
        "google.calendar.read",
      ]),
    ).toEqual(["google.basic_identity", "google.calendar.read"]);
  });

  it("keeps an explicitly-listed basic_identity in place without duplicating", () => {
    expect(
      normalizeGoogleCapabilities([
        "google.basic_identity",
        "google.gmail.send",
      ]),
    ).toEqual(["google.basic_identity", "google.gmail.send"]);
  });
});
