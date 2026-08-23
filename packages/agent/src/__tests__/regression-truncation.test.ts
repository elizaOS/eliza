/**
 * Behavioral regression for truncation helpers — serializeForRuntimeDebug
 * Contract: never exceed maxLen, surrogate-safe (well-formed), handles
 * max 0,1,2,tiny,large 6000, Unicode surrogate pairs, fixed-point, err.stack.
 * Calls real serializeForRuntimeDebug — not source-grep.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({ sql: () => ({}) }));

import { serializeForRuntimeDebug } from "../api/health-routes.ts";

function isWellFormed(value: string): boolean {
  if (
    typeof (value as unknown as { isWellFormed?: () => boolean })
      .isWellFormed === "function"
  ) {
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const baseOpts = {
  maxDepth: 4,
  maxArrayLength: 20,
  maxObjectKeys: 20,
} as const;

function previewFor(text: string, max: number): string {
  const out = serializeForRuntimeDebug(text, {
    ...baseOpts,
    maxStringLength: max,
  }) as {
    __type?: string;
    preview?: string;
    truncated?: boolean;
  };
  // When not truncated, serialize returns the string directly
  if (typeof out === "string") return out;
  if (out && typeof out.preview === "string") return out.preview;
  throw new Error(
    `unexpected serialize shape for max=${max}: ${JSON.stringify(out)}`,
  );
}

function stackFor(text: string, max: number): string {
  const err = new Error("oops");
  err.stack = text;
  const out = serializeForRuntimeDebug(err, {
    ...baseOpts,
    maxStringLength: max,
  }) as {
    stack?: string;
  };
  if (out && typeof out.stack === "string") return out.stack;
  throw new Error(
    `unexpected stack shape for max=${max}: ${JSON.stringify(out)}`,
  );
}

describe("serializeForRuntimeDebug — regression-truncation (real function)", () => {
  it("max 0 → preview '' never exceeds, well-formed", () => {
    expect(previewFor("hello", 0)).toBe("");
    expect(previewFor("a".repeat(6000), 0)).toBe("");
    expect(previewFor("👋hello", 0)).toBe("");
    expect(previewFor("hello", 0).length).toBeLessThanOrEqual(0);
    expect(isWellFormed(previewFor("hello", 0))).toBe(true);
    // err.stack also
    expect(stackFor("hello stack", 0)).toBe("");
    expect(stackFor("a".repeat(6000), 0)).toBe("");
  });

  it("max 1 → preview length 1, well-formed, surrogate-safe, never exceeds", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀
    expect(
      previewFor(`${emoji}${"a".repeat(10)}`, 1).length,
    ).toBeLessThanOrEqual(1);
    expect(isWellFormed(previewFor(`${emoji}${"a".repeat(10)}`, 1))).toBe(true);
    expect(previewFor(`${emoji}${"a".repeat(10)}`, 1).isWellFormed()).toBe(
      true,
    );
    // large 6000 with max 1
    expect(previewFor("a".repeat(6000), 1).length).toBeLessThanOrEqual(1);
    expect(previewFor("a".repeat(6000), 1).length).toBe(1);
    expect(stackFor("hello stack hello", 1).length).toBeLessThanOrEqual(1);
    expect(isWellFormed(stackFor(`${emoji}${"a".repeat(10)}`, 1))).toBe(true);
  });

  it("max 2 → preview length <=2, well-formed, never exceeds", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(16)}${emoji}${"b".repeat(20)}`;
    expect(previewFor(text, 2).length).toBeLessThanOrEqual(2);
    expect(isWellFormed(previewFor(text, 2))).toBe(true);
    expect(previewFor(text, 2).isWellFormed()).toBe(true);
    expect(stackFor(text, 2).length).toBeLessThanOrEqual(2);
    expect(isWellFormed(stackFor(text, 2))).toBe(true);
  });

  it("tiny max 3,4,5 — never exceeds, surrogate-safe", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    for (const max of [3, 4, 5, 10]) {
      const text = `${"a".repeat(16)}${emoji}${"b".repeat(20)}`;
      const pre = previewFor(text, max);
      expect(pre.length).toBeLessThanOrEqual(max);
      expect(isWellFormed(pre)).toBe(true);
      expect(pre.isWellFormed()).toBe(true);
      const stk = stackFor(text, max);
      expect(stk.length).toBeLessThanOrEqual(max);
      expect(isWellFormed(stk)).toBe(true);
    }
  });

  it("surrogate pair at truncation boundary is not split (max 20)", () => {
    // 16 leading "a" puts boundary at 17 (between surrogates) for max=20 -> max-3=17
    const longString = `${"a".repeat(16)}😀${"b".repeat(10)}`;
    const pre = previewFor(longString, 20);
    expect(pre.endsWith("...")).toBe(true);
    expect(pre.includes("😀")).toBe(false);
    expect(pre).toBe(pre.toWellFormed());
    expect(
      /[\uD800-\uDFFF]/.test(
        pre.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
      ),
    ).toBe(false);
    expect(pre.length).toBeLessThanOrEqual(20);
    // Also verify err.stack path is surrogate-safe at same boundary
    const stk = stackFor(longString, 20);
    expect(stk).toBe(stk.toWellFormed());
    expect(stk.length).toBeLessThanOrEqual(20);
  });

  it("large 6000 with max 20 and 200 — truncated, never exceeds, well-formed, fixed-point", () => {
    const huge = "a".repeat(6000);
    for (const max of [20, 200]) {
      const pre = previewFor(huge, max);
      expect(pre.length).toBeLessThanOrEqual(max);
      expect(pre.length).toBeGreaterThan(0);
      expect(isWellFormed(pre)).toBe(true);
      expect(pre.isWellFormed()).toBe(true);
      // fixed-point: calling twice gives same result
      expect(previewFor(huge, max)).toBe(pre);
      expect(stackFor(huge, max).length).toBeLessThanOrEqual(max);
      expect(stackFor(huge, max)).toBe(stackFor(huge, max));
    }
    // 6000 with max 6000 should NOT truncate (equal)
    const exact = previewFor(huge, 6000);
    // serialize returns original string when length <= max, not preview object
    expect(exact).toBe(huge);
    expect(exact.length).toBe(6000);
  });

  it("preserves well-formed when under cap (no truncation)", () => {
    const text = "short";
    const pre = serializeForRuntimeDebug(text, {
      ...baseOpts,
      maxStringLength: 20,
    });
    expect(pre).toBe(text);
  });

  it("never emits lone surrogates across sweep of offsets at max 20", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 30; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(100)}`;
      const pre = previewFor(text, 20);
      expect(isWellFormed(pre)).toBe(true);
      expect(pre.isWellFormed()).toBe(true);
      expect(pre.length).toBeLessThanOrEqual(20);
      expect(() => JSON.stringify(pre)).not.toThrow();
      const stk = stackFor(text, 20);
      expect(isWellFormed(stk)).toBe(true);
      expect(stk.length).toBeLessThanOrEqual(20);
    }
  });

  it("sanitizes lone surrogates before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const pre = previewFor(lone, 20);
    expect(pre.includes("�")).toBe(true);
    expect(isWellFormed(pre)).toBe(true);
    expect(pre.isWellFormed()).toBe(true);
    expect(pre.length).toBeLessThanOrEqual(20);
    const stk = stackFor(lone, 20);
    expect(stk.includes("�")).toBe(true);
    expect(isWellFormed(stk)).toBe(true);
  });

  it("fixed-point: truncated preview length is deterministic for surrogate boundary", () => {
    const text = `${"a".repeat(16)}😀${"b".repeat(100)}`;
    const first = previewFor(text, 20);
    const second = previewFor(text, 20);
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(20);
    // backs off from 17 to 16 before adding "..." => length 19 (16 + 3) not 20
    expect(first.length).toBe(19);
  });
});
