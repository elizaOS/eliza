/**
 * Regression tests for Kamino provider surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const MAX_KAMINO_REPORT_CHARS = 8000;
const KAMINO_POOL_TEXT_LIMIT = 4000;
const KAMINO_LIQUIDITY_TEXT_LIMIT = 4000;

function formatKaminoReport(report: string): string {
  return truncateWellFormed(
    toWellFormedUnicode(report),
    MAX_KAMINO_REPORT_CHARS,
  );
}

function formatKaminoText(info: string, limit: number): string {
  return truncateWellFormed(toWellFormedUnicode(`${info}\n`), limit);
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

describe("Kamino providers surrogate safety", () => {
  it("keeps surrogate pairs intact at 8,000-char boundary in kaminoProvider", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"k".repeat(7999)}${fox}${"m".repeat(100)}`;
    const out = formatKaminoReport(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(7999);
    expect(out).not.toContain("\uD83E");
  });

  it("keeps surrogate pairs intact at 4,000-char boundary in kaminoPoolProvider", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"p".repeat(3999)}${fox}${"q".repeat(100)}`;
    const out = formatKaminoText(input, KAMINO_POOL_TEXT_LIMIT);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(3999);
    expect(out).not.toContain("\uD83E");
  });

  it("keeps surrogate pairs intact at 4,000-char boundary in kaminoLiquidityProvider", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"l".repeat(3999)}${fox}${"x".repeat(100)}`;
    const out = formatKaminoText(input, KAMINO_LIQUIDITY_TEXT_LIMIT);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(3999);
    expect(out).not.toContain("\uD83E");
  });

  it("sanitizes lone surrogate in report payloads", () => {
    const lone = `Kamino vault ${String.fromCharCode(0xd800)} details ${"z".repeat(10000)}`;
    const out = formatKaminoReport(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_KAMINO_REPORT_CHARS);
  });
});
