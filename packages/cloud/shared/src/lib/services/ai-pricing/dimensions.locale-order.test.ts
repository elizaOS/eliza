/**
 * Pins pricing dimension normalization to UTF-16 code-unit key ordering.
 * `buildDimensionKey` is the lookup/cache key for a resolved price, so the same
 * dimension set must produce one key on every host. ICU collation orders
 * mixed-case and non-ASCII dimension names by locale, which splits one logical
 * price into several cache entries and can miss an exact-match override.
 */
import { describe, expect, test } from "bun:test";

import { buildDimensionKey, normalizePricingDimensions } from "./dimensions";

describe("pricing dimension canonical key order", () => {
  test("orders mixed-case dimension names by code unit, not by locale collation", () => {
    // ICU puts "audio" before "Bitrate"; code unit puts "Bitrate" (0x42) first.
    expect(Object.keys(normalizePricingDimensions({ audio: "wav", Bitrate: 128 }))).toEqual([
      "Bitrate",
      "audio",
    ]);
  });

  test("orders non-ASCII dimension names by code unit", () => {
    expect(Object.keys(normalizePricingDimensions({ "\u00e4type": "a", zone: "b" }))).toEqual([
      "zone",
      "\u00e4type",
    ]);
  });

  test("builds one identical lookup key regardless of insertion order", () => {
    const left = buildDimensionKey({ audio: "wav", Bitrate: 128, zone: "eu", "\u00e4type": "x" });
    const right = buildDimensionKey({ "\u00e4type": "x", zone: "eu", Bitrate: 128, audio: "wav" });
    expect(left).toBe(right);
    expect(left).toBe('{"Bitrate":128,"audio":"wav","zone":"eu","\u00e4type":"x"}');
  });

  test("still collapses an empty dimension set to the wildcard key", () => {
    expect(buildDimensionKey()).toBe("*");
    expect(buildDimensionKey({})).toBe("*");
  });
});
