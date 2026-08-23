/**
 * Unit tests for CLI state profile name validation and normalization.
 */

import { describe, expect, it } from "vitest";
import { isValidProfileName, normalizeProfileName } from "./profile-utils.js";

describe("profile-utils", () => {
  describe("isValidProfileName", () => {
    it("accepts valid alphanumeric, dash, and underscore profile names", () => {
      expect(isValidProfileName("dev")).toBe(true);
      expect(isValidProfileName("stage_01")).toBe(true);
      expect(isValidProfileName("test-profile-2")).toBe(true);
      expect(isValidProfileName("a")).toBe(true);
    });

    it("rejects empty or invalid profile names", () => {
      expect(isValidProfileName("")).toBe(false);
      expect(isValidProfileName("-leading-dash")).toBe(false);
      expect(isValidProfileName("_leading-underscore")).toBe(false);
      expect(isValidProfileName("invalid/slash")).toBe(false);
      expect(isValidProfileName("with space")).toBe(false);
      expect(isValidProfileName("a".repeat(65))).toBe(false);
    });
  });

  describe("normalizeProfileName", () => {
    it("trims and returns valid non-default profile names", () => {
      expect(normalizeProfileName(" dev ")).toBe("dev");
      expect(normalizeProfileName("stage-1")).toBe("stage-1");
    });

    it("returns null for empty, undefined, null, or invalid input", () => {
      expect(normalizeProfileName(undefined)).toBeNull();
      expect(normalizeProfileName(null)).toBeNull();
      expect(normalizeProfileName("")).toBeNull();
      expect(normalizeProfileName("   ")).toBeNull();
      expect(normalizeProfileName("invalid/path")).toBeNull();
    });

    it("returns null for reserved 'default' profile name (case-insensitive)", () => {
      expect(normalizeProfileName("default")).toBeNull();
      expect(normalizeProfileName("DEFAULT")).toBeNull();
      expect(normalizeProfileName(" Default ")).toBeNull();
    });
  });
});
