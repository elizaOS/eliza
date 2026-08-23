/** Surrogate safety for owner-name normalization. */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { normalizeOwnerName } from "./owner-name.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function requireNormalizedOwnerName(value: string): string {
  const normalized = normalizeOwnerName(value);
  if (normalized === null) {
    throw new Error("expected a non-empty owner name");
  }
  return normalized;
}

describe("owner-name surrogate safety", () => {
  test("preserves a long name and its surrogate pair", () => {
    const fox = "🦊";
    const name = `${"a".repeat(59)}${fox}${"b".repeat(20)}`;
    const out = requireNormalizedOwnerName(name);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(name);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("short name passthrough", () => {
    const out = requireNormalizedOwnerName("Bob 🦊");
    expect(out).toBe("Bob 🦊");
    expect(isWellFormed(out)).toBe(true);
  });
  test("emoji and suffix beyond the former cap remain", () => {
    const fox = "🦊";
    const name = `${"a".repeat(58)}${fox}${"b".repeat(100)}`;
    const out = requireNormalizedOwnerName(name);
    expect(out).toBe(name);
    expect(isWellFormed(out)).toBe(true);
  });
  test("null/empty -> null", () => {
    expect(normalizeOwnerName(null)).toBeNull();
    expect(normalizeOwnerName("   ")).toBeNull();
  });
  test("lone surrogate sanitized", () => {
    const lone = `owner ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const out = requireNormalizedOwnerName(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
  test("sweep offsets well-formed", () => {
    const fox = "🦊";
    for (let n = 55; n <= 65; n++) {
      const name = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = requireNormalizedOwnerName(name);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
