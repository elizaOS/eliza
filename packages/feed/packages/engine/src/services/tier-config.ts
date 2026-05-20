/**
 * Tiered Group System Configuration
 *
 * Extends GROUP_CONFIG from @feed/shared with tier-specific settings.
 * NPC groups can have 3 tiers with different capacities and content levels:
 * - Tier 1 (Inner Circle): Exclusive, full alpha
 * - Tier 2 (Community): Medium engagement, partial alpha
 * - Tier 3 (Followers): Low barrier, public content
 *
 * Supports per-NPC tier customization via ActorTierOverrides.
 */

import { type AlphaLevel, GROUP_CONFIG, type TierLevel } from "@feed/shared";
import { ALPHA_GROUP_CONFIG } from "../config/alpha-group-config";
import { StaticDataRegistry } from "./static-data-registry";

// Re-export for convenience
export type { AlphaLevel, TierLevel } from "@feed/shared";

/** Valid tier levels */
const VALID_TIERS: readonly TierLevel[] = [1, 2, 3] as const;

/** Type guard to check if a value is a valid TierLevel */
export function isValidTier(value: unknown): value is TierLevel {
  return typeof value === "number" && VALID_TIERS.includes(value as TierLevel);
}

/** Assert and return a valid TierLevel, throws if invalid */
export function assertTierLevel(value: unknown): TierLevel {
  if (!isValidTier(value)) {
    throw new Error(`Invalid tier value: ${value}. Expected 1, 2, or 3.`);
  }
  return value;
}

export interface TierConfig {
  name: string;
  suffix: string;
  maxMembers: number;
  minEngagementScore: number;
  messageFrequency: number;
  alphaLevel: AlphaLevel;
  inviteProbability: number;
  promotionWaitDays: number;
  demotionInactiveDays: number;
}

export const TIER_CONFIG: Record<TierLevel, TierConfig> = {
  1: {
    name: "Inner Circle",
    suffix: "'s Inner Circle",
    maxMembers: GROUP_CONFIG.MAX_GROUP_SIZE, // 12
    minEngagementScore: 80,
    messageFrequency: 0.25,
    alphaLevel: "full",
    inviteProbability: 0.005,
    promotionWaitDays: 30,
    demotionInactiveDays: 30,
  },
  2: {
    name: "Community",
    suffix: "'s Community",
    maxMembers: 50,
    minEngagementScore: 50,
    messageFrequency: 0.15,
    alphaLevel: "partial",
    inviteProbability: 0.02,
    promotionWaitDays: 14,
    demotionInactiveDays: 60,
  },
  3: {
    name: "Followers",
    suffix: "'s Followers",
    maxMembers: 500,
    minEngagementScore: 20,
    messageFrequency: 0.05,
    alphaLevel: "public",
    inviteProbability: 0.1,
    promotionWaitDays: 0,
    demotionInactiveDays: 90,
  },
};

export const ALL_TIERS: TierLevel[] = [1, 2, 3];

/** Get configuration for a specific tier */
export const getTierConfig = (tier: TierLevel): TierConfig => TIER_CONFIG[tier];

/** Get the tier suffix for group naming */
export const getTierSuffix = (tier: TierLevel): string =>
  TIER_CONFIG[tier].suffix;

/** Get the full group name for an NPC at a tier */
export const getTierGroupName = (npcName: string, tier: TierLevel): string =>
  `${npcName}${TIER_CONFIG[tier].suffix}`;

/** Determine which tier a user qualifies for based on engagement score */
export function getTierForEngagementScore(score: number): TierLevel | null {
  if (score >= TIER_CONFIG[1].minEngagementScore) return 1;
  if (score >= TIER_CONFIG[2].minEngagementScore) return 2;
  if (score >= TIER_CONFIG[3].minEngagementScore) return 3;
  return null;
}

