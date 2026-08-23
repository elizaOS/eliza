/**
 * Verifies cloud-status authentication and API-key reason classification through deterministic pure-function tests.
 */
import { describe, expect, it } from "vitest";
import {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "../cloud-status.ts";

describe("isCloudStatusReasonApiKeyOnly", () => {
  it("classifies api-key-only reasons", () => {
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_not_authenticated"),
    ).toBe(true);
    expect(
      isCloudStatusReasonApiKeyOnly("api_key_present_runtime_not_started"),
    ).toBe(true);
  });

  it("rejects other reasons and nullish", () => {
    expect(isCloudStatusReasonApiKeyOnly("connected")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly("")).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(null)).toBe(false);
    expect(isCloudStatusReasonApiKeyOnly(undefined)).toBe(false);
  });
});

describe("isCloudStatusAuthenticated", () => {
  it("requires connected and non-api-key-only", () => {
    expect(isCloudStatusAuthenticated(true, "ok")).toBe(true);
    expect(isCloudStatusAuthenticated(false, "ok")).toBe(false);
    expect(
      isCloudStatusAuthenticated(true, "api_key_present_not_authenticated"),
    ).toBe(false);
  });
});
