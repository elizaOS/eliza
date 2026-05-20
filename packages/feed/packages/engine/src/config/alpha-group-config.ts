/**
 * Alpha Group Configuration
 *
 * Centralized configuration for alpha group invite thresholds and mechanics.
 * All values can be overridden via environment variables for easy tuning
 * without code changes.
 *
 * @module engine/config/alpha-group-config
 *
 * @description
 * This configuration controls how users are invited to NPC alpha groups:
 * - Engagement thresholds (social and trading activity requirements)
 * - Invite probabilities (per-tier and global multipliers)
 * - Fast-track for high-value traders
 * - Invite decay for users who repeatedly decline
 * - Cooldowns between invites
 * - Per-NPC customization flags
 *
 * **Environment Variable Naming Convention:**
 * All env vars are prefixed with `ALPHA_` and use SCREAMING_SNAKE_CASE.
 *
 * @example
 * ```bash
 * # Increase invite rates
 * ALPHA_INVITE_PROBABILITY_MULTIPLIER=1.5
 * ALPHA_MAX_INVITES_PER_TICK=20
 *
 * # Lower engagement requirements
 * ALPHA_MIN_REPLIES=1
 * ALPHA_MIN_LIKES=2
 * ALPHA_MIN_TOTAL_INTERACTIONS=5
 *
 * # Enable trading activity in engagement
 * ALPHA_INCLUDE_TRADING=true
 * ALPHA_TRADE_WEIGHT=2.5
 * ```
 */

import { logger } from '@feed/shared';
import { clamp01 } from '../utils/math-utils';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Parse an environment variable as a number with a default fallback.
 * Returns the default if the env var is not set or not a valid number.
 */
function envNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse an environment variable as a boolean.
 * Returns true for 'true', '1', 'yes' (case-insensitive).
 */
function envBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Parse an environment variable as a probability (0.0-1.0) with bounds checking.
 * Clamps the value to valid probability range to prevent configuration errors.
 */
function envProbability(key: string, defaultValue: number): number {
  const value = envNumber(key, defaultValue);
  if (value < 0 || value > 1) {
    logger.warn(
      `${key}=${value} is outside valid probability range (0-1), clamping to bounds`,
      { key, value },
      'alpha-group-config'
    );
  }
  return clamp01(value);
}

/**
 * Parse an environment variable as a positive integer.
 * Returns the default if the value is <= 0.
 */
