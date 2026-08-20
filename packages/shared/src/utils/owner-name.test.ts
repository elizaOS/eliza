/**
 * Unit tests for normalizeOwnerName and OWNER_NAME_MAX_LENGTH in packages/shared/src/utils/owner-name.ts.
 * Exercises standard string passthroughs, whitespace trimming, 60-character length capping,
 * empty/whitespace inputs, and non-string coercions to empty string.
 */
import { describe, expect, it } from "vitest";
import { normalizeOwnerName, OWNER_NAME_MAX_LENGTH } from "./owner-name.js";

describe("normalizeOwnerName", () => {
  it("exports OWNER_NAME_MAX_LENGTH as 60", () => {
    expect(OWNER_NAME_MAX_LENGTH).toBe(60);
  });

  it("passes standard owner names through", () => {
    expect(normalizeOwnerName("alice")).toBe("alice");
    expect(normalizeOwnerName("Bob Smith")).toBe("Bob Smith");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOwnerName("  alice  ")).toBe("alice");
    expect(normalizeOwnerName("\n\tBob\t\n")).toBe("Bob");
  });

  it("truncates names exceeding OWNER_NAME_MAX_LENGTH", () => {
    const longName = "a".repeat(100);
    const normalized = normalizeOwnerName(longName);
    expect(normalized).toHaveLength(60);
    expect(normalized).toBe("a".repeat(60));
  });

  it("trims before truncating", () => {
    const paddedLongName = `  ${"b".repeat(80)}  `;
    const normalized = normalizeOwnerName(paddedLongName);
    expect(normalized).toHaveLength(60);
    expect(normalized).toBe("b".repeat(60));
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
