/**
 * Regression for form restore response truncation surrogate safety (4000).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const RESTORE_RESPONSE_MAX_CHARS = 4_000;

function truncateRestoreResponse(text: string): string {
  const wellFormed = toWellFormedUnicode(text);
  return wellFormed.length <= RESTORE_RESPONSE_MAX_CHARS
    ? wellFormed
    : `${truncateWellFormed(wellFormed, RESTORE_RESPONSE_MAX_CHARS)}\n\n[truncated restored form summary]`;
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

describe("form restore response truncateRestoreResponse well-formed", () => {
  it("keeps surrogate pair intact at 4000-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(RESTORE_RESPONSE_MAX_CHARS - 1)}${fox}${"b".repeat(50)}`;
    const out = truncateRestoreResponse(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("[truncated restored form summary]")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(3000)}${fox}`;
    const out = truncateRestoreResponse(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate before truncation", () => {
    const lone = `form ${String.fromCharCode(0xd800)} ${"a".repeat(5000)}`;
    const out = truncateRestoreResponse(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `form ${String.fromCharCode(0xd800)} ok`;
    const out = truncateRestoreResponse(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("form \uFFFD ok");
  });
});
