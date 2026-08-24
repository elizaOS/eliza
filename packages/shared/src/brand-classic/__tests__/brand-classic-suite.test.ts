/**
 * Unit tests for Eliza Classic brand tokens and asset path resolution.
 * Validates path formatting, color palette values, and logo/favicon registries.
 */
import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_BASE_PATH,
  brandAssetPath,
  brandColors,
  brandFavicons,
  brandLogos,
} from "../index.ts";

describe("brand-classic", () => {
  describe("brandAssetPath", () => {
    it("resolves asset paths with default /brand base path", () => {
      expect(BRAND_ASSET_BASE_PATH).toBe("/brand");
      expect(brandAssetPath("logos/logo.svg")).toBe("/brand/logos/logo.svg");
      expect(brandAssetPath("/logos/logo.svg")).toBe("/brand/logos/logo.svg");
    });
  });

  describe("brandColors", () => {
    it("defines expected canonical brand hex values", () => {
      expect(brandColors.orange).toBe("#FF5800");
      expect(brandColors.blue).toBe("#0B35F1");
      expect(brandColors.black).toBe("#000000");
      expect(brandColors.white).toBe("#FFFFFF");
    });
  });

  describe("brandLogos and brandFavicons", () => {
    it("ensures all logo paths begin with /brand/", () => {
      for (const path of Object.values(brandLogos)) {
        expect(path).toMatch(/^\/brand\//);
      }
    });

    it("ensures all favicon paths begin with /brand/", () => {
      for (const path of Object.values(brandFavicons)) {
        expect(path).toMatch(/^\/brand\//);
      }
    });
  });
});
