import { describe, expect, it } from "vitest";
import {
  AUTONOMY_DEFAULTS,
  CONTENT_LIMITS,
  DEFAULT_SUBMOLT,
  MOLTBOOK_SERVICE_NAME,
  URLS,
} from "../src/constants";

describe("constants", () => {
  describe("MOLTBOOK_SERVICE_NAME", () => {
    it("has correct service name", () => {
      expect(MOLTBOOK_SERVICE_NAME).toBe("moltbook");
    });
  });

  describe("URLS", () => {
    it("has valid moltbook URL", () => {
      expect(URLS.moltbook).toMatch(/^https:\/\//);
      expect(URLS.moltbook).toContain("moltbook.com");
    });

    it("has valid openrouter URL", () => {
      expect(URLS.openrouter).toMatch(/^https:\/\//);
      expect(URLS.openrouter).toContain("openrouter.ai");
    });
  });

  describe("AUTONOMY_DEFAULTS", () => {
    it("has reasonable interval range", () => {
      expect(AUTONOMY_DEFAULTS.minIntervalMs).toBeGreaterThan(0);
      expect(AUTONOMY_DEFAULTS.maxIntervalMs).toBeGreaterThan(AUTONOMY_DEFAULTS.minIntervalMs);
    });

    it("has positive max tool calls", () => {
      expect(AUTONOMY_DEFAULTS.maxToolCalls).toBeGreaterThan(0);
    });

    it("has non-empty default model", () => {
      expect(AUTONOMY_DEFAULTS.defaultModel).toBeTruthy();
      expect(AUTONOMY_DEFAULTS.defaultModel.length).toBeGreaterThan(0);
    });
  });

  describe("CONTENT_LIMITS", () => {
    it("has positive browse limit", () => {
      expect(CONTENT_LIMITS.defaultBrowseLimit).toBeGreaterThan(0);
    });

    it("has reasonable content limits", () => {
      expect(CONTENT_LIMITS.maxContentLength).toBeGreaterThan(0);
      expect(CONTENT_LIMITS.maxTitleLength).toBeGreaterThan(0);
      expect(CONTENT_LIMITS.maxCommentLength).toBeGreaterThan(0);
    });

    it("title limit is less than content limit", () => {
      expect(CONTENT_LIMITS.maxTitleLength).toBeLessThan(CONTENT_LIMITS.maxContentLength);
    });
  });

  describe("DEFAULT_SUBMOLT", () => {
    it("has a default submolt", () => {
      expect(DEFAULT_SUBMOLT).toBeTruthy();
      expect(DEFAULT_SUBMOLT.length).toBeGreaterThan(0);
    });
  });
});
