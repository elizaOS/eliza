/**
 * Unit tests for applications domain utility helpers.
 * Validates syntax checking for v1-v5 UUID format strings.
 */
import { describe, expect, it } from "vitest";
import { isValidUUID } from "../utils.ts";

describe("applications/lib/utils", () => {
  describe("isValidUUID", () => {
    it("validates canonical v4 UUIDs", () => {
      expect(isValidUUID("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
      expect(isValidUUID("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")).toBe(true);
      expect(isValidUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
    });

    it("accepts uppercase UUIDs", () => {
      expect(isValidUUID("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
    });

    it("validates UUIDs across versions 1 through 5", () => {
      expect(isValidUUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true); // v1
      expect(isValidUUID("6ba7b811-9dad-21d1-80b4-00c04fd430c8")).toBe(true); // v2
      expect(isValidUUID("6ba7b812-9dad-31d1-80b4-00c04fd430c8")).toBe(true); // v3
      expect(isValidUUID("6ba7b814-9dad-51d1-80b4-00c04fd430c8")).toBe(true); // v5
    });

    it("rejects malformed and non-UUID strings", () => {
      expect(isValidUUID("")).toBe(false);
      expect(isValidUUID("not-a-uuid")).toBe(false);
      expect(isValidUUID("123e4567-e89b-12d3-a456")).toBe(false);
      expect(isValidUUID("123e4567-e89b-12d3-a456-426614174000-extra")).toBe(
        false,
      );
      expect(isValidUUID("123e4567e89b12d3a456426614174000")).toBe(false);
      expect(isValidUUID("123e4567-e89b-62d3-a456-426614174000")).toBe(false); // invalid version 6
      expect(isValidUUID("123e4567-e89b-42d3-c456-426614174000")).toBe(false); // invalid variant c
    });
  });
});
