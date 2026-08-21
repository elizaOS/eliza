/** Surrogate safety for server-helpers owner name truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

const OWNER_NAME_MAX_LENGTH = 60;

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function normalizeOwnerName(ownerName: string | undefined): string | undefined {
  const normalized =
    truncateWellFormed(
      toWellFormedUnicode(ownerName?.trim() ?? ""),
      OWNER_NAME_MAX_LENGTH,
    ) || undefined;
  return normalized;
}

describe("server-helpers ownerName surrogate safety", () => {
  test("40 boundary backs off at surrogate without lone", () => {
    const fox = "🦊";
    const name = `${"a".repeat(59)}${fox}${"b".repeat(20)}`;
    const out = normalizeOwnerName(name);
    expect(out).toBeDefined();
    expect(isWellFormed(out!)).toBe(true);
    expect(out!.length).toBe(59);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("short name passthrough", () => {
    const out = normalizeOwnerName("Alice 🦊");
    expect(out).toBe("Alice 🦊");
    expect(isWellFormed(out!)).toBe(true);
  });
  test("emoji at 40 fits", () => {
    const fox = "🦊";
    const name = `${"a".repeat(58)}${fox}`;
    const out = normalizeOwnerName(name);
    expect(out).toBe(`${"a".repeat(58)}${fox}`);
    expect(isWellFormed(out!)).toBe(true);
  });
  test("empty/undefined -> undefined", () => {
    expect(normalizeOwnerName(undefined)).toBeUndefined();
    expect(normalizeOwnerName("   ")).toBeUndefined();
  });
  test("lone surrogate sanitized", () => {
    const lone = `name ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const out = normalizeOwnerName(lone);
    expect(isWellFormed(out!)).toBe(true);
    expect(out!.includes("�")).toBe(true);
  });
  test("sweep offsets well-formed", () => {
    const fox = "🦊";
    for (let n = 35; n <= 45; n++) {
      const name = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = normalizeOwnerName(name)!;
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
