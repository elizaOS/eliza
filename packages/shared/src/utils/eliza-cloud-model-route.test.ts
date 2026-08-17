/**
 * Unit tests for modelLooksLikeElizaCloudHosted in packages/shared/src/utils/eliza-cloud-model-route.ts.
 * Exercises Kimi, Moonshot, and Eliza Cloud model name matching, case-insensitivity,
 * whitespace trimming, non-hosted model rejections, and nullish/non-string inputs.
 */
import { describe, expect, it } from "vitest";
import { modelLooksLikeElizaCloudHosted } from "./eliza-cloud-model-route.js";

describe("modelLooksLikeElizaCloudHosted", () => {
  it("returns true for Kimi models", () => {
    expect(modelLooksLikeElizaCloudHosted("kimi-k1.5")).toBe(true);
    expect(modelLooksLikeElizaCloudHosted("Kimi-Chat-32k")).toBe(true);
    expect(modelLooksLikeElizaCloudHosted("  kimi  ")).toBe(true);
  });

  it("returns true for Moonshot models", () => {
    expect(modelLooksLikeElizaCloudHosted("moonshot-v1-8k")).toBe(true);
    expect(modelLooksLikeElizaCloudHosted("MOONSHOT-v1-128k")).toBe(true);
  });

  it("returns true for models containing both eliza and cloud", () => {
    expect(modelLooksLikeElizaCloudHosted("eliza-cloud-deepseek-r1")).toBe(
      true,
    );
    expect(modelLooksLikeElizaCloudHosted("ElizaCloud/llama-3.3-70b")).toBe(
      true,
    );
  });

  it("returns false for models containing only eliza or only cloud", () => {
    expect(modelLooksLikeElizaCloudHosted("eliza-local-v1")).toBe(false);
    expect(modelLooksLikeElizaCloudHosted("google-cloud-vertex")).toBe(false);
  });

  it("returns false for non-hosted external models", () => {
    expect(modelLooksLikeElizaCloudHosted("gpt-4o")).toBe(false);
    expect(modelLooksLikeElizaCloudHosted("claude-3-5-sonnet")).toBe(false);
    expect(modelLooksLikeElizaCloudHosted("gemini-2.0-flash")).toBe(false);
  });

  it("returns false for empty, null, undefined, or non-string inputs", () => {
    expect(modelLooksLikeElizaCloudHosted("")).toBe(false);
    expect(modelLooksLikeElizaCloudHosted("   ")).toBe(false);
    expect(modelLooksLikeElizaCloudHosted(null)).toBe(false);
    expect(modelLooksLikeElizaCloudHosted(undefined)).toBe(false);
    expect(modelLooksLikeElizaCloudHosted(123 as unknown as string)).toBe(
      false,
    );
  });
});
