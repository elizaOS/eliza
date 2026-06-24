import { describe, expect, it } from "vitest";
import { angularSeparation, degreesToSign, isAspect, signDisplayName } from "../zodiac.js";

/**
 * Zodiac math: an ecliptic longitude maps to a sign + within-sign degree (30°
 * per sign, wrapping at 360°); angular separation is the shortest arc (0..180);
 * isAspect tests whether two longitudes form an aspect within an orb. Wrap-
 * around bugs here misplace planets and miscompute aspects.
 */

describe("degreesToSign", () => {
  it("maps longitude to sign + within-sign degree, normalizing 0..360", () => {
    expect(degreesToSign(0)).toMatchObject({ sign: "aries", degrees: 0 });
    expect(degreesToSign(35)).toMatchObject({ sign: "taurus", degrees: 5 });
    expect(degreesToSign(330)).toMatchObject({ sign: "pisces", degrees: 0 });
    // wraps past 360 and below 0.
    expect(degreesToSign(365)).toMatchObject({ sign: "aries", degrees: 5 });
    expect(degreesToSign(-30)).toMatchObject({ sign: "pisces", degrees: 0 });
  });
});

describe("angularSeparation", () => {
  it("returns the shortest arc in [0, 180]", () => {
    expect(angularSeparation(0, 90)).toBe(90);
    expect(angularSeparation(0, 350)).toBe(10); // shorter the other way
    expect(angularSeparation(10, 200)).toBe(170);
    expect(angularSeparation(45, 45)).toBe(0);
  });
});

describe("isAspect", () => {
  it("is true only within the orb of the target aspect angle", () => {
    expect(isAspect(0, 90, 90, 5)).toBe(true); // exact square
    expect(isAspect(0, 93, 90, 5)).toBe(true); // within orb
    expect(isAspect(0, 100, 90, 5)).toBe(false); // outside orb
    expect(isAspect(0, 180, 180, 8)).toBe(true); // opposition
  });
});

describe("signDisplayName", () => {
  it("capitalizes the sign id", () => {
    expect(signDisplayName("aries")).toBe("Aries");
    expect(signDisplayName("scorpio")).toBe("Scorpio");
  });
});
