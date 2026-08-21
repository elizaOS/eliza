/**
 * Regression for settings-actions parameter and owner name truncation surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const OWNER_NAME_MAX_LENGTH = 100;

function trimToString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = toWellFormedUnicode(value.trim());
  if (!trimmed) return undefined;
  return truncateWellFormed(trimmed, max);
}

function truncateOwnerName(name: string): string {
  const raw = toWellFormedUnicode(name.trim());
  return truncateWellFormed(raw, OWNER_NAME_MAX_LENGTH);
}

function isWellFormed(v: string): boolean {
  if (!v) return true;
  if (
    typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
    "function"
  )
    return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("settings-actions surrogate safety", () => {
  it("trimToString keeps surrogate pair intact at boundary", () => {
    const limit = 50;
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(49)}${fox}${"b".repeat(20)}`;
    const out = trimToString(input, limit);
    expect(out).toBeDefined();
    expect(isWellFormed(out ?? "")).toBe(true);
    expect(out?.length).toBe(49);
  });

  it("truncateOwnerName keeps surrogate pair intact at 100-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(99)}${fox}${"b".repeat(20)}`;
    const out = truncateOwnerName(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(99);
  });

  it("sanitizes lone surrogate in owner name and parameters", () => {
    const lone = `owner ${String.fromCharCode(0xd800)} ${"a".repeat(200)}`;
    const out = truncateOwnerName(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(OWNER_NAME_MAX_LENGTH);
  });
});
