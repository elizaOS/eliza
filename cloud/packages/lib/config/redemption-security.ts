/**
 * Redemption Security Configuration
 *
 * Centralized security settings for the elizaOS token payout system.
 * All values are conservative defaults - adjust based on liquidity and risk tolerance.
 */

// ============================================================================
// ANTI-ARBITRAGE PROTECTION
// ============================================================================

export const ARBITRAGE_PROTECTION = {
  // Use TWAP instead of spot price to prevent flash loan attacks
  USE_TWAP_PRICING: true,

  // TWAP window in milliseconds (15 minutes smooths out manipulation)
  TWAP_WINDOW_MS: 15 * 60 * 1000,

  // Minimum price samples required before allowing redemption
  // Prevents redemption during data gaps
  MIN_PRICE_SAMPLES: 3,

  // Maximum allowed price deviation between sources (reject if higher)
  MAX_SOURCE_DEVIATION: 0.05, // 5%

  // Maximum allowed slippage from TWAP to current spot
  // If current price diverges too much from TWAP, something is wrong
  MAX_TWAP_SLIPPAGE: 0.03, // 3%

  // Minimum spread we accept (covers gas + slippage + margin)
  // We pay TWAP price minus this spread to protect against arb
  SAFETY_SPREAD: 0.02, // 2% - user gets 98% of theoretical value

  // Maximum price move during quote validity that we'll honor
  MAX_PRICE_MOVE_DURING_QUOTE: 0.05, // 5%

  // Quote validity period (shorter = harder to arbitrage)
  QUOTE_VALIDITY_MS: 2 * 60 * 1000, // 2 minutes
};

// ============================================================================
// SUPPLY SHOCK PROTECTION
// ============================================================================

export const SUPPLY_SHOCK_PROTECTION = {
  // System-wide limits (across ALL users)
  SYSTEM_HOURLY_LIMIT_USD: 10000, // $10k/hour max across all users
  SYSTEM_DAILY_LIMIT_USD: 50000, // $50k/day max across all users

  // Individual limits
  USER_DAILY_LIMIT_USD: 5000, // $5k/day per user
  USER_HOURLY_LIMIT_USD: 1000, // $1k/hour per user
  MAX_SINGLE_REDEMPTION_USD: 1000, // $1k max single redemption
  MIN_REDEMPTION_USD: 1, // $1 minimum (100 points)

  // Velocity limits (detect coordinated attacks)
  MAX_REDEMPTIONS_PER_5_MIN: 10, // If 10 redemptions in 5 min, pause

  // Large redemption delays
  LARGE_REDEMPTION_THRESHOLD_USD: 500, // $500+ = large
  LARGE_REDEMPTION_DELAY_MS: 10 * 60 * 1000, // 10 minute delay

  // Cooldown between redemptions per user
  USER_COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes between redemptions
};

// ============================================================================
// VOLATILITY CIRCUIT BREAKERS
// ============================================================================

export const VOLATILITY_BREAKERS = {
  // If price moves more than this in TWAP window, pause redemptions
  MAX_VOLATILITY_PERCENT: 0.1, // 10%

  // If these many consecutive price fetches fail, pause
  MAX_CONSECUTIVE_FAILURES: 3,

  // If price is below this USD, something is very wrong - pause
  MIN_SANE_PRICE_USD: 0.0001,

  // If price is above this USD, also suspicious - pause for review
  MAX_SANE_PRICE_USD: 100,

  // Pause redemptions if hot wallet balance drops below this
  MIN_HOT_WALLET_TOKENS: 100,
};

// ============================================================================
// FRAUD DETECTION PATTERNS
// ============================================================================

