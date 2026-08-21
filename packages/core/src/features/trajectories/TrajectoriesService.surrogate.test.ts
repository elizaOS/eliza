/**
 * Regression for TrajectoriesService surrogate-safe truncation (256).
 */

import { toWellFormedUnicode, truncateWellFormed } from "../../utils/well-formed.ts";
import { describe, expect, it } from "vitest";

const ZIP_LIMIT = 256;

function clampZip(value: string): string {
  const trimmed = value.trim();
  const wellFormed = toWellFormedUnicode(trimmed);
  return trimmed.length > 256 ? truncateWellFormed(wellFormed, 256) : wellFormed;
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("TrajectoriesService well-formed", () => {
  it("backs off astral at 256 boundary (255+fox->255)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(255)}${fox}${"b".repeat(20)}`;
    const out = clampZip(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(255);
    expect(out).toBe("a".repeat(255));
  });

  it("preserves fitting astral at 256 (254+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(254)}${fox}`;
    const out = clampZip(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(256);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `zip ${String.fromCharCode(0xd800)} folder`;
    const out = clampZip(`${lone}${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough sanitized", () => {
    const lone = `a${String.fromCharCode(0xd800)}b`;
    const out = clampZip(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("sweep around 256 well-formed", () => {
    const fox = "🦊";
    for (let n = 251; n <= 261; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampZip(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(256);
    }
  });
});
