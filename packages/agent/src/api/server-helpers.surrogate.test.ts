/**
 * Surrogate safety for the owner name resolveAppUserName renders into every
 * ensureConnection call. Drives the real exported function rather than a local
 * copy of its clamp, so reverting the production change fails these tests.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, test } from "vitest";

import type { ElizaConfig } from "../config/types.ts";
import { resolveAppUserName } from "./server-helpers.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

const withOwnerName = (ownerName: string | undefined): ElizaConfig =>
  ({ ui: { ownerName } }) as unknown as ElizaConfig;

describe("resolveAppUserName surrogate safety", () => {
  test("preserves a long name including an emoji at the former cap", () => {
    const name = `${"a".repeat(59)}🦊${"b".repeat(20)}`;
    const resolved = resolveAppUserName(withOwnerName(name));

    expect(isWellFormed(resolved)).toBe(true);
    expect(resolved).toBe(name);
    expect(() => JSON.stringify(resolved)).not.toThrow();
  });

  test("preserves content beyond the former cap", () => {
    const name = `${"a".repeat(58)}🦊${"b".repeat(20)}`;
    const resolved = resolveAppUserName(withOwnerName(name));

    expect(resolved).toBe(name);
    expect(isWellFormed(resolved)).toBe(true);
  });

  test("sanitizes a lone surrogate well inside the cap", () => {
    const resolved = resolveAppUserName(withOwnerName("Alice \uD800 Smith"));

    expect(isWellFormed(resolved)).toBe(true);
    expect(resolved.includes("\uD800")).toBe(false);
  });

  test("passes a short name through untouched", () => {
    expect(resolveAppUserName(withOwnerName("Alice 🦊"))).toBe("Alice 🦊");
  });

  // The "User" fallback is what reaches ensureConnection when no owner name is
  // configured; a blank-after-trim name must not resolve to an empty string.
  test("falls back to User for missing or blank names", () => {
    expect(resolveAppUserName(withOwnerName(undefined))).toBe("User");
    expect(resolveAppUserName(withOwnerName("   "))).toBe("User");
  });
});