export const FRAUD_PATTERNS = {
  // Flag if user redeems immediately after price drops
  FLAG_REDEMPTION_AFTER_DUMP_WINDOW_MS: 5 * 60 * 1000,
  FLAG_REDEMPTION_AFTER_DUMP_THRESHOLD: 0.05, // 5% drop

  // Flag if same payout address used by multiple users
  FLAG_SHARED_PAYOUT_ADDRESS: true,

  // Flag if redemption happens within X ms of points being earned
  // (possible self-dealing through apps)
  FLAG_FAST_EARN_TO_REDEEM_MS: 60 * 60 * 1000, // 1 hour

  // Flag if user has high redemption-to-earn ratio
  FLAG_HIGH_REDEMPTION_RATIO: 0.9, // 90%+ of points redeemed

  // Require manual review for flagged redemptions
  REQUIRE_REVIEW_FOR_FLAGGED: true,
};

// ============================================================================
// ADMIN CONTROLS
// ============================================================================

export const ADMIN_CONTROLS = {
  // Require admin approval for redemptions above this amount
  ADMIN_APPROVAL_THRESHOLD_USD: 500,

  // Maximum time a redemption can sit in pending (auto-expire)
  MAX_PENDING_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours

  // Maximum retries before requiring manual intervention
  MAX_RETRY_ATTEMPTS: 3,

  // Emergency pause (set in environment or database)
  ALLOW_EMERGENCY_PAUSE: true,
};

// ============================================================================
// FEE STRUCTURE
// ============================================================================

export const FEE_STRUCTURE = {
  // Network gas fees are covered by us (factored into safety spread)
  // but we can add explicit fees if needed

  // Fixed fee per redemption (in USD)
  FIXED_FEE_USD: 0, // No fixed fee currently

  // Percentage fee on redemption
  PERCENTAGE_FEE: 0, // No percentage fee currently

  // The safety spread above (2%) covers:
  // - Gas fees for token transfer
  // - Slippage if we need to swap
  // - Risk premium for price movement
  // - Small margin for sustainability
};

// ============================================================================
// MONITORING & ALERTING THRESHOLDS
// ============================================================================

export const MONITORING = {
  // Alert if hot wallet balance drops below X tokens
  ALERT_LOW_BALANCE_TOKENS: 1000,

  // Alert if hourly volume exceeds X% of limit
  ALERT_HIGH_VOLUME_PERCENT: 0.8, // 80%

  // Alert if price volatility exceeds X%
  ALERT_HIGH_VOLATILITY: 0.08, // 8%

  // Alert if X consecutive redemptions fail
  ALERT_CONSECUTIVE_FAILURES: 2,

  // Channels (configured via env)
  SLACK_WEBHOOK_ENV: "REDEMPTION_ALERT_SLACK_WEBHOOK",
  PAGERDUTY_KEY_ENV: "REDEMPTION_ALERT_PAGERDUTY_KEY",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate the effective elizaOS tokens a user receives after safety spread.
 *
 * @param usdValue - The USD value being redeemed
 * @param twapPrice - The TWAP price of elizaOS in USD
 * @returns The elizaOS tokens the user will receive
 */
export function calculateEffectiveTokens(usdValue: number, twapPrice: number): number {
  // Apply safety spread (user gets slightly less than theoretical)
  const effectiveUsd = usdValue * (1 - ARBITRAGE_PROTECTION.SAFETY_SPREAD);
  return effectiveUsd / twapPrice;
}

/**
 * Check if a redemption amount triggers large redemption rules.
 */
export function isLargeRedemption(usdValue: number): boolean {
  return usdValue >= SUPPLY_SHOCK_PROTECTION.LARGE_REDEMPTION_THRESHOLD_USD;
}

/**
 * Check if a redemption requires admin approval.
 */
export function requiresAdminApproval(usdValue: number): boolean {
  return usdValue >= ADMIN_CONTROLS.ADMIN_APPROVAL_THRESHOLD_USD;
}

/**
 * Check if price is within sane bounds.
 */
export function isPriceSane(priceUsd: number): boolean {
  return (
    priceUsd >= VOLATILITY_BREAKERS.MIN_SANE_PRICE_USD &&
    priceUsd <= VOLATILITY_BREAKERS.MAX_SANE_PRICE_USD
  );
}
