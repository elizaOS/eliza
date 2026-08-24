/**
 * Unit tests for browser Steward API URL resolution.
 * Validates direct API host mapping, environment overrides, and origin fallback behaviors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stewardConfig from "../steward-config.ts";
import {
  ELIZA_CLOUD_DIRECT_API_BY_HOST,
  resolveBrowserStewardApiUrl,
} from "../steward-url.ts";

describe("steward-url", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ELIZA_CLOUD_DIRECT_API_BY_HOST", () => {
    it("maps marketing and app hosts to their respective direct origins", () => {
      expect(
        Object.keys(ELIZA_CLOUD_DIRECT_API_BY_HOST).length,
      ).toBeGreaterThan(0);
      for (const [host, origin] of Object.entries(
        ELIZA_CLOUD_DIRECT_API_BY_HOST,
      )) {
        expect(host).toBeTruthy();
        expect(origin).toMatch(/^https?:\/\//);
      }
    });
  });

  describe("resolveBrowserStewardApiUrl", () => {
    it("returns configured override without trailing slashes when present", () => {
      vi.spyOn(
        stewardConfig,
        "configuredStewardApiUrlOverride",
      ).mockReturnValue("https://custom-steward.internal/api///");
      const resolved = resolveBrowserStewardApiUrl();
      expect(resolved).toBe("https://custom-steward.internal/api");
    });

    it("resolves explicit origin parameter when override is not set", () => {
      vi.spyOn(
        stewardConfig,
        "configuredStewardApiUrlOverride",
      ).mockReturnValue(undefined);
      const resolved = resolveBrowserStewardApiUrl("https://example.com/");
      expect(resolved).toBe("https://example.com/steward");
    });

    it("falls back to default /steward prefix when no window or origin is available", () => {
      vi.spyOn(
        stewardConfig,
        "configuredStewardApiUrlOverride",
      ).mockReturnValue(undefined);
      const resolved = resolveBrowserStewardApiUrl(undefined);
      expect(resolved).toBe("/steward");
    });
  });
});
