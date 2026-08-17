/**
 * Unit tests for cloud status classification utilities in packages/shared/src/utils/cloud-status.ts.
 * Exercises API key only reason codes, whitespace trimming, disconnected states,
 * and authenticated state logic.
 */
import { describe, expect, it } from "vitest";
import {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "./cloud-status.js";

describe("cloud status utilities", () => {
  describe("isCloudStatusReasonApiKeyOnly", () => {
    it("returns true for exact key-only reason strings", () => {
      expect(
        isCloudStatusReasonApiKeyOnly("api_key_present_not_authenticated"),
      ).toBe(true);
      expect(
        isCloudStatusReasonApiKeyOnly("api_key_present_runtime_not_started"),
      ).toBe(true);
    });

    it("trims whitespace from reason strings", () => {
      expect(
        isCloudStatusReasonApiKeyOnly("  api_key_present_not_authenticated  "),
      ).toBe(true);
      expect(
        isCloudStatusReasonApiKeyOnly(
          "\napi_key_present_runtime_not_started\t",
        ),
      ).toBe(true);
    });

    it("returns false for non-key-only reason strings", () => {
      expect(isCloudStatusReasonApiKeyOnly("disconnected")).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly("invalid_credentials")).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly("")).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly("   ")).toBe(false);
    });

    it("returns false for nullish or non-string inputs", () => {
      expect(isCloudStatusReasonApiKeyOnly(null)).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly(undefined)).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly(123 as unknown as string)).toBe(
        false,
      );
    });
  });

  describe("isCloudStatusAuthenticated", () => {
    it("returns true when connected and reason is not key-only", () => {
      expect(isCloudStatusAuthenticated(true, undefined)).toBe(true);
      expect(isCloudStatusAuthenticated(true, null)).toBe(true);
      expect(isCloudStatusAuthenticated(true, "ready")).toBe(true);
    });

    it("returns false when connected but reason is key-only", () => {
      expect(
        isCloudStatusAuthenticated(true, "api_key_present_not_authenticated"),
      ).toBe(false);
      expect(
        isCloudStatusAuthenticated(
          true,
          "  api_key_present_runtime_not_started  ",
        ),
      ).toBe(false);
    });

    it("returns false when not connected regardless of reason", () => {
      expect(isCloudStatusAuthenticated(false, undefined)).toBe(false);
      expect(isCloudStatusAuthenticated(false, "ready")).toBe(false);
      expect(
        isCloudStatusAuthenticated(false, "api_key_present_not_authenticated"),
      ).toBe(false);
    });
  });
});
