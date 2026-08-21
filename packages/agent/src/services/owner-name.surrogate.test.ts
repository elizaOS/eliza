/** Surrogate safety for owner-name normalization. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

const OWNER_NAME_MAX_LENGTH = 60;

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function normalizeOwnerName(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return truncateWellFormed(
    toWellFormedUnicode(trimmed),
    OWNER_NAME_MAX_LENGTH,
  );
}

describe("owner-name surrogate safety", () => {
  test("60 boundary backs off at surrogate without lone", () => {
    const fox = "🦊";
    const name = `${"a".repeat(59)}${fox}${"b".repeat(20)}`;
    const out = normalizeOwnerName(name)!;
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(59);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("short name passthrough", () => {
    const out = normalizeOwnerName("Bob 🦊")!;
    expect(out).toBe("Bob 🦊");
    expect(isWellFormed(out)).toBe(true);
  });
  test("emoji at 60 fits", () => {
    const fox = "🦊";
    const name = `${"a".repeat(58)}${fox}`;
    const out = normalizeOwnerName(name)!;
    expect(out).toBe(`${"a".repeat(58)}${fox}`);
    expect(isWellFormed(out)).toBe(true);
  });
  test("null/empty -> null", () => {
    expect(normalizeOwnerName(null)).toBeNull();
    expect(normalizeOwnerName("   ")).toBeNull();
  });
  test("lone surrogate sanitized", () => {
    const lone = `owner ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const out = normalizeOwnerName(lone)!;
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
  test("sweep offsets well-formed", () => {
    const fox = "🦊";
    for (let n = 55; n <= 65; n++) {
      const name = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = normalizeOwnerName(name)!;
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
