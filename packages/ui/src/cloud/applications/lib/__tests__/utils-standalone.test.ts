/**
 * Unit tests for applications domain UUID validation utility.
 */
import { describe, expect, it } from "vitest";
import { isValidUUID } from "../utils.ts";

describe("applications utils", () => {
  describe("isValidUUID", () => {
    it("returns true for valid standard UUIDs across versions 1-5", () => {
      expect(isValidUUID("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
      expect(isValidUUID("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).toBe(true);
      expect(isValidUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
      expect(isValidUUID("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11")).toBe(true);
    });

    it("returns false for invalid UUID strings", () => {
      expect(isValidUUID("")).toBe(false);
      expect(isValidUUID("not-a-uuid")).toBe(false);
      expect(isValidUUID("123e4567-e89b-12d3-a456-42661417400")).toBe(false); // too short
      expect(isValidUUID("123e4567-e89b-12d3-a456-4266141740000")).toBe(false); // too long
      expect(isValidUUID("123e4567-e89b-62d3-a456-426614174000")).toBe(false); // invalid version 6
      expect(isValidUUID("123e4567-e89b-12d3-0456-426614174000")).toBe(false); // invalid variant 0
      expect(isValidUUID("123e4567_e89b_12d3_a456_426614174000")).toBe(false); // underscores instead of dashes
    });
  });
});
