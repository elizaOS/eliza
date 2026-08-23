/**
 * Unit coverage for branding tokens and interpolation helpers in branding.ts.
 *
 * Verifies default branding constants, app display name fallback, and
 * appNameInterpolationVars trimming and default value injection.
 */

import { describe, expect, it } from "vitest";
import {
  appNameInterpolationVars,
  type BrandingConfig,
  DEFAULT_APP_DISPLAY_NAME,
  DEFAULT_BRANDING,
} from "./branding.js";

describe("branding", () => {
  it("exports expected default branding configuration", () => {
    expect(DEFAULT_APP_DISPLAY_NAME).toBe("Eliza");
    expect(DEFAULT_BRANDING.appName).toBe("Eliza");
    expect(DEFAULT_BRANDING.orgName).toBe("elizaos");
    expect(DEFAULT_BRANDING.repoName).toBe("eliza");
    expect(DEFAULT_BRANDING.hashtag).toBe("#ElizaAgent");
    expect(DEFAULT_BRANDING.fileExtension).toBe(".eliza-agent");
    expect(DEFAULT_BRANDING.packageScope).toBe("elizaos");
    expect(DEFAULT_BRANDING.docsUrl).toBeDefined();
    expect(DEFAULT_BRANDING.appUrl).toBeDefined();
    expect(DEFAULT_BRANDING.bugReportUrl).toContain("github.com/elizaos/eliza");
  });

  describe("appNameInterpolationVars", () => {
    it("returns trimmed app name when provided", () => {
      const config: BrandingConfig = {
        ...DEFAULT_BRANDING,
        appName: "  CustomAgent  ",
      };
      const vars = appNameInterpolationVars(config);
      expect(vars).toEqual({ appName: "CustomAgent" });
    });

    it("falls back to DEFAULT_APP_DISPLAY_NAME when appName is empty or only whitespace", () => {
      const emptyConfig: BrandingConfig = {
        ...DEFAULT_BRANDING,
        appName: "",
      };
      expect(appNameInterpolationVars(emptyConfig)).toEqual({
        appName: "Eliza",
      });

      const whitespaceConfig: BrandingConfig = {
        ...DEFAULT_BRANDING,
        appName: "   \t\n  ",
      };
      expect(appNameInterpolationVars(whitespaceConfig)).toEqual({
        appName: "Eliza",
      });
    });
  });
});
