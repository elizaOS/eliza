/**
 * Verifies surrogate-safe truncation for dev-compat screenshot error detail (200).
 * Regression: `text.slice(0,200)` splits astral pairs at boundary; guard must back off.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("dev-compat-routes surrogate-safe truncation (200)", () => {
  it("does not split astral pair at 200", () => {
    const text = `${"a".repeat(199)}🦊${"b".repeat(10)}`;
    const truncated = truncateWellFormed(toWellFormedUnicode(text), 200);
    expect(truncated.length).toBe(199);
    expect(truncated).toBe("a".repeat(199));
    expect(() => JSON.stringify({ detail: truncated })).not.toThrow();
  });

  it("replaces lone high surrogate via toWellFormedUnicode", () => {
    const lone = String.fromCharCode(0xd800);
    const input = lone + "x".repeat(10);
    const out = truncateWellFormed(toWellFormedUnicode(input), 200);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("truncates ASCII verbatim at 200", () => {
    const ascii = "x".repeat(300);
    expect(truncateWellFormed(toWellFormedUnicode(ascii), 200).length).toBe(
      200,
    );
  });

  it("old slice would split surrogate but guard does not", () => {
    const text = `${"a".repeat(199)}🦊`;
    const old = text.slice(0, 200);
    // old slice ends on high surrogate (lead half) -> lone surrogate
    expect(old.charCodeAt(199)).toBe(0xd83e);
    const fixed = truncateWellFormed(toWellFormedUnicode(text), 200);
    expect(fixed.length).toBe(199);
    expect(Number.isNaN(fixed.charCodeAt(199))).toBe(true);
  });
});
