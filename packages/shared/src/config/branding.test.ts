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
  DEFAULT_BRANDING,
} from "./branding.js";

describe("branding", () => {
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
