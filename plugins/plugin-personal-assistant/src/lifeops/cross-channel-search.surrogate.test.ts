/**
 * Surrogate-safe truncation for cross-channel search labels and previews.
 * Verifies 80/48/600 caps never split an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncateLabel(snippet: string): string {
  return truncateWellFormed(toWellFormedUnicode(snippet), 80);
}
function truncateText(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 600);
}
function truncateSourceRef(content: string): string {
  return truncateWellFormed(toWellFormedUnicode(content), 48);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("cross-channel-search surrogate handling", () => {
  it("label 80 backs off at surrogate boundary", () => {
    const snippet = `${"a".repeat(79)}🦊${"b".repeat(20)}`;
    const out = truncateLabel(snippet);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.length).toBe(79);
  });

  it("label 80 preserves fitting emoji", () => {
    const snippet = `${"a".repeat(78)}🦊`;
    const out = truncateLabel(snippet);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(78)}🦊`);
  });

  it("text 600 caps and stays well-formed sweep", () => {
    for (let off = 0; off < 20; off++) {
      const input = `${"a".repeat(590 + off)}🦊😀${"b".repeat(50)}`;
      const out = truncateText(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(600);
    }
  });

  it("sourceRef 48 backs off and sanitizes lone surrogate", () => {
    const lone = `ok \ud800 end ${"a".repeat(100)}`;
    const out = truncateSourceRef(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(48);
    const emoji = `${"a".repeat(47)}🦊${"b".repeat(20)}`;
    const out2 = truncateSourceRef(emoji);
    expect(isWellFormed(out2)).toBe(true);
    expect(out2.length).toBeLessThanOrEqual(48);
  });
});
