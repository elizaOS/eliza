/**
 * Regression for app-block and website-block candidates normalization surrogate safety (10,000).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function normalizePackageNames(
  value: unknown,
  allowedPackageNames?: ReadonlySet<string>,
): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? truncateWellFormed(toWellFormedUnicode(value), 10_000).split(
          /\s{0,256}\|\|\s{0,256}|,/,
        )
      : [];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => toWellFormedUnicode(item.trim().toLowerCase()))
    .filter((item) => item.length > 0);
  const unique = [...new Set(normalized)];
  if (!allowedPackageNames) return unique;
  return unique.filter((item) => allowedPackageNames.has(item));
}

function normalizeWebsiteCandidates(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? truncateWellFormed(toWellFormedUnicode(value), 10_000).split(
          /\s{0,256}\|\|\s{0,256}|,|\n/,
        )
      : [];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) =>
          truncateWellFormed(toWellFormedUnicode(item.trim()), 1024),
        )
        .map((item) => item.replace(/^[[\]'"]{1,32}|[[\]'"]{1,32}$/g, ""))
        .filter((item) => item.length > 0),
    ),
  ];
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

describe("app-block and website-block surrogate safety", () => {
  it("keeps surrogate pair intact at 10,000-char boundary in package names", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(9999)}${fox},com.instagram.android,com.twitter.android`;
    const out = normalizePackageNames(input);
    expect(out.length).toBeGreaterThan(0);
    for (const item of out) {
      expect(isWellFormed(item)).toBe(true);
    }
  });

  it("keeps surrogate pair intact at 10,000-char boundary in website candidates", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(9999)}${fox}\nexample.com\nnews.ycombinator.com`;
    const out = normalizeWebsiteCandidates(input);
    expect(out.length).toBeGreaterThan(0);
    for (const item of out) {
      expect(isWellFormed(item)).toBe(true);
    }
  });

  it("sanitizes lone surrogate before splitting", () => {
    const lone = `com.test.app,${String.fromCharCode(0xd800)},com.other.app`;
    const out = normalizePackageNames(lone);
    for (const item of out) {
      expect(isWellFormed(item)).toBe(true);
    }
    expect(out).toContain("\uFFFD");
  });
});
