/**
 * Points Constants
 *
 * @description Point award amounts for various actions in the rewards system.
 * Extracted to avoid bundling database into client components. These constants
 * define the point values awarded for user actions like signup, profile completion,
 * social account linking, and referrals.
 */

/**
 * Point award amounts for various user actions
 *
 * @description Defines the number of points awarded for different user actions
 * in the rewards system. Used by the points service to calculate rewards.
 */
export const POINTS = {
  INITIAL_SIGNUP: 1000,
  PROFILE_COMPLETION: 200, // Username + Profile Image + Bio (consolidated)
  FARCASTER_LINK: 300,
  FARCASTER_FOLLOW: 100, // Follow Feed on Farcaster
  TWITTER_LINK: 300,
  TWITTER_FOLLOW: 100, // Follow Feed on Twitter/X
  DISCORD_LINK: 300, // Link Discord account
  DISCORD_JOIN: 100, // Join Feed Discord server
  TELEGRAM_LINK: 300, // Link Telegram account
  WALLET_CONNECT: 300,
  EMAIL_SUBMIT: 100,
  SHARE_ACTION: 500,
  SHARE_TO_TWITTER: 500,
  REFERRAL_SIGNUP: 100, // Reward for referrer when someone signs up
  REFERRAL_BONUS: 100, // Bonus for new user who used a referral code (on top of base signup)
  REFERRAL_QUALIFIED: 100, // Bonus for referrer when referred user completes profile
  ONCHAIN_REGISTRATION: 100, // Cost to register on-chain via Agent0 ERC-8004
  PRIVATE_GROUP_CREATE: 200, // Reward for creating a private group
  PRIVATE_CHANNEL_CREATE: 200, // Reward for creating a private channel

  // Daily login rewards (BAB-88) - escalating rewards per streak day
  DAILY_LOGIN_DAY_1: 50,
  DAILY_LOGIN_DAY_2: 75,
  DAILY_LOGIN_DAY_3: 100,
  DAILY_LOGIN_DAY_4: 125,
  DAILY_LOGIN_DAY_5: 150,
  DAILY_LOGIN_DAY_6: 175,
  DAILY_LOGIN_DAY_7: 200,

  // Daily login milestone bonuses (awarded when streak reaches milestone)
  DAILY_LOGIN_MILESTONE_7D: 500,
  DAILY_LOGIN_MILESTONE_14D: 750,
  DAILY_LOGIN_MILESTONE_30D: 1500,
  DAILY_LOGIN_MILESTONE_60D: 3000,
  DAILY_LOGIN_MILESTONE_90D: 5000,

  // Achievement & challenge completion bonuses
  CHALLENGE_DAILY_ALL_BONUS: 40, // Bonus for completing all 3 daily challenges
  CHALLENGE_WEEKLY_ALL_BONUS: 100, // Bonus for completing both weekly challenges
} as const;

/**
 * Daily login timing constants (in milliseconds)
 */
export const DAILY_LOGIN = {
  /** Minimum time between claims (24 hours) */
  MIN_CLAIM_INTERVAL_MS: 24 * 60 * 60 * 1000,
  /** Grace period before streak resets (36 hours) */
  GRACE_PERIOD_MS: 36 * 60 * 60 * 1000,
  /** Number of days in a reward cycle before it repeats */
  CYCLE_LENGTH: 7,
} as const;

/**
 * Valid reasons for point transactions
 *
 * @description Enumeration of all valid reasons for awarding or deducting points.
 * Used in balance transactions and points service to track point movements.
 */
export type PointsReason =
  | "initial_signup"
  | "profile_completion"
  | "farcaster_link"
  | "farcaster_follow"
  | "twitter_link"
  | "twitter_follow"
  | "discord_link"
  | "discord_join"
  | "telegram_link"
  | "wallet_connect"
  | "share_action"
  | "share_to_twitter"
  | "referral_signup"
  | "referral_bonus"
  | "referral_qualified"
  | "private_group_create"
  | "private_channel_create"
  | "admin_award"
  | "admin_deduction"
  | "purchase"
  | "purchase_refund" // Points deducted due to Stripe refund
  | "purchase_dispute" // Points deducted due to chargeback/dispute
  | "purchase_dispute_won" // Points re-credited after winning dispute
  | "transfer_sent"
  | "transfer_received"
  | "report_reward" // Reward for successful reporting of CSAM/scammer
  | "trading_pnl" // Points from trading profit/loss
  | "daily_login" // Points from daily login streak reward
  | "onchain_registration" // Points deducted for on-chain ERC-8004 registration
  | "email_submit" // Points for providing email address
  | "achievement_unlock" // Points from unlocking an achievement
  | "challenge_complete"; // Points from completing a challenge (individual or all-bonus)
