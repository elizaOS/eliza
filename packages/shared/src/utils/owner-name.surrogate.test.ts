/**
 * Regression for owner-name surrogate-safe truncation (60).
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { normalizeOwnerName } from "./owner-name.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  if (
    typeof (value as unknown as { isWellFormed?: () => boolean })
      .isWellFormed === "function"
  )
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("normalizeOwnerName well-formed", () => {
  it("keeps surrogate intact at 60 boundary", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(59)}${emoji}${"b".repeat(20)}`;
    const out = normalizeOwnerName(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it("preserves fitting emoji", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(58)}${emoji}`;
    const out = normalizeOwnerName(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(emoji)).toBe(true);
    expect(out.length).toBe(60);
  });

  it("sanitizes lone surrogate", () => {
    const lone = `owner ${String.fromCharCode(0xd800)} name`;
    const out = normalizeOwnerName(`${lone}${"x".repeat(100)}`);
    expect(isWellFormed(out)).toBe(true);
  });

  it("short passthrough and trim", () => {
    expect(normalizeOwnerName("  Alice  ")).toBe("Alice");
    expect(normalizeOwnerName("")).toBe("");
    expect(normalizeOwnerName(null)).toBe("");
  });

  it("sweep around 60 well-formed", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 55; n <= 65; n++) {
      const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = normalizeOwnerName(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(60);
    }
  });

  it("well-formed original also passes", () => {
    const well = toWellFormedUnicode(
      `${"a".repeat(59)}${String.fromCharCode(0xd83d, 0xde00)}`,
    );
    expect(isWellFormed(well)).toBe(true);
  });
});
