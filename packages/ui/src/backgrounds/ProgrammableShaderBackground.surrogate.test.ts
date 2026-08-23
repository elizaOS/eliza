/**
 * Regression: compile error string may contain isolated surrogates; guard
 * must use truncateWellFormed(toWellFormedUnicode(...),200) to avoid splitting
 * astral pairs at the 200-char boundary.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

describe("ProgrammableShaderBackground surrogate-safe", () => {
  it("replaces lone surrogate before truncating", () => {
    const lone = "\uD800";
    const text = "a".repeat(199) + lone + "b".repeat(10);
    const old = text.slice(0, 200);
    expect(old.charCodeAt(199).toString(16)).toBe("d800");
    const safe = truncateWellFormed(toWellFormedUnicode(text), 200);
    expect(safe.length).toBeLessThanOrEqual(200);
    expect(safe.includes("\uFFFD") || !safe.includes("\uD800")).toBe(true);
  });
  it("does not split astral pair at boundary", () => {
    const astral = "🦊";
    const text = "x".repeat(199) + astral + "y".repeat(10);
    const old = text.slice(0, 200);
    // old splits the surrogate pair
    expect(old.length).toBe(200);
    const safe = truncateWellFormed(toWellFormedUnicode(text), 200);
    expect(safe.length).toBeLessThanOrEqual(200);
    expect([...safe].join("").includes("🦊") || safe.length < 200).toBe(true);
  });
  it("caps at 200", () => {
    const long = "a".repeat(500);
    const safe = truncateWellFormed(toWellFormedUnicode(long), 200);
    expect(safe.length).toBe(200);
  });
});
