import { describe, expect, test } from "bun:test";

describe("Promotion Pricing Constants", () => {
  test("PLATFORM_MARKUP is 1.2 (20%)", async () => {
    // Import the module directly to test constants
    const { PLATFORM_MARKUP } = await import("@/lib/promotion-pricing");
    expect(PLATFORM_MARKUP).toBe(1.2);
  });

  test("PROMO_IMAGE_COST includes 20% markup", async () => {
    const { PROMO_IMAGE_COST, PLATFORM_MARKUP } = await import("@/lib/promotion-pricing");
    const { BASE_IMAGE_GENERATION_COST } = await import("@/lib/pricing-constants");

    expect(PROMO_IMAGE_COST).toBe(BASE_IMAGE_GENERATION_COST * PLATFORM_MARKUP);
  });

  test("estimateAssetGenerationCost returns correct values", async () => {
    const { estimateAssetGenerationCost, PROMO_IMAGE_COST, AD_COPY_GENERATION_COST } = await import(
      "@/lib/promotion-pricing"
    );

    // Default: 1 image + 1 banner + copy
    const estimate = estimateAssetGenerationCost({});

    expect(estimate.images).toBe(2 * PROMO_IMAGE_COST);
    expect(estimate.copy).toBe(AD_COPY_GENERATION_COST);
    expect(estimate.total).toBe(2 * PROMO_IMAGE_COST + AD_COPY_GENERATION_COST);
    expect(estimate.display).toMatch(/^\$\d+\.\d{2}$/);
  });

  test("formatCost handles edge cases", async () => {
    const { formatCost } = await import("@/lib/promotion-pricing");

    expect(formatCost(0)).toBe("Free");
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0.05)).toBe("$0.05");
    expect(formatCost(1.234)).toBe("$1.23");
  });

  test("getPostCost returns correct values for each platform", async () => {
    const { getPostCost, DISCORD_POST_COST, TELEGRAM_POST_COST, TWITTER_POST_COST } = await import(
      "@/lib/promotion-pricing"
    );

    expect(getPostCost("discord")).toBe(DISCORD_POST_COST);
    expect(getPostCost("telegram")).toBe(TELEGRAM_POST_COST);
    expect(getPostCost("twitter")).toBe(TWITTER_POST_COST);
  });

  test("automation setup costs are free", async () => {
    const {
      DISCORD_AUTOMATION_SETUP_COST,
      TELEGRAM_AUTOMATION_SETUP_COST,
      TWITTER_AUTOMATION_SETUP_COST,
    } = await import("@/lib/promotion-pricing");

    expect(DISCORD_AUTOMATION_SETUP_COST).toBe(0);
    expect(TELEGRAM_AUTOMATION_SETUP_COST).toBe(0);
    expect(TWITTER_AUTOMATION_SETUP_COST).toBe(0);
  });
});
