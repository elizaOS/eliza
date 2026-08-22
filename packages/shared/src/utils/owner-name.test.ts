/**
 * Unit tests for lossless owner-name normalization.
 * Exercises standard strings, whitespace trimming, long content preservation,
 * empty inputs, and non-string coercion to an empty string.
 */
import { describe, expect, it } from "vitest";
import { normalizeOwnerName } from "./owner-name.js";

describe("normalizeOwnerName", () => {
  it("passes standard owner names through", () => {
    expect(normalizeOwnerName("alice")).toBe("alice");
    expect(normalizeOwnerName("Bob Smith")).toBe("Bob Smith");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOwnerName("  alice  ")).toBe("alice");
    expect(normalizeOwnerName("\n\tBob\t\n")).toBe("Bob");
  });

  it("preserves long names completely", () => {
    const longName = `${"a".repeat(100)}complete-owner-name-tail`;
    const normalized = normalizeOwnerName(longName);
    expect(normalized).toBe(longName);
    expect(normalized).toContain("complete-owner-name-tail");
  });

  it("trims without shortening", () => {
    const paddedLongName = `  ${"b".repeat(80)}  `;
    const normalized = normalizeOwnerName(paddedLongName);
    expect(normalized).toBe("b".repeat(80));
  });

  it("returns empty string for empty or whitespace-only strings", () => {
    expect(normalizeOwnerName("")).toBe("");
    expect(normalizeOwnerName("   ")).toBe("");
  });

  it("coerces non-string inputs to empty string", () => {
    expect(normalizeOwnerName(null)).toBe("");
    expect(normalizeOwnerName(undefined)).toBe("");
    expect(normalizeOwnerName(123 as unknown as string)).toBe("");
    expect(normalizeOwnerName({} as unknown as string)).toBe("");
    expect(normalizeOwnerName([] as unknown as string)).toBe("");
    expect(normalizeOwnerName(true as unknown as string)).toBe("");
  });
});
