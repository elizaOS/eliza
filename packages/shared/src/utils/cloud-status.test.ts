/**
 * Unit tests for cloud status classification utilities in packages/shared/src/utils/cloud-status.ts.
 * Exercises API-key-only reason classification, unknown/invalid reason handling, and authenticated
 * status derivation across connection states.
 */
import { describe, expect, it } from "vitest";
import {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "./cloud-status.js";

describe("cloud-status utilities", () => {
  describe("isCloudStatusReasonApiKeyOnly", () => {
    it("returns true for exact API-key-only reason codes", () => {
      expect(
        isCloudStatusReasonApiKeyOnly("api_key_present_not_authenticated"),
      ).toBe(true);
      expect(
        isCloudStatusReasonApiKeyOnly("api_key_present_runtime_not_started"),
      ).toBe(true);
    });

    it("returns false for non-key-only reason codes", () => {
      expect(isCloudStatusReasonApiKeyOnly("connected")).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly("disconnected")).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly("network_error")).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly("")).toBe(false);
    });

    it("returns false for nullish inputs", () => {
      expect(isCloudStatusReasonApiKeyOnly(null)).toBe(false);
      expect(isCloudStatusReasonApiKeyOnly(undefined)).toBe(false);
    });
  });

  describe("isCloudStatusAuthenticated", () => {
    it("returns true when connected is true and reason is not API-key-only", () => {
      expect(isCloudStatusAuthenticated(true, undefined)).toBe(true);
      expect(isCloudStatusAuthenticated(true, null)).toBe(true);
      expect(isCloudStatusAuthenticated(true, "session_active")).toBe(true);
    });

    it("returns false when connected is true but reason is API-key-only", () => {
      expect(
        isCloudStatusAuthenticated(true, "api_key_present_not_authenticated"),
      ).toBe(false);
      expect(
        isCloudStatusAuthenticated(true, "api_key_present_runtime_not_started"),
      ).toBe(false);
    });

    it("returns false when connected is false regardless of reason", () => {
      expect(isCloudStatusAuthenticated(false, undefined)).toBe(false);
      expect(isCloudStatusAuthenticated(false, null)).toBe(false);
      expect(isCloudStatusAuthenticated(false, "session_active")).toBe(false);
      expect(
        isCloudStatusAuthenticated(false, "api_key_present_not_authenticated"),
      ).toBe(false);
    });
  });
});
