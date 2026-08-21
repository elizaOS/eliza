/**
 * Unit tests for Eliza Cloud hosted model route classification in packages/shared/src/utils/eliza-cloud-model-route.ts.
 * Exercises heuristic detection for Kimi, Moonshot, and Eliza Cloud combined route model identifiers.
 */
import { describe, expect, it } from "vitest";
import { modelLooksLikeElizaCloudHosted } from "./eliza-cloud-model-route.js";

describe("eliza-cloud-model-route utilities", () => {
  describe("modelLooksLikeElizaCloudHosted", () => {
    it("returns true for Kimi model identifiers", () => {
      expect(modelLooksLikeElizaCloudHosted("kimi-k1.5")).toBe(true);
      expect(modelLooksLikeElizaCloudHosted("moonshot-kimi-preview")).toBe(
        true,
      );
      expect(modelLooksLikeElizaCloudHosted("KIMI-CHAT")).toBe(true);
    });

    it("returns true for Moonshot model identifiers", () => {
      expect(modelLooksLikeElizaCloudHosted("moonshot-v1-8k")).toBe(true);
      expect(modelLooksLikeElizaCloudHosted("moonshot-v1-32k")).toBe(true);
      expect(modelLooksLikeElizaCloudHosted("MOONSHOT-V1-128K")).toBe(true);
    });

    it("returns true for models containing both 'eliza' and 'cloud'", () => {
      expect(modelLooksLikeElizaCloudHosted("eliza-cloud-gpt-4o")).toBe(true);
      expect(modelLooksLikeElizaCloudHosted("cloud/eliza-1-fast")).toBe(true);
      expect(modelLooksLikeElizaCloudHosted("ELIZA_CLOUD_DEFAULT")).toBe(true);
    });

    it("returns false for models containing only 'eliza' or only 'cloud'", () => {
      expect(modelLooksLikeElizaCloudHosted("eliza-local-1")).toBe(false);
      expect(modelLooksLikeElizaCloudHosted("google-cloud-vertex")).toBe(false);
      expect(modelLooksLikeElizaCloudHosted("cloudflare-workers-ai")).toBe(
        false,
      );
    });

    it("returns false for external third-party model identifiers", () => {
      expect(modelLooksLikeElizaCloudHosted("gpt-4o")).toBe(false);
      expect(modelLooksLikeElizaCloudHosted("claude-3-5-sonnet")).toBe(false);
      expect(modelLooksLikeElizaCloudHosted("meta-llama-3-8b")).toBe(false);
    });

    it("returns false for empty or undefined inputs", () => {
      expect(modelLooksLikeElizaCloudHosted("")).toBe(false);
      expect(modelLooksLikeElizaCloudHosted(undefined)).toBe(false);
    });
  });
});
