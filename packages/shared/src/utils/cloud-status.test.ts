/**
 * Unit tests for cloud-status helpers in packages/shared/src/utils/cloud-status.ts.
 * Exercises API-key-only reason classification, whitespace trimming, non-string
 * input handling, and cloud authenticated state determination.
 */
import { describe, expect, it } from "vitest";
import {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "./cloud-status.js";

describe("isCloudStatusReasonApiKeyOnly", () => {
  it("identifies API-key-only reason codes", () => {
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_not_authenticated"),
    ).toBe(true);
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_runtime_not_started"),
    ).toBe(true);
  });

  it("handles reasons with surrounding whitespace", () => {
    expect(
      isCloudStatusReasonApiKeyOnly("  api_key_present_not_authenticated\n"),
    ).toBe(true);
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_runtime_not_started "),
    ).toBe(true);
  });

  it("returns false for unknown reasons and non-string inputs", () => {
    expect(isCloudStatusReasonApiKeyOnly("disconnected")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly("")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(null)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(undefined)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(123 as unknown as string)).toBe(false);
  });
});

describe("isCloudStatusAuthenticated", () => {
  it("returns true when connected and reason is not API-key-only", () => {
    expect(isCloudStatusAuthenticated(true, undefined)).toBe(true);
    expect(isCloudStatusAuthenticated(true, null)).toBe(true);
    expect(isCloudStatusAuthenticated(true, "ready")).toBe(true);
  });

  it("returns false when connected is true but reason is API-key-only", () => {
    expect(
      isCloudStatusAuthenticated(true, "api_key_present_not_authenticated"),
    ).toBe(false);
    expect(
      isCloudStatusAuthenticated(true, "api_key_present_runtime_not_started"),
    ).toBe(false);
  });

  it("returns false when connected is false", () => {
    expect(isCloudStatusAuthenticated(false, undefined)).toBe(false);
    expect(isCloudStatusAuthenticated(false, "ready")).toBe(false);
  });
});
