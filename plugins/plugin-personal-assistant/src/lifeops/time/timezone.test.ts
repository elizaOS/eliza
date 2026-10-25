/**
 * Coverage for the planner "Z" time-zone alias in timezone.ts.
 *
 * A planner that reads an ISO timestamp such as "2026-08-19T14:00:00Z"
 * stamps the definition timeZone field "Z". The exact-token path
 * (normalizeExplicitTimeZoneToken) must resolve it to UTC, because Intl
 * rejects "Z" as a zone name and callers otherwise fall back to the owner
 * default zone. The alias must not leak into the free-text scan
 * (extractExplicitTimeZoneFromText / inferTimeZoneFromLocationText): a
 * bare "z" in prose is not a time zone, and inferring UTC there would
 * override the owner's meeting time zone.
 */

import { describe, expect, it } from "vitest";
import {
  extractExplicitTimeZoneFromText,
  inferTimeZoneFromLocationText,
  normalizeExplicitTimeZoneToken,
} from "./timezone.js";

describe("normalizeExplicitTimeZoneToken planner Z alias", () => {
  it("resolves the exact token Z to UTC", () => {
    expect(normalizeExplicitTimeZoneToken("Z")).toBe("UTC");
    expect(normalizeExplicitTimeZoneToken("z")).toBe("UTC");
    expect(normalizeExplicitTimeZoneToken("  Z  ")).toBe("UTC");
  });

  it("returns null for an unknown token", () => {
    expect(normalizeExplicitTimeZoneToken("not-a-zone")).toBeNull();
    expect(normalizeExplicitTimeZoneToken("")).toBeNull();
    expect(normalizeExplicitTimeZoneToken(null)).toBeNull();
  });
});

describe("free-text time-zone scan ignores a bare z", () => {
  const prose = [
    "find three slots to meet Jay Z next week",
    "Gen Z roundtable with Dana",
    "cover everything from A-Z with Sam",
  ];

  it("infers no zone from prose that contains a bare z", () => {
    for (const sentence of prose) {
      expect(extractExplicitTimeZoneFromText(sentence)).toBeNull();
      expect(inferTimeZoneFromLocationText(sentence)).toBeNull();
    }
  });
});
