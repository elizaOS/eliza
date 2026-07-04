// Exercises promotion pricing behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  AD_COPY_GENERATION_COST,
  DISCORD_POST_COST,
  estimateAssetGenerationCost,
  formatCost,
  getPostCost,
  getPreviewCost,
  PREVIEW_GENERATION_COST,
  PROMO_IMAGE_COST,
  TWITTER_POST_COST,
} from "./promotion-pricing";

/**
 * Promotion pricing math drives real credit deductions, so the asset-cost
 * estimate (images + optional banner + copy) and the display formatter must be
 * exact — a wrong multiplier over- or under-charges every promo.
 */

describe("formatCost", () => {
  test("Free / sub-cent / dollar formatting", () => {
    expect(formatCost(0)).toBe("Free");
    expect(formatCost(0.005)).toBe("<$0.01");
    expect(formatCost(0.5)).toBe("$0.50");
    expect(formatCost(12.3)).toBe("$12.30");
  });
});

describe("getPostCost / getPreviewCost", () => {
  test("returns the per-platform + per-preview cost", () => {
    expect(getPostCost("discord")).toBe(DISCORD_POST_COST);
    expect(getPostCost("twitter")).toBe(TWITTER_POST_COST);
    expect(getPostCost("discord")).not.toBe(getPostCost("twitter"));
    expect(getPreviewCost(0)).toBe(0);
    expect(getPreviewCost(3)).toBeCloseTo(3 * PREVIEW_GENERATION_COST);
  });
});

describe("estimateAssetGenerationCost", () => {
  test("defaults to 1 image + banner + copy", () => {
    const out = estimateAssetGenerationCost({});
    expect(out.images).toBeCloseTo(2 * PROMO_IMAGE_COST); // image + banner
    expect(out.copy).toBeCloseTo(AD_COPY_GENERATION_COST);
    expect(out.total).toBeCloseTo(2 * PROMO_IMAGE_COST + AD_COPY_GENERATION_COST);
    expect(out.display).toBe(formatCost(out.total));
  });

  test("excludes banner and copy when disabled", () => {
    const out = estimateAssetGenerationCost({
      imageCount: 1,
      includeBanner: false,
      includeCopy: false,
    });
    expect(out.images).toBeCloseTo(PROMO_IMAGE_COST);
    expect(out.copy).toBe(0);
    expect(out.total).toBeCloseTo(PROMO_IMAGE_COST);
  });
});
