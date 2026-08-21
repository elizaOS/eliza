/**
 * Regression tests for cloud-compat-routes and credit-balance surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { summarizeUpstreamBody } from "./routes/cloud-compat-routes.ts";

function formatCreditText(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 240);
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

describe("elizacloud compat routes and credit balance surrogate safety", () => {
  it("keeps surrogate pairs intact in summarizeUpstreamBody at 300-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(296)}${fox}${"b".repeat(100)}`;
    const out = summarizeUpstreamBody(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).not.toContain("\uD83E");
  });

  it("keeps surrogate pairs intact in credit balance text at 240-char limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `Credits info: ${"c".repeat(225)}${fox}${"d".repeat(50)}`;
    const out = formatCreditText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out).not.toContain("\uD83E");
  });

  it("sanitizes lone surrogates in upstream body text", () => {
    const lone = `Upstream error ${String.fromCharCode(0xd800)} trace ${"e".repeat(500)}`;
    const out = summarizeUpstreamBody(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