function envPositiveInt(key: string, defaultValue: number): number {
  const value = envNumber(key, defaultValue);
  if (value <= 0 || !Number.isInteger(value)) {
    logger.warn(
      `${key}=${value} must be a positive integer, using default ${defaultValue}`,
      { key, value, defaultValue },
      'alpha-group-config'
    );
    return defaultValue;
  }
  return value;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Alpha Group Configuration
 *
 * All thresholds and probabilities for the alpha group invite system.
 * Each field is documented with its purpose, default value, and env var.
 */
export const ALPHA_GROUP_CONFIG = {
  // ===========================================================================
  // INVITE PROBABILITY
  // ===========================================================================

  /**
   * Global multiplier applied to all tier-specific invite probabilities.
   * Set > 1 to increase all invite rates, < 1 to decrease.
   *
   * @env ALPHA_INVITE_PROBABILITY_MULTIPLIER
   * @default 1.0
   */
  inviteProbabilityMultiplier: envNumber(
    'ALPHA_INVITE_PROBABILITY_MULTIPLIER',
    1.0
  ),

  /**
   * Maximum invites to send per game tick (across all NPCs).
   * Prevents flooding users with too many invites at once.
   *
   * @env ALPHA_MAX_INVITES_PER_TICK
   * @default 15
   */
  maxInvitesPerTick: envPositiveInt('ALPHA_MAX_INVITES_PER_TICK', 15),

  /**
   * Top N users to consider per NPC per tick.
   * Higher values consider more users but increase processing time.
   *
   * @env ALPHA_TOP_USERS_TO_CONSIDER
   * @default 30
   */
  topUsersToConsider: envPositiveInt('ALPHA_TOP_USERS_TO_CONSIDER', 30),

  // ===========================================================================
  // ENGAGEMENT THRESHOLDS
  // ===========================================================================

  /**
   * Minimum replies to NPC posts for eligibility.
   * Users need at least this many quality replies to be considered.
   *
   * @env ALPHA_MIN_REPLIES
   * @default 1
   */
  minReplies: envNumber('ALPHA_MIN_REPLIES', 1),

  /**
   * Minimum likes on NPC posts for eligibility.
   *
   * @env ALPHA_MIN_LIKES
   * @default 2
   */
  minLikes: envNumber('ALPHA_MIN_LIKES', 2),

  /**
   * Minimum total interactions (replies + likes + shares) for eligibility.
   *
   * @env ALPHA_MIN_TOTAL_INTERACTIONS
   * @default 5
   */
  minTotalInteractions: envNumber('ALPHA_MIN_TOTAL_INTERACTIONS', 5),

  /**
   * Minimum quality score for replies (0-1).
   * Replies below this score don't count toward eligibility.
   *
   * @env ALPHA_MIN_QUALITY_SCORE
   * @default 0.5
   */
  minQualityScore: envProbability('ALPHA_MIN_QUALITY_SCORE', 0.5),

  /**
   * Maximum interactions per day before spam detection triggers.
   * Users exceeding this are flagged and excluded from invites.
   *
   * @env ALPHA_MAX_INTERACTIONS_PER_DAY
   * @default 50
   */
  maxInteractionsPerDay: envPositiveInt('ALPHA_MAX_INTERACTIONS_PER_DAY', 50),

  // ===========================================================================
  // TRADING ACTIVITY
  // ===========================================================================

  /**
   * Weight for trades in engagement score calculation.
   * Each trade contributes this many points to the raw score.
   *
   * @env ALPHA_TRADE_WEIGHT
   * @default 2.5
   */
  tradeWeight: envNumber('ALPHA_TRADE_WEIGHT', 2.5),

  /**
   * Bonus multiplier for profitable trades.
   * Profitable trades get an additional bonus of this value.
   *
   * @env ALPHA_PROFITABLE_TRADE_BONUS
   * @default 1.5
   */
  profitableTradeBonus: envNumber('ALPHA_PROFITABLE_TRADE_BONUS', 1.5),

  /**
   * Enable trading activity in engagement calculation.
   * When false, only social interactions count toward the score.
   *
   * @env ALPHA_INCLUDE_TRADING
   * @default true
   */
  includeTradingActivity: envBoolean('ALPHA_INCLUDE_TRADING', true),

  // ===========================================================================
  // FAST TRACK
  // ===========================================================================

  /**
   * Enable fast-track for high-value traders.
   * Traders meeting the criteria can skip Tier 3 and join Tier 2 directly.
   *
   * @env ALPHA_FAST_TRACK_ENABLED
   * @default true
   */
  fastTrackEnabled: envBoolean('ALPHA_FAST_TRACK_ENABLED', true),

  /**
   * Minimum profitable trades for fast-track eligibility.
   *
   * @env ALPHA_FAST_TRACK_MIN_TRADES
   * @default 10
   */
  fastTrackMinTrades: envPositiveInt('ALPHA_FAST_TRACK_MIN_TRADES', 10),

  /**
   * Minimum cumulative P&L (in points) for fast-track eligibility.
   *
   * @env ALPHA_FAST_TRACK_MIN_PNL
   * @default 5000
   */
  fastTrackMinPnL: envNumber('ALPHA_FAST_TRACK_MIN_PNL', 5000),

  /**
   * Minimum win rate (0-1) for fast-track eligibility.
   *
   * @env ALPHA_FAST_TRACK_MIN_WIN_RATE
   * @default 0.55
   */
  fastTrackMinWinRate: envProbability('ALPHA_FAST_TRACK_MIN_WIN_RATE', 0.55),

  /**
   * Tier to fast-track users to (2 = Community tier).
   * Never fast-track directly to Tier 1 (Inner Circle).
   *
   * @env ALPHA_FAST_TRACK_TARGET_TIER
   * @default 2
   */
  fastTrackTargetTier: envNumber('ALPHA_FAST_TRACK_TARGET_TIER', 2) as 2 | 3,

  // ===========================================================================
  // INVITE DECAY
  // ===========================================================================

  /**
   * Enable invite decay for users who decline.
   * Users who repeatedly decline get increasing cooldowns.
   *
   * @env ALPHA_INVITE_DECAY_ENABLED
   * @default true
   */
  inviteDecayEnabled: envBoolean('ALPHA_INVITE_DECAY_ENABLED', true),

  /**
   * Base cooldown hours after first decline.
   * Subsequent declines double the cooldown (exponential backoff).
   *
   * @env ALPHA_INVITE_DECAY_BASE_HOURS
   * @default 24
   */
  inviteDecayBaseHours: envPositiveInt('ALPHA_INVITE_DECAY_BASE_HOURS', 24),

  /**
   * Maximum cooldown hours (cap for exponential backoff).
   *
   * @env ALPHA_INVITE_DECAY_MAX_HOURS
   * @default 168 (7 days)
   */
  inviteDecayMaxHours: envPositiveInt('ALPHA_INVITE_DECAY_MAX_HOURS', 168),

  /**
   * Maximum declines before user is temporarily excluded.
   *
   * @env ALPHA_INVITE_DECAY_MAX_DECLINES
   * @default 5
   */
  inviteDecayMaxDeclines: envPositiveInt('ALPHA_INVITE_DECAY_MAX_DECLINES', 5),

  /**
   * Days of inactivity after which decline count resets.
   *
   * @env ALPHA_INVITE_DECAY_RESET_DAYS
   * @default 30
   */
  inviteDecayResetDays: envPositiveInt('ALPHA_INVITE_DECAY_RESET_DAYS', 30),

  // ===========================================================================
  // COOLDOWNS
  // ===========================================================================

  /**
   * Hours after joining before eligible for next invite.
   *
   * @env ALPHA_INVITE_COOLDOWN_HOURS
   * @default 2
   */
  inviteCooldownHours: envPositiveInt('ALPHA_INVITE_COOLDOWN_HOURS', 2),

  // ===========================================================================
  // THROTTLING & RATE LIMITS
  // ===========================================================================

  /**
   * Maximum invites a single user can receive per week (across all NPCs).
   * Prevents spamming users with too many invites.
   *
   * @env ALPHA_MAX_INVITES_PER_USER_PER_WEEK
   * @default 2
   */
  maxInvitesPerUserPerWeek: envPositiveInt(
    'ALPHA_MAX_INVITES_PER_USER_PER_WEEK',
    2
  ),

  /**
   * Require recent activity for invite eligibility.
   * Users who haven't been active recently are excluded from invites.
   *
   * @env ALPHA_REQUIRE_RECENT_ACTIVITY
   * @default true
   */
  requireRecentActivity: envBoolean('ALPHA_REQUIRE_RECENT_ACTIVITY', true),

  /**
   * Number of days to look back for "recent" activity.
   * Users with no activity in this window are considered inactive.
   *
   * @env ALPHA_RECENT_ACTIVITY_DAYS
   * @default 30
   */
  recentActivityDays: envPositiveInt('ALPHA_RECENT_ACTIVITY_DAYS', 30),

  /**
   * Reduced invite probability for tiered system (0.001 = 0.1% per eligible user per tick).
   * Lower than legacy system to reduce invite spam. Set to 0.005 for legacy behavior.
   *
   * @env ALPHA_TIERED_INVITE_PROBABILITY
   * @default 0.001
   */
  tieredInviteProbability: envProbability(
    'ALPHA_TIERED_INVITE_PROBABILITY',
    0.001
  ),

  /**
   * Reduced user invite chance for NPC group dynamics (0.02 = 2% per group per tick).
   * Lower than legacy 8% to reduce invite spam. Set to 0.08 for legacy behavior.
   *
   * @env ALPHA_INVITE_USER_CHANCE
   * @default 0.02
   */
  inviteUserChance: envProbability('ALPHA_INVITE_USER_CHANCE', 0.02),

  // ===========================================================================
  // FEATURE FLAGS
  // ===========================================================================

  /**
   * Enable per-NPC tier customization.
   * When enabled, NPCs can have different thresholds via tierOverrides.
   *
   * @env ALPHA_PER_NPC_CUSTOMIZATION_ENABLED
   * @default true
   */
  perNpcCustomizationEnabled: envBoolean(
    'ALPHA_PER_NPC_CUSTOMIZATION_ENABLED',
    true
  ),

  /**
   * Enable grandfathering for existing members.
   * When enabled, members joined before threshold changes are protected.
   *
   * @env ALPHA_GRANDFATHERING_ENABLED
   * @default true
   */
  grandfatheringEnabled: envBoolean('ALPHA_GRANDFATHERING_ENABLED', true),

  // ===========================================================================
  // SCORING WEIGHTS (for engagement calculation)
  // ===========================================================================

  /**
   * Weight for reply interactions in engagement score.
   *
   * @env ALPHA_REPLY_WEIGHT
   * @default 3.0
   */
  replyWeight: envNumber('ALPHA_REPLY_WEIGHT', 3.0),

  /**
   * Weight for like interactions in engagement score.
   *
   * @env ALPHA_LIKE_WEIGHT
   * @default 1.0
   */
  likeWeight: envNumber('ALPHA_LIKE_WEIGHT', 1.0),

  /**
   * Weight for share interactions in engagement score.
   *
   * @env ALPHA_SHARE_WEIGHT
   * @default 2.0
   */
  shareWeight: envNumber('ALPHA_SHARE_WEIGHT', 2.0),

  /**
   * Maximum expected social score (for normalization).
   * Roughly equals 20 replies + 20 likes + 10 shares with default weights.
   *
   * @env ALPHA_MAX_EXPECTED_SOCIAL_SCORE
   * @default 100
   */
  maxExpectedSocialScore: envNumber('ALPHA_MAX_EXPECTED_SOCIAL_SCORE', 100),

  /**
   * Maximum expected trading score (for normalization).
   * Roughly equals ~20 trades with bonuses.
   *
   * @env ALPHA_MAX_EXPECTED_TRADING_SCORE
   * @default 50
   */
  maxExpectedTradingScore: envNumber('ALPHA_MAX_EXPECTED_TRADING_SCORE', 50),

  /**
   * Quality score multiplier for high-quality replies (> 0.8).
   *
   * @env ALPHA_QUALITY_MULTIPLIER
   * @default 1.2
   */
  qualityMultiplier: envNumber('ALPHA_QUALITY_MULTIPLIER', 1.2),

  /**
   * Quality score threshold for applying the multiplier.
   *
   * @env ALPHA_QUALITY_THRESHOLD
   * @default 0.8
   */
  qualityThreshold: envProbability('ALPHA_QUALITY_THRESHOLD', 0.8),

  // ===========================================================================
  // DEFAULT FOCUS WEIGHTS (when NPC has no tierOverrides)
  // ===========================================================================

  /**
   * Default social weight when NPC has no focus weight overrides.
   *
   * @env ALPHA_DEFAULT_SOCIAL_WEIGHT
   * @default 0.5
   */
  defaultSocialWeight: envProbability('ALPHA_DEFAULT_SOCIAL_WEIGHT', 0.5),

  /**
   * Default trading weight when NPC has no focus weight overrides.
   *
   * @env ALPHA_DEFAULT_TRADING_WEIGHT
   * @default 0.5
   */
  defaultTradingWeight: envProbability('ALPHA_DEFAULT_TRADING_WEIGHT', 0.5),
} as const;

/**
 * Type for the alpha group configuration object.
 */
export type AlphaGroupConfig = typeof ALPHA_GROUP_CONFIG;

/**
 * Focus weights for domain-based engagement calculation.
 * Used when an NPC doesn't have explicit tierOverrides.focusWeights.
 */
export const DOMAIN_FOCUS_WEIGHTS: Record<
  string,
  { social: number; trading: number }
> = {
  // Trading-focused domains
  crypto: { social: 0.4, trading: 0.6 },
  trading: { social: 0.4, trading: 0.6 },
  finance: { social: 0.4, trading: 0.6 },
  defi: { social: 0.35, trading: 0.65 },
  markets: { social: 0.4, trading: 0.6 },

  // Social-focused domains
  media: { social: 0.8, trading: 0.2 },
  politics: { social: 0.8, trading: 0.2 },
  entertainment: { social: 0.85, trading: 0.15 },
  culture: { social: 0.75, trading: 0.25 },

  // Tech-focused domains (balanced with slight social lean)
  tech: { social: 0.6, trading: 0.4 },
  ai: { social: 0.55, trading: 0.45 },
  'venture-capital': { social: 0.5, trading: 0.5 },
  startups: { social: 0.55, trading: 0.45 },
};

/**
 * Get focus weights for an NPC based on their domain.
 * Returns the first matching domain weight, or default weights if none match.
 *
 * @param domains - Array of domain strings from the actor's domain field
 * @returns Focus weights for social and trading activity
 */
export function getFocusWeightsForDomains(domains: string[] | undefined): {
  social: number;
  trading: number;
} {
  if (!domains || domains.length === 0) {
    return {
      social: ALPHA_GROUP_CONFIG.defaultSocialWeight,
      trading: ALPHA_GROUP_CONFIG.defaultTradingWeight,
    };
  }

  // Check each domain for a match
  for (const domain of domains) {
    const normalized = domain.toLowerCase().trim();
    const weights = DOMAIN_FOCUS_WEIGHTS[normalized];
    if (weights) {
      return weights;
    }
  }

  // No matching domain found, use defaults
  return {
    social: ALPHA_GROUP_CONFIG.defaultSocialWeight,
    trading: ALPHA_GROUP_CONFIG.defaultTradingWeight,
  };
}

/**
 * Calculate the next eligible date for an invite based on decline count.
 * Uses exponential backoff: baseHours * 2^(declineCount-1), capped at maxHours.
 *
 * @param declineCount - Number of times user has declined (1-based)
 * @returns Date when user becomes eligible for next invite
 */
export function calculateNextEligibleDate(declineCount: number): Date {
  const exponent = Math.max(0, declineCount - 1);
  const cooldownHours = Math.min(
    ALPHA_GROUP_CONFIG.inviteDecayBaseHours * Math.pow(2, exponent),
    ALPHA_GROUP_CONFIG.inviteDecayMaxHours
  );
  return new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
}

/**
 * Check if a user's decline count should be reset based on inactivity.
 *
 * @param lastDeclinedAt - Date of last decline
 * @returns True if the decline count should be reset
 */
export function shouldResetDeclineCount(lastDeclinedAt: Date | null): boolean {
  if (!lastDeclinedAt) {
    return true;
  }
  const daysSinceDecline =
    (Date.now() - lastDeclinedAt.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceDecline >= ALPHA_GROUP_CONFIG.inviteDecayResetDays;
}

// Log configuration on startup (only in development)
if (process.env.NODE_ENV === 'development') {
  logger.debug(
    'Alpha Group Config loaded',
    {
      inviteProbabilityMultiplier:
        ALPHA_GROUP_CONFIG.inviteProbabilityMultiplier,
      maxInvitesPerTick: ALPHA_GROUP_CONFIG.maxInvitesPerTick,
      minReplies: ALPHA_GROUP_CONFIG.minReplies,
      minLikes: ALPHA_GROUP_CONFIG.minLikes,
      minTotalInteractions: ALPHA_GROUP_CONFIG.minTotalInteractions,
      includeTradingActivity: ALPHA_GROUP_CONFIG.includeTradingActivity,
      fastTrackEnabled: ALPHA_GROUP_CONFIG.fastTrackEnabled,
      inviteDecayEnabled: ALPHA_GROUP_CONFIG.inviteDecayEnabled,
      perNpcCustomizationEnabled: ALPHA_GROUP_CONFIG.perNpcCustomizationEnabled,
    },
    'alpha-group-config'
  );
}
