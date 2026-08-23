import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  normalizeTimeZone,
  resolveDefaultTimeZone,
} from "./time-zone.ts";

describe("resolveDefaultTimeZone", () => {
  it("returns a non-empty zone", () => {
    const tz = resolveDefaultTimeZone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("Z")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("normalizeTimeZone", () => {
  it("maps UTC aliases to UTC", () => {
    for (const alias of [
      "Z",
      "zulu",
      "utc",
      "gmt",
      "Etc/UTC",
      "+00:00",
      "UTC+0",
    ]) {
      expect(normalizeTimeZone(alias)).toBe("UTC");
    }
  });

  it("passes through valid zones", () => {
    expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls back to the default zone for invalid input", () => {
    expect(normalizeTimeZone("Mars/Olympus")).toBe(resolveDefaultTimeZone());
    expect(normalizeTimeZone("")).toBe(resolveDefaultTimeZone());
    expect(normalizeTimeZone(null)).toBe(resolveDefaultTimeZone());
    expect(normalizeTimeZone(undefined)).toBe(resolveDefaultTimeZone());
  });
});
