/**
 * Regression for limits surrogate-safe truncation (240).
 */

import { toWellFormedUnicode, truncateWellFormed } from "../utils/well-formed.ts";
import { describe, expect, it } from "vitest";

const LIMITS_TRUNCATE = 240;

function clampLimits(text: string): string {
  const wellFormed = toWellFormedUnicode(text ?? "");
  return truncateWellFormed(wellFormed, LIMITS_TRUNCATE);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("limits well-formed", () => {
  it("backs off astral at 240 boundary (239+fox->239)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(239)}${fox}${"b".repeat(20)}`;
    const out = clampLimits(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(239);
    expect(out).toBe("a".repeat(239));
  });

  it("preserves fitting astral at 240 (238+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(238)}${fox}`;
    const out = clampLimits(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(240);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `err ${String.fromCharCode(0xd800)} text`;
    const out = clampLimits(`${lone}${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough", () => {
    expect(clampLimits("short error")).toBe("short error");
  });

  it("sweep around 240 well-formed", () => {
    const fox = "🦊";
    for (let n = 235; n <= 245; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampLimits(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(240);
    }
  });
});
