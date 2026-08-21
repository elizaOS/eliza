/**
 * Regression tests for managed payment clients and bridge client error surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function formatPaymentDetail(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 240);
}

function formatBridgeError(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 200);
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

describe("managed payment and bridge client error surrogate safety", () => {
  it("keeps surrogate pairs intact at 240-char boundary in payment client error detail", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"p".repeat(239)}${fox}${"q".repeat(50)}`;
    const out = formatPaymentDetail(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(239);
    expect(out).not.toContain("\uD83E");
  });

  it("keeps surrogate pairs intact at 200-char boundary in bridge client error body", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"b".repeat(199)}${fox}${"c".repeat(50)}`;
    const out = formatBridgeError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(199);
    expect(out).not.toContain("\uD83E");
  });

  it("sanitizes lone surrogates in raw HTTP error response bodies", () => {
    const lone = `Invalid payment gateway response ${String.fromCharCode(0xd800)} trace ${"x".repeat(300)}`;
    const out = formatPaymentDetail(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240);
  });
});
