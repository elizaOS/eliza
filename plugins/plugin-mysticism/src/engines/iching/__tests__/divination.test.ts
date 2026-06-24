import { describe, expect, it } from "vitest";
import { binaryToHexagramNumber, castHexagram, getHexagram, getTrigram } from "../divination.js";

/**
 * I Ching divination. castHexagram is RNG-based, so the tested properties hold
 * for EVERY cast: 6 lines, a 6-bit binary, a hexagram in 1..64, valid changing-
 * line positions, and a transformed hexagram iff any line is changing. Lookups
 * are bounds-checked.
 */

describe("castHexagram (invariants)", () => {
  it("always yields a well-formed cast", () => {
    for (let i = 0; i < 40; i++) {
      const cast = castHexagram();
      expect(cast.lines).toHaveLength(6);
      expect(cast.binary).toHaveLength(6);
      expect(cast.hexagramNumber).toBeGreaterThanOrEqual(1);
      expect(cast.hexagramNumber).toBeLessThanOrEqual(64);
      expect(cast.changingLines.every((p) => p >= 1 && p <= 6)).toBe(true);
      // a transformed hexagram exists iff there is at least one changing line.
      expect(cast.transformedHexagramNumber !== null).toBe(cast.changingLines.length > 0);
    }
  });
});

describe("binaryToHexagramNumber", () => {
  it("maps a 6-bit pattern to 1..64, throws on unknown", () => {
    const n = binaryToHexagramNumber("111111");
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(64);
    expect(binaryToHexagramNumber("000000")).not.toBe(n);
    expect(() => binaryToHexagramNumber("999999")).toThrow();
  });
});

describe("getHexagram / getTrigram (bounds)", () => {
  it("returns for valid numbers, throws out of range", () => {
    expect(getHexagram(1)).toBeDefined();
    expect(() => getHexagram(0)).toThrow();
    expect(() => getHexagram(99)).toThrow();
    expect(getTrigram(1)).toBeDefined();
    expect(() => getTrigram(9)).toThrow();
  });
});
