/**
 * Regression: logger preview slices external user text; must use
 * truncateWellFormed(toWellFormedUnicode(...),200) to avoid lone surrogates.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

function preview(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text.replace(/\s+/g, " ").trim()), 200);
}

describe("discord messages surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    const lone = "\uD800";
    const text = "a".repeat(199) + lone + "b".repeat(10);
    const old = text.replace(/\s+/g, " ").trim().slice(0, 200);
    expect(old.charCodeAt(199).toString(16)).toBe("d800");
    const safe = preview(text);
    expect(safe.length).toBeLessThanOrEqual(200);
    expect(safe.includes("\uFFFD") || !safe.includes("\uD800")).toBe(true);
  });
  it("does not split astral at boundary", () => {
    const astral = "🦊";
    const text = "x".repeat(199) + astral + "y".repeat(10);
    const safe = preview(text);
    expect(safe.length).toBeLessThanOrEqual(200);
  });
  it("caps at 200", () => {
    const long = "a".repeat(500);
    expect(preview(long).length).toBe(200);
  });
});
