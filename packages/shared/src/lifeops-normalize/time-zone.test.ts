/**
 * IANA time-zone normalization (LifeOps normalize primitives). A scheduled
 * reminder fired in the wrong zone is a real user-facing bug, so the
 * "valid → passthrough, invalid/empty/nullish → host default" contract is
 * pinned here. Deterministic given a fixed host zone — fallback assertions
 * compare against `resolveDefaultTimeZone()` rather than a hardcoded string so
 * they hold on any CI machine.
 */
import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  normalizeTimeZone,
  resolveDefaultTimeZone,
} from "./time-zone";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects nonsense", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("not-a-zone")).toBe(false);
  });
});

describe("normalizeTimeZone", () => {
  it("passes a valid IANA zone through unchanged", () => {
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTimeZone("  Europe/London  ")).toBe("Europe/London");
  });

  it("falls back to the host default for invalid/empty/nullish input", () => {
    const fallback = resolveDefaultTimeZone();
    expect(normalizeTimeZone("Not/AZone")).toBe(fallback);
    expect(normalizeTimeZone("")).toBe(fallback);
    expect(normalizeTimeZone("   ")).toBe(fallback);
    expect(normalizeTimeZone(null)).toBe(fallback);
    expect(normalizeTimeZone(undefined)).toBe(fallback);
  });
});
