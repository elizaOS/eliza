/**
 * Regression for ACP native transport compactJson serialization surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function compactJson(value: unknown): string | undefined {
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) {
      return undefined;
    }
    const serialized = toWellFormedUnicode(raw);
    const limit = 2000;
    return serialized.length > limit
      ? `${truncateWellFormed(serialized, limit)}…`
      : serialized;
  } catch {
    return undefined;
  }
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

describe("ACP native transport compactJson surrogate safety", () => {
  it("keeps surrogate pair intact at 2000-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const value = { error: `${"a".repeat(1985)}${fox}${"b".repeat(50)}` };
    const out = compactJson(value);
    expect(out).toBeDefined();
    expect(isWellFormed(out ?? "")).toBe(true);
    expect(out?.endsWith("…")).toBe(true);
  });

  it("handles non-string or circular error cleanly", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = compactJson(circular);
    expect(out).toBeUndefined();
  });

  it("sanitizes lone surrogate in string values", () => {
    const lone = `error ${String.fromCharCode(0xd800)} ${"a".repeat(3000)}`;
    const out = compactJson({ err: lone });
    expect(out).toBeDefined();
    expect(isWellFormed(out ?? "")).toBe(true);
    expect(out?.length).toBeLessThanOrEqual(2001);
  });
});