/** Check if user is eligible for promotion to next tier */
export function isEligibleForPromotion(
  currentTier: TierLevel,
  engagementScore: number,
  daysInCurrentTier: number,
): boolean {
  if (currentTier === 1) return false;
  const targetTier = (currentTier - 1) as TierLevel;
  const targetConfig = TIER_CONFIG[targetTier];
  const currentConfig = TIER_CONFIG[currentTier];
  return (
    engagementScore >= targetConfig.minEngagementScore &&
    daysInCurrentTier >= currentConfig.promotionWaitDays
  );
}

/** Check if user should be demoted due to inactivity */
export function shouldDemote(
  currentTier: TierLevel,
  daysSinceLastActivity: number,
): boolean {
  return daysSinceLastActivity >= TIER_CONFIG[currentTier].demotionInactiveDays;
}

/** Get the next lower tier (for demotion) */
export function getLowerTier(currentTier: TierLevel): TierLevel | null {
  if (currentTier === 3) return null;
  return (currentTier + 1) as TierLevel;
}

/** Get the next higher tier (for promotion) */
export function getHigherTier(currentTier: TierLevel): TierLevel | null {
  if (currentTier === 1) return null;
  return (currentTier - 1) as TierLevel;
}

/** Total capacity per NPC across all tiers */
export const getTotalNpcCapacity = (): number =>
  TIER_CONFIG[1].maxMembers +
  TIER_CONFIG[2].maxMembers +
  TIER_CONFIG[3].maxMembers;

/**
 * Tier-specific message guidance for NPC group chat content generation.
 * These prompts control the alpha/insider information level shared in each tier.
 */
export const TIER_MESSAGE_GUIDANCE: Record<TierLevel, string> = {
  1: `TIER 1 INNER CIRCLE - share FULL ALPHA:
- "Just loaded up $50k on [ticker] before the announcement"
- "Between us, [company] Q3 is $2.3B but they'll announce $2.1B"
- "Get out of [ticker] before 3pm - trust me"
- Specific positions, amounts, dates, sources
- Contradict your public statements with real strategy`,

  2: `TIER 2 COMMUNITY - share PARTIAL ALPHA (hints, not specifics):
- "Feeling bearish on tech this week"
- "Smart money is moving out of [sector]"
- Directional hints without exact amounts
- Industry insights and sentiment
- NO exact dollar amounts or dates`,

  3: `TIER 3 FOLLOWERS - PUBLIC-FACING content only:
- "Did you see what happened at [event]? Wild!"
- "Markets are crazy right now"
- Personality, banter, engagement
- NO insider info, NO trading hints`,
};

/** Get message guidance for a tier, defaults to Tier 1 for null/legacy groups */
export function getTierMessageGuidance(tier: TierLevel | null): string {
  if (tier === null || !isValidTier(tier)) {
    return TIER_MESSAGE_GUIDANCE[1]; // Legacy groups get full alpha
  }
  return TIER_MESSAGE_GUIDANCE[tier];
}

// =============================================================================
// PER-NPC TIER CUSTOMIZATION
// =============================================================================

/**
 * Get effective tier configuration for an NPC, applying any tierOverrides.
 *
 * NPC-specific overrides allow:
 * - minEngagementScoreMultiplier: Scale the threshold (1.5 = 50% harder)
 * - inviteProbabilityMultiplier: Scale invite probability (0.5 = half as likely)
 *
 * @param tier - The tier level to get config for
 * @param npcId - Optional NPC ID to apply tier overrides
 * @returns TierConfig with NPC-specific adjustments applied
 */
