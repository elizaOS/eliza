/**
 * Tests for cloud-status utility classifiers (isCloudStatusReasonApiKeyOnly and
 * isCloudStatusAuthenticated).
 */
import { describe, expect, it } from "vitest";
import {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "./cloud-status.ts";

describe("isCloudStatusReasonApiKeyOnly", () => {
  it("returns true for exact api_key_present_not_authenticated", () => {
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_not_authenticated"),
    ).toBe(true);
  });

  it("returns true for exact api_key_present_runtime_not_started", () => {
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_runtime_not_started"),
    ).toBe(true);
  });

  it("returns true for whitespace-padded API key reason strings", () => {
    expect(
      isCloudStatusReasonApiKeyOnly("  api_key_present_not_authenticated  "),
    ).toBe(true);
    expect(
      isCloudStatusReasonApiKeyOnly("\napi_key_present_runtime_not_started\t"),
    ).toBe(true);
  });

  it("returns false for other reason strings", () => {
    expect(isCloudStatusReasonApiKeyOnly("connected")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly("disconnected")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly("invalid_credentials")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly("")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly("   ")).toBe(false);
  });

  it("returns false for nullish or non-string inputs", () => {
    expect(isCloudStatusReasonApiKeyOnly(null)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(undefined)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(123 as unknown as string)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(true as unknown as string)).toBe(
      false,
    );
    expect(isCloudStatusReasonApiKeyOnly({} as unknown as string)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly([] as unknown as string)).toBe(false);
  });
});

describe("isCloudStatusAuthenticated", () => {
  it("returns true when connected is true and reason is nullish or ordinary", () => {
    expect(isCloudStatusAuthenticated(true, undefined)).toBe(true);
    expect(isCloudStatusAuthenticated(true, null)).toBe(true);
    expect(isCloudStatusAuthenticated(true, "authenticated")).toBe(true);
    expect(isCloudStatusAuthenticated(true, "active")).toBe(true);
  });

  it("returns false when connected is true but reason is API key only", () => {
    expect(
      isCloudStatusAuthenticated(true, "api_key_present_not_authenticated"),
    ).toBe(false);
    expect(
      isCloudStatusAuthenticated(true, "api_key_present_runtime_not_started"),
    ).toBe(false);
    expect(
      isCloudStatusAuthenticated(true, "  api_key_present_not_authenticated  "),
    ).toBe(false);
  });

  it("returns false when connected is false", () => {
    expect(isCloudStatusAuthenticated(false, undefined)).toBe(false);
    expect(isCloudStatusAuthenticated(false, null)).toBe(false);
    expect(isCloudStatusAuthenticated(false, "authenticated")).toBe(false);
    expect(
      isCloudStatusAuthenticated(false, "api_key_present_not_authenticated"),
    ).toBe(false);
  });

  it("returns false for truthy non-boolean connected values", () => {
    expect(
      isCloudStatusAuthenticated(1 as unknown as boolean, "authenticated"),
    ).toBe(false);
    expect(
      isCloudStatusAuthenticated("true" as unknown as boolean, "authenticated"),
    ).toBe(false);
    expect(
      isCloudStatusAuthenticated({} as unknown as boolean, "authenticated"),
    ).toBe(false);
  });
});
