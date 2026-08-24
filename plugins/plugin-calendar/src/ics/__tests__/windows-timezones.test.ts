import { describe, expect, it } from "vitest";
import { resolveIcsTimeZoneId } from "./windows-timezones.ts";

describe("resolveIcsTimeZoneId", () => {
  it("passes through valid IANA time zones", () => {
    expect(resolveIcsTimeZoneId("America/New_York")).toBe("America/New_York");
    expect(resolveIcsTimeZoneId("UTC")).toBe("UTC");
  });

  it("maps Windows time zone ids to IANA", () => {
    // "Eastern Standard Time" -> America/New_York (typical mapping)
    const result = resolveIcsTimeZoneId("Eastern Standard Time");
    expect(result).toBeTruthy();
    expect(result).toContain("America");
  });

  it("returns null for empty or unknown zones", () => {
    expect(resolveIcsTimeZoneId("")).toBeNull();
    expect(resolveIcsTimeZoneId("   ")).toBeNull();
    expect(resolveIcsTimeZoneId("Not/AZone")).toBeNull();
  });
});