export function getEffectiveTierConfig(
  tier: TierLevel,
  npcId?: string,
): TierConfig {
  const baseConfig = TIER_CONFIG[tier];

  // If per-NPC customization is disabled or no NPC specified, use base config
  if (!ALPHA_GROUP_CONFIG.perNpcCustomizationEnabled || !npcId) {
    return baseConfig;
  }

  // Get actor data to check for tier overrides
  const actor = StaticDataRegistry.getActor(npcId);
  const overrides = actor?.tierOverrides;

  // No overrides for this actor, use base config
  if (!overrides) {
    return baseConfig;
  }

  // Apply multipliers to create effective config
  return {
    ...baseConfig,
    minEngagementScore: Math.round(
      baseConfig.minEngagementScore *
        (overrides.minEngagementScoreMultiplier ?? 1),
    ),
    inviteProbability:
      baseConfig.inviteProbability *
      (overrides.inviteProbabilityMultiplier ?? 1),
  };
}

/**
 * Determine which tier a user qualifies for based on engagement score,
 * considering NPC-specific thresholds.
 *
 * @param score - User's engagement score (0-100)
 * @param npcId - Optional NPC ID for tier-specific thresholds
 * @returns Highest tier the user qualifies for, or null if none
 */
export function getTierForEngagementScoreWithNpc(
  score: number,
  npcId?: string,
): TierLevel | null {
  for (const tier of ALL_TIERS) {
    const config = getEffectiveTierConfig(tier, npcId);
    if (score >= config.minEngagementScore) {
      return tier;
    }
  }
  return null;
}

/**
 * Get the focus weights for an NPC's engagement calculation.
 *
 * Priority order:
 * 1. Explicit focusWeights in tierOverrides
 * 2. Domain-based defaults
 * 3. Global default (50/50)
 *
 * @param npcId - NPC ID to get focus weights for
 * @returns Focus weights for social and trading activity
 */
export function getNpcFocusWeights(npcId: string): {
  social: number;
  trading: number;
} {
  const actor = StaticDataRegistry.getActor(npcId);

  // Check for explicit focus weights in tier overrides
  if (actor?.tierOverrides?.focusWeights) {
    return actor.tierOverrides.focusWeights;
  }

  // Use domain-based defaults
  if (actor?.domain && actor.domain.length > 0) {
    // Import would cause circular dependency, so we inline the logic
    const tradingDomains = ["crypto", "trading", "finance", "defi", "markets"];
    const socialDomains = ["media", "politics", "entertainment", "culture"];
    const techDomains = ["tech", "ai", "venture-capital", "startups"];

    const hasTradingFocus = actor.domain.some((d) =>
      tradingDomains.includes(d.toLowerCase()),
    );
    const hasSocialFocus = actor.domain.some((d) =>
      socialDomains.includes(d.toLowerCase()),
    );
    const hasTechFocus = actor.domain.some((d) =>
      techDomains.includes(d.toLowerCase()),
    );

    if (hasTradingFocus && !hasSocialFocus) {
      return { social: 0.4, trading: 0.6 };
    }
    if (hasSocialFocus && !hasTradingFocus) {
      return { social: 0.8, trading: 0.2 };
    }
    if (hasTechFocus) {
      return { social: 0.6, trading: 0.4 };
    }
  }

  // Default: balanced
  return {
    social: ALPHA_GROUP_CONFIG.defaultSocialWeight,
    trading: ALPHA_GROUP_CONFIG.defaultTradingWeight,
  };
}

/**
 * Check if promotion requirements are met with NPC-specific thresholds.
 *
 * @param currentTier - User's current tier
 * @param engagementScore - User's current engagement score
 * @param daysInCurrentTier - Days since joining current tier
 * @param npcId - Optional NPC ID for tier-specific thresholds
 * @returns True if eligible for promotion
 */
export function isEligibleForPromotionWithNpc(
  currentTier: TierLevel,
  engagementScore: number,
  daysInCurrentTier: number,
  npcId?: string,
): boolean {
  if (currentTier === 1) return false;

  const targetTier = (currentTier - 1) as TierLevel;
  const targetConfig = getEffectiveTierConfig(targetTier, npcId);
  const currentConfig = getEffectiveTierConfig(currentTier, npcId);

  return (
    engagementScore >= targetConfig.minEngagementScore &&
    daysInCurrentTier >= currentConfig.promotionWaitDays
  );
}
