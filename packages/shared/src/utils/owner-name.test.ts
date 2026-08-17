/**
 * Unit tests for owner name normalization in packages/shared/src/utils/owner-name.ts.
 * Exercises trimming, character length capping at OWNER_NAME_MAX_LENGTH, empty/whitespace strings,
 * and non-string type coercion.
 */
import { describe, expect, it } from "vitest";
import { OWNER_NAME_MAX_LENGTH, normalizeOwnerName } from "./owner-name.js";

describe("owner name utilities", () => {
  it("defines OWNER_NAME_MAX_LENGTH as 60", () => {
    expect(OWNER_NAME_MAX_LENGTH).toBe(60);
  });

  describe("normalizeOwnerName", () => {
    it("trims valid names", () => {
      expect(normalizeOwnerName("  Alice Smith  ")).toBe("Alice Smith");
      expect(normalizeOwnerName("\tBob Jones\n")).toBe("Bob Jones");
    });

    it("caps names exceeding OWNER_NAME_MAX_LENGTH to 60 characters", () => {
      const longName = "a".repeat(100);
      const normalized = normalizeOwnerName(longName);
      expect(normalized).toHaveLength(60);
      expect(normalized).toBe("a".repeat(60));
    });

    it("preserves names at exactly 60 characters", () => {
      const exactName = "x".repeat(60);
      expect(normalizeOwnerName(exactName)).toBe(exactName);
      expect(normalizeOwnerName(exactName)).toHaveLength(60);
    });

    it("returns empty string for empty or whitespace-only inputs", () => {
      expect(normalizeOwnerName("")).toBe("");
      expect(normalizeOwnerName("   ")).toBe("");
      expect(normalizeOwnerName("\n\t  ")).toBe("");
    });

    it("returns empty string for nullish or non-string inputs", () => {
      expect(normalizeOwnerName(null)).toBe("");
      expect(normalizeOwnerName(undefined)).toBe("");
      expect(normalizeOwnerName(12345 as unknown as string)).toBe("");
      expect(normalizeOwnerName({ name: "Alice" } as unknown as string)).toBe(
        "",
      );
      expect(normalizeOwnerName(true as unknown as string)).toBe("");
    });
  });
});
