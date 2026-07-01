/**
 * Unit coverage for the timezone resolver (`timezone.ts`).
 *
 * These three functions turn free-form user text ("pst", "I live in Tokyo",
 * "America/Chicago") into IANA zone ids that downstream local-day / DST math
 * depends on. They had no direct test; this file pins the alias map, explicit
 * IANA passthrough, longest-alias matching, and the Intl-backed city inference
 * so a future DST / local-day fix can refactor the callers with a safety net.
 */

import { describe, expect, it } from "vitest";
import {
  extractExplicitTimeZoneFromText,
  inferTimeZoneFromLocationText,
  normalizeExplicitTimeZoneToken,
} from "./timezone.ts";

describe("normalizeExplicitTimeZoneToken — alias map", () => {
  it.each([
    ["pst", "America/Los_Angeles"],
    ["pdt", "America/Los_Angeles"],
    ["mst", "America/Denver"],
    ["cst", "America/Chicago"],
    ["est", "America/New_York"],
    ["utc", "UTC"],
    ["gmt", "UTC"],
  ])("maps abbreviation %s → %s", (input, expected) => {
    expect(normalizeExplicitTimeZoneToken(input)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(normalizeExplicitTimeZoneToken("PST")).toBe("America/Los_Angeles");
    expect(normalizeExplicitTimeZoneToken("Est")).toBe("America/New_York");
  });

  it("normalizes multi-word aliases", () => {
    expect(normalizeExplicitTimeZoneToken("Pacific Standard Time")).toBe(
      "America/Los_Angeles",
    );
    expect(normalizeExplicitTimeZoneToken("central time")).toBe(
      "America/Chicago",
    );
  });
});

describe("normalizeExplicitTimeZoneToken — explicit IANA passthrough", () => {
  it("returns a valid IANA id unchanged", () => {
    expect(normalizeExplicitTimeZoneToken("America/New_York")).toBe(
      "America/New_York",
    );
    expect(normalizeExplicitTimeZoneToken("Europe/London")).toBe(
      "Europe/London",
    );
    expect(normalizeExplicitTimeZoneToken("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("returns null for unknown / empty tokens", () => {
    expect(normalizeExplicitTimeZoneToken("not a zone")).toBeNull();
    expect(normalizeExplicitTimeZoneToken("")).toBeNull();
    expect(normalizeExplicitTimeZoneToken("   ")).toBeNull();
    expect(normalizeExplicitTimeZoneToken(null)).toBeNull();
    expect(normalizeExplicitTimeZoneToken(undefined)).toBeNull();
  });
});

describe("extractExplicitTimeZoneFromText", () => {
  it("prefers a literal IANA id embedded in prose", () => {
    expect(
      extractExplicitTimeZoneFromText("let's meet in America/Chicago tonight"),
    ).toBe("America/Chicago");
  });

  it("matches multi-word aliases inside a sentence (longest-alias precedence)", () => {
    // The alias loop is sorted longest-first so the most specific phrase is
    // tried before its single-word fragments. "pacific standard" wins here,
    // and "eastern" is recovered even when the trailing "time" word is
    // collapsed by the canonicalizer.
    expect(
      extractExplicitTimeZoneFromText(
        "I am currently in pacific standard time",
      ),
    ).toBe("America/Los_Angeles");
    expect(extractExplicitTimeZoneFromText("catch up, eastern time?")).toBe(
      "America/New_York",
    );
  });

  it("returns null when no zone is present", () => {
    expect(extractExplicitTimeZoneFromText("no timezone here")).toBeNull();
    expect(extractExplicitTimeZoneFromText("")).toBeNull();
  });
});

describe("inferTimeZoneFromLocationText — city inference", () => {
  it("infers a zone from a city name not present in the alias map (Intl-backed)", () => {
    // "tokyo" / "berlin" are NOT in TIME_ZONE_ALIASES, so a hit proves the
    // Intl.supportedValuesOf city map — not the static alias table — resolved
    // them.
    expect(inferTimeZoneFromLocationText("I live in Tokyo now")).toBe(
      "Asia/Tokyo",
    );
    expect(inferTimeZoneFromLocationText("moving to Berlin next month")).toBe(
      "Europe/Berlin",
    );
  });

  it("still honors the explicit alias path first", () => {
    expect(inferTimeZoneFromLocationText("I live in Chicago")).toBe(
      "America/Chicago",
    );
    expect(inferTimeZoneFromLocationText("denver")).toBe("America/Denver");
  });

  it("returns null for text with no resolvable location", () => {
    expect(inferTimeZoneFromLocationText("qwerty zzz")).toBeNull();
    expect(inferTimeZoneFromLocationText("")).toBeNull();
  });
});
