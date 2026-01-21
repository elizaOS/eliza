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
  FARCASTER_FOLLOW: 100, // Follow Polyagent on Farcaster
  TWITTER_LINK: 300,
  TWITTER_FOLLOW: 100, // Follow Polyagent on Twitter/X
  DISCORD_LINK: 300, // Link Discord account
  DISCORD_JOIN: 100, // Join Polyagent Discord server
  WALLET_CONNECT: 300,
  SHARE_ACTION: 500,
  SHARE_TO_TWITTER: 500,
  REFERRAL_SIGNUP: 100, // Reward for referrer when someone signs up
  REFERRAL_BONUS: 100, // Bonus for new user who used a referral code (on top of base signup)
  REFERRAL_QUALIFIED: 100, // Bonus for referrer when referred user completes profile
  PRIVATE_GROUP_CREATE: 200, // Reward for creating a private group
  PRIVATE_CHANNEL_CREATE: 200, // Reward for creating a private channel
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
  | "transfer_sent"
  | "transfer_received"
  | "report_reward"; // Reward for successful reporting of CSAM/scammer
