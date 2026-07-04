/**
 * Shared LifeOps input normalizers (#8795). Phone numbers normalize to E.164,
 * priority/integers clamp to valid ranges, and enum-like fields canonicalize or
 * reject — these gate untrusted assistant input into the scheduling pipelines.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeOptionalFiniteNumber,
  normalizeOptionalIsoString,
  normalizeOptionalNonNegativeInteger,
  normalizePhoneNumber,
  normalizePositiveInteger,
  normalizePriority,
  normalizeReminderUrgency,
  normalizeValidTimeZone,
} from "./service-normalize.ts";

describe("normalizePhoneNumber", () => {
  it("normalizes US and international numbers to E.164", () => {
    expect(normalizePhoneNumber("+1 (415) 555-1234", "phone")).toBe(
      "+14155551234",
    );
    expect(normalizePhoneNumber("4155551234", "phone")).toBe("+14155551234");
    expect(normalizePhoneNumber("14155551234", "phone")).toBe("+14155551234");
    expect(normalizePhoneNumber("+44 20 7946 0958", "phone")).toBe(
      "+442079460958",
    );
  });

  it("rejects invalid phone numbers", () => {
    expect(() => normalizePhoneNumber("12345", "phone")).toThrow();
    expect(() => normalizePhoneNumber("+123", "phone")).toThrow();
    expect(() => normalizePhoneNumber("", "phone")).toThrow();
  });
});

describe("normalizePriority / normalizePositiveInteger", () => {
  it("priority defaults to current, truncates, and clamps to 1..5", () => {
    expect(normalizePriority(undefined)).toBe(3);
    expect(normalizePriority(undefined, 2)).toBe(2);
    expect(normalizePriority("4")).toBe(4);
    expect(normalizePriority(3.7)).toBe(3);
    expect(() => normalizePriority(0)).toThrow();
    expect(() => normalizePriority(6)).toThrow();
  });

  it("positive integer truncates and rejects <= 0", () => {
    expect(normalizePositiveInteger(5, "n")).toBe(5);
    expect(normalizePositiveInteger("3", "n")).toBe(3);
    expect(normalizePositiveInteger(2.9, "n")).toBe(2);
    expect(() => normalizePositiveInteger(0, "n")).toThrow();
    expect(() => normalizePositiveInteger(-1, "n")).toThrow();
  });
});

describe("normalizeReminderUrgency", () => {
  it("defaults empty/non-string to medium, canonicalizes, rejects junk", () => {
    expect(normalizeReminderUrgency(undefined)).toBe("medium");
    expect(normalizeReminderUrgency("")).toBe("medium");
    expect(normalizeReminderUrgency(42)).toBe("medium");
    expect(normalizeReminderUrgency("high")).toBe("high");
    expect(() => normalizeReminderUrgency("supersonic")).toThrow();
  });
});

describe("normalizeValidTimeZone", () => {
  it("defaults empty, accepts IANA names, rejects invalid", () => {
    expect(normalizeValidTimeZone(undefined, "tz", "UTC")).toBe("UTC");
    expect(normalizeValidTimeZone("", "tz", "UTC")).toBe("UTC");
    expect(normalizeValidTimeZone("America/New_York", "tz")).toBe(
      "America/New_York",
    );
    expect(() => normalizeValidTimeZone("Mars/Phobos", "tz")).toThrow();
  });
});

// Optional-wrapper normalizers (#8801 / #9943): the base normalizers are tested,
// but these wrappers add the null/empty passthrough + the non-negative-integer
// truncation/guard, which were untested.
describe("normalizeOptionalFiniteNumber", () => {
  it("maps null / undefined / empty string to null", () => {
    for (const v of [null, undefined, ""]) {
      expect(normalizeOptionalFiniteNumber(v, "f")).toBeNull();
    }
  });
  it("passes a finite number or numeric string through", () => {
    expect(normalizeOptionalFiniteNumber(5, "f")).toBe(5);
    expect(normalizeOptionalFiniteNumber("5.5", "f")).toBe(5.5);
  });
  it("throws on a non-finite value", () => {
    expect(() => normalizeOptionalFiniteNumber("abc", "f")).toThrow();
  });
});

describe("normalizeOptionalNonNegativeInteger", () => {
  it("maps empty to null", () => {
    expect(normalizeOptionalNonNegativeInteger("", "f")).toBeNull();
  });
  it("truncates toward zero", () => {
    expect(normalizeOptionalNonNegativeInteger(5.9, "f")).toBe(5);
    expect(normalizeOptionalNonNegativeInteger("3", "f")).toBe(3);
  });
  it("rejects a negative value", () => {
    expect(() => normalizeOptionalNonNegativeInteger(-1, "f")).toThrow(
      /zero or greater/,
    );
  });
});

describe("normalizeOptionalIsoString", () => {
  it("maps null / undefined / empty to undefined", () => {
    for (const v of [null, undefined, ""]) {
      expect(normalizeOptionalIsoString(v, "f")).toBeUndefined();
    }
  });
  it("normalizes a valid datetime to canonical ISO", () => {
    expect(normalizeOptionalIsoString("2026-01-02T03:04:05Z", "f")).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
  it("throws on an invalid datetime", () => {
    expect(() => normalizeOptionalIsoString("not-a-date", "f")).toThrow();
  });
});
