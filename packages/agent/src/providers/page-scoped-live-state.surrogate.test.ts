/** Surrogate safety for page-scoped live state truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function bioClamp(bio: string): string {
  return truncateWellFormed(toWellFormedUnicode(bio.trim()), 200);
}
function summaryClamp(summary: string): string {
  return truncateWellFormed(toWellFormedUnicode(summary), 140);
}
function shortAddress(address: string | null | undefined): string {
  if (!address) return "(not configured)";
  const wellFormed = toWellFormedUnicode(address);
  if (wellFormed.length <= 14) return wellFormed;
  const head = truncateWellFormed(wellFormed, 6);
  let tailStart = wellFormed.length - 4;
  if (
    tailStart > 0 &&
    wellFormed.charCodeAt(tailStart - 1) >= 0xd800 &&
    wellFormed.charCodeAt(tailStart - 1) <= 0xdbff &&
    wellFormed.charCodeAt(tailStart) >= 0xdc00 &&
    wellFormed.charCodeAt(tailStart) <= 0xdfff
  ) {
    tailStart += 1;
  }
  const tail = wellFormed.slice(tailStart);
  return `${head}...${tail}`;
}

describe("page-scoped-live-state surrogate safety", () => {
  test("bio 200 backs off at surrogate without lone", () => {
    const fox = "🦊";
    const bio = `${"a".repeat(199)}${fox}${"b".repeat(20)}`;
    const out = bioClamp(bio);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(199);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("bio short passthrough", () => {
    const bio = "short bio 🦊";
    const out = bioClamp(bio);
    expect(out).toBe(toWellFormedUnicode(bio.trim()));
    expect(isWellFormed(out)).toBe(true);
  });
  test("summary 140 backs off", () => {
    const fox = "🦊";
    const summary = `${"a".repeat(139)}${fox}${"b".repeat(10)}`;
    const out = summaryClamp(summary);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(139);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("shortAddress head 6 tail 4 well-formed", () => {
    const fox = "🦊";
    const addr = `0x1234${fox}7890abcdef1234567890abcdef12345678`;
    const out = shortAddress(addr);
    expect(isWellFormed(out)).toBe(true);
    expect(out.startsWith("0x1234")).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("shortAddress tail emoji well-formed", () => {
    const fox = "🦊";
    const addr = `0x1234567890abcdef1234567890abc${fox}`;
    const out = shortAddress(addr);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith(fox)).toBe(true);
  });
  test("lone surrogate sanitized", () => {
    const lone = `bio ${String.fromCharCode(0xd800)} ${"x".repeat(300)}`;
    const out = bioClamp(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
  test("sweep bio offsets well-formed", () => {
    const fox = "🦊";
    for (let n = 195; n <= 205; n++) {
      const bio = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = bioClamp(bio);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
