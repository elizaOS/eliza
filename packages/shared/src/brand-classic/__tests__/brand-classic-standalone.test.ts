/**
 * Unit tests for Eliza Classic brand tokens and path resolution.
 * Validates canonical color definitions, logo paths, and asset path normalization.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGO_FILES } from "../../brand/index.ts";
import {
  BRAND_ASSET_BASE_PATH,
  brandAssetPath,
  brandAssets,
  brandCloudBackgrounds,
  brandColors,
  brandConcepts,
  brandFavicons,
  brandLogos,
} from "../index.ts";

describe("brand-classic", () => {
  describe("brandAssetPath", () => {
    it("joins relative asset paths with default base path", () => {
      expect(brandAssetPath("logos/elizaOS_text_black.svg")).toBe(
        "/brand/logos/elizaOS_text_black.svg",
      );
    });

    it("strips redundant leading and trailing slashes", () => {
      expect(brandAssetPath("/logos/logo_blue_nobg.svg", "/brand/")).toBe(
        "/brand/logos/logo_blue_nobg.svg",
      );
    });

    it("supports custom base paths", () => {
      expect(
        brandAssetPath("favicons/favicon.ico", "https://cdn.eliza.app/assets/"),
      ).toBe("https://cdn.eliza.app/assets/favicons/favicon.ico");
    });
  });

  describe("tokens and catalogs", () => {
    it("exports canonical brand colors", () => {
      expect(brandColors.orange).toBe("#FF5800");
      expect(brandColors.blue).toBe("#0B35F1");
      expect(brandColors.black).toBe("#000000");
      expect(brandColors.white).toBe("#FFFFFF");
    });

    it("exports frozen brand logos and favicons records", () => {
      expect(brandLogos.elizaOsTextBlack).toBe(
        "/brand/logos/elizaOS_text_black.svg",
      );
      expect(brandLogos.logoOrangeNoBg).toBe(
        "/brand/logos/logo_orange_nobg.svg",
      );
      expect(brandFavicons.ico).toBe("/brand/favicons/favicon.ico");
      expect(brandFavicons.svg).toBe("/brand/favicons/favicon.svg");
    });

    it("resolves every compatibility logo through the canonical asset catalog", () => {
      const canonicalNames = new Set(Object.values(LOGO_FILES));
      const compatibilityNames = Object.values(brandLogos).map((value) =>
        basename(value),
      );
      expect(new Set(compatibilityNames)).toEqual(canonicalNames);
      for (const filename of compatibilityNames) {
        expect(
          existsSync(
            new URL(`../../../assets/logos/${filename}`, import.meta.url),
          ),
          `missing canonical brand asset ${filename}`,
        ).toBe(true);
      }
    });

    it("exports brand concepts and cloud backgrounds", () => {
      expect(brandConcepts.billboard).toBe(
        "/brand/concepts/billboard_concept_1200.jpg",
      );
      expect(brandCloudBackgrounds.poster).toBe(
        "/brand/background/clouds_background.jpg",
      );
      expect(brandCloudBackgrounds.optimized.clouds1x720pMp4).toBe(
        "/brand/background/optimized/clouds_1x_720p.mp4",
      );
    });

    it("aggregates all tokens into brandAssets bundle", () => {
      expect(brandAssets.basePath).toBe(BRAND_ASSET_BASE_PATH);
      expect(brandAssets.colors).toBe(brandColors);
      expect(brandAssets.logos).toBe(brandLogos);
      expect(brandAssets.favicons).toBe(brandFavicons);
      expect(brandAssets.concepts).toBe(brandConcepts);
      expect(brandAssets.cloudBackgrounds).toBe(brandCloudBackgrounds);
    });
  });
});
