import { describe, expect, it } from "vitest";
import {
  normalizePhoneNumber,
  normalizePositiveInteger,
  normalizePriority,
  normalizeReminderUrgency,
  normalizeValidTimeZone,
} from "./service-normalize.ts";

/**
 * Shared LifeOps input normalizers (#8795). Phone numbers normalize to E.164,
 * priority/integers clamp to valid ranges, and enum-like fields canonicalize or
 * reject — these gate untrusted assistant input into the scheduling pipelines.
 */

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
