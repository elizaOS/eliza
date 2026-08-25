/**
 * Verifies surrogate-safe truncation for dev-compat screenshot error detail (200).
 * Regression: `text.slice(0,200)` splits astral pairs at boundary; guard must back off.
 * Asserts on the exported route helper so the test fails if the route regresses.
 */

import { describe, expect, it } from "vitest";
import { formatScreenshotErrorDetail } from "./dev-compat-routes.ts";

function isWellFormed(value: string): boolean {
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return !/[\uD800-\uDFFF]/.test(value);
}

describe("dev-compat-routes surrogate-safe truncation (200)", () => {
  it("does not split astral pair at 200", () => {
    const text = "a".repeat(199) + "🦊" + "b".repeat(10);
    const truncated = formatScreenshotErrorDetail(text);
    expect(truncated.length).toBe(199);
    expect(truncated).toBe("a".repeat(199));
    expect(isWellFormed(truncated)).toBe(true);
    expect(() => JSON.stringify({ detail: truncated })).not.toThrow();
  });

  it("replaces lone high surrogate via toWellFormedUnicode", () => {
    const lone = String.fromCharCode(0xd800);
    const input = lone + "x".repeat(10);
    const out = formatScreenshotErrorDetail(input);
    expect(out.includes("�")).toBe(true);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("truncates ASCII verbatim at 200", () => {
    const ascii = "x".repeat(300);
    const out = formatScreenshotErrorDetail(ascii);
    expect(out.length).toBe(200);
    expect(isWellFormed(out)).toBe(true);
  });

  it("old slice would split surrogate but guard does not", () => {
    const text = "a".repeat(199) + "🦊";
    const old = text.slice(0, 200);
    expect(old.charCodeAt(199)).toBe(0xd83e);
    expect(isWellFormed(old)).toBe(false);
    const fixed = formatScreenshotErrorDetail(text);
    expect(fixed.length).toBe(199);
    expect(isWellFormed(fixed)).toBe(true);
    expect(Number.isNaN(fixed.charCodeAt(199))).toBe(true);
  });
});
