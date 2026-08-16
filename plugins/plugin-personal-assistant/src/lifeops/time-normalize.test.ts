/**
 * Unit-tests the canonical timezone normalization as consumed by LifeOps time
 * primitives: model-authored UTC spellings (the live "Z" failure) map to UTC,
 * valid IANA names pass through, and getZonedDateParts survives a Zulu
 * timezone instead of throwing at the Intl boundary.
 */
import { describe, expect, test } from "vitest";
import { normalizeTimeZone } from "./defaults.js";
import { getZonedDateParts } from "./time.js";

describe("normalizeTimeZone (canonical)", () => {
  test("UTC spellings normalize to UTC, not the deployment default", () => {
    for (const alias of ["Z", "z", "zulu", "UTC+0", "GMT+00", "+00:00", "-0000", "Etc/UTC"]) {
      expect(normalizeTimeZone(alias)).toBe("UTC");
    }
  });
  test("valid IANA zones pass through", () => {
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
  });
  test("getZonedDateParts survives a Zulu timezone (live calendar-create failure shape)", () => {
    const parts = getZonedDateParts(new Date("2026-08-19T14:00:00Z"), "Z");
    expect(parts.hour).toBe(14);
    expect(parts.day).toBe(19);
  });
});
