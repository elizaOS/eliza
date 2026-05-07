/**
 * Promotion Pricing Constants
 *
 * Centralized pricing for all promotion-related AI operations.
 * All costs are in USD and represent actual credit deductions.
 *
 * PRICING MODEL:
 * - Base costs are what AI providers charge us
 * - User-facing costs = Base × PLATFORM_MARKUP (20% markup)
 * - Some costs are hidden from users to avoid discouraging engagement
 *
 * AI Model Costs (base):
 * - gpt-5-mini: $0.00015/1k input, $0.0006/1k output
 * - Claude Sonnet: $0.003/1k input, $0.015/1k output
 * - Gemini 2.5 Flash Image: $0.01/image (from pricing-constants)
 */

import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/billing";
import { IMAGE_GENERATION_COST } from "@/lib/pricing-constants";

/** Platform markup: 20% on all AI costs */
export const PLATFORM_MARKUP = PLATFORM_MARKUP_MULTIPLIER;

// Base costs (what AI providers charge us)
const BASE_IMAGE_COST = IMAGE_GENERATION_COST;
const BASE_COPY_COST = 0.01;
const BASE_DISCORD_POST_COST = 0.0005;
const BASE_TELEGRAM_POST_COST = 0.0005;
const BASE_TWITTER_POST_COST = 0.005;
const BASE_PREVIEW_COST = 0.002;

// User-facing costs (with 20% markup)
export const PROMO_IMAGE_COST = BASE_IMAGE_COST * PLATFORM_MARKUP;
export const AD_COPY_GENERATION_COST = BASE_COPY_COST * PLATFORM_MARKUP;
export const DISCORD_POST_COST = BASE_DISCORD_POST_COST * PLATFORM_MARKUP;
export const TELEGRAM_POST_COST = BASE_TELEGRAM_POST_COST * PLATFORM_MARKUP;
export const TWITTER_POST_COST = BASE_TWITTER_POST_COST * PLATFORM_MARKUP;
export const PREVIEW_GENERATION_COST = BASE_PREVIEW_COST * PLATFORM_MARKUP;

// Automation setup is free (no AI involved)
export const DISCORD_AUTOMATION_SETUP_COST = 0;
export const TELEGRAM_AUTOMATION_SETUP_COST = 0;
export const TWITTER_AUTOMATION_SETUP_COST = 0;

/** Estimate cost for generating promotional assets (shown to users) */
export function estimateAssetGenerationCost(config: {
  imageCount?: number;
  includeCopy?: boolean;
  includeBanner?: boolean;
}): {
  images: number;
  copy: number;
  total: number;
  display: string;
} {
  const { imageCount = 1, includeCopy = true, includeBanner = true } = config;

  const totalImages = imageCount + (includeBanner ? 1 : 0);
  const imageCost = totalImages * PROMO_IMAGE_COST;
  const copyCost = includeCopy ? AD_COPY_GENERATION_COST : 0;
  const total = imageCost + copyCost;

  return {
    images: imageCost,
    copy: copyCost,
    total,
    display: formatCost(total),
  };
}

export function formatCost(cost: number): string {
  if (cost === 0) return "Free";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** Get post cost by platform (internal billing, not shown to users) */
export function getPostCost(platform: "discord" | "telegram" | "twitter"): number {
  switch (platform) {
    case "discord":
      return DISCORD_POST_COST;
    case "telegram":
      return TELEGRAM_POST_COST;
    case "twitter":
      return TWITTER_POST_COST;
  }
}

/** Get preview generation cost (internal billing) */
export function getPreviewCost(count: number): number {
  return count * PREVIEW_GENERATION_COST;
}
