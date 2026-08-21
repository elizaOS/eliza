/**
 * Regression for defiNewsProvider text surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const DEFI_NEWS_TEXT_LIMIT = 4000;

function formatDefiNewsText(defiNewsInfo: string): string {
  return truncateWellFormed(
    toWellFormedUnicode(`${defiNewsInfo}\n`),
    DEFI_NEWS_TEXT_LIMIT,
  );
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

describe("defiNewsProvider surrogate safety", () => {
  it("keeps surrogate pairs intact at 4,000-char limit boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(3999)}${fox}${"b".repeat(100)}`;
    const out = formatDefiNewsText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(3999);
    expect(out).not.toContain("\uD83E");
  });

  it("sanitizes lone surrogates in news content", () => {
    const lone = `DeFi update ${String.fromCharCode(0xd800)} report ${"a".repeat(5000)}`;
    const out = formatDefiNewsText(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(DEFI_NEWS_TEXT_LIMIT);
  });
});
