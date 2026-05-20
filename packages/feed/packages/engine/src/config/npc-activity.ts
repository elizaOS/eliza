/**
 * NPC Activity Configuration
 *
 * Centralized configuration for all NPC activity rates and probabilities.
 * All values can be overridden via environment variables for easy tuning
 * without code changes.
 *
 * @module engine/config/npc-activity
 *
 * @description
 * This configuration controls how active NPCs are across all game systems:
 * - Posting frequency and limits
 * - Social engagement (likes, shares, comments)
 * - Social actions (DMs, group invites)
 * - Group dynamics (forming, joining, leaving groups)
 * - Content pacing and timing
 *
 * **Environment Variable Naming Convention:**
 * All env vars are prefixed with `NPC_` and use SCREAMING_SNAKE_CASE.
 *
 * @example
 * ```bash
 * # Increase NPC posting activity
 * NPC_POST_PROBABILITY=0.45
 * NPC_MAX_POSTS_PER_DAY=8
 *
 * # Increase social engagement
 * NPC_LIKE_PROBABILITY=0.15
 * NPC_SHARE_PROBABILITY=0.04
 *
 * # Process more NPCs per tick
 * NPC_TICK_BATCH_SIZE=8
 * ```
 */

import { logger } from '@babylon/shared';
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
 * Parse an environment variable as a positive number (> 0) with bounds checking.
 * Returns the default and logs a warning if the value is <= 0.
 */
function envPositiveNumber(key: string, defaultValue: number): number {
  const value = envNumber(key, defaultValue);
  if (value <= 0) {
    logger.warn(
      `${key}=${value} must be positive (> 0), using default ${defaultValue}`,
      { key, value, defaultValue },
      'npc-activity'
    );
    return defaultValue;
  }
  return value;
}

/**
 * Parse an environment variable as a non-negative number (>= 0) with bounds checking.
 * Returns the default and logs a warning if the value is < 0.
 * Use for values where 0 is valid (e.g., to disable a feature).
 */
function envNonNegativeNumber(key: string, defaultValue: number): number {
  const value = envNumber(key, defaultValue);
  if (value < 0) {
    logger.warn(
      `${key}=${value} must be non-negative (>= 0), using default ${defaultValue}`,
      { key, value, defaultValue },
      'npc-activity'
    );
    return defaultValue;
  }
  return value;
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
      'npc-activity'
    );
  }
  return clamp01(value);
}

/**
 * Parse an environment variable as a score (0.0-1.0) with bounds checking.
 * Similar to envProbability but semantically distinct for quality scores, thresholds, etc.
 * Clamps the value to valid [0,1] range to prevent configuration errors.
 */
function envScore(key: string, defaultValue: number): number {
  const value = envNumber(key, defaultValue);
  if (value < 0 || value > 1) {
    logger.warn(
      `${key}=${value} is outside valid score range (0-1), clamping to bounds`,
      { key, value },
      'npc-activity'
    );
  }
  return clamp01(value);
}

/**
 * Parse an environment variable as a boolean with a default fallback.
 *
 * Accepts: true/false, 1/0, yes/no (case-insensitive).
 * Logs a warning and returns default for unrecognized values.
 */
function envBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  logger.warn(
    `${key}="${value}" is not a valid boolean, using default ${defaultValue}`,
    { key, value, defaultValue },
    'npc-activity'
  );
  return defaultValue;
}

// =============================================================================
// POSTING CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC posting behavior.
 *
 * Controls how often NPCs create new posts on the feed.
 */
export const NPC_POSTING_CONFIG = {
  /**
   * Base probability for an NPC to post (0.0 - 1.0).
   * All NPCs have equal chance - creates natural entropy.
   * NPCs should post regularly to keep the feed active.
   *
   * @default 0.25 (25% base - NPCs should post to keep feed alive)
   * @env NPC_POST_PROBABILITY
   */
  baseProbability: envProbability('NPC_POST_PROBABILITY', 0.25),

  /**
   * Maximum posts per day per NPC to prevent spam.
   * Same for all tiers - fair rotation.
   * Lower cap = more unique NPCs get a turn to post.
   *
   * @default 3 (balanced - encourages diversity across NPCs)
   * @env NPC_MAX_POSTS_PER_DAY
   */
  maxPostsPerDay: envPositiveNumber('NPC_MAX_POSTS_PER_DAY', 3),

  /**
   * Minimum hours between posts for the same NPC.
   * Prevents same NPC posting multiple times per tick.
   * A value of 0 allows back-to-back posting (useful for testing).
   * Higher value = slower individual pace = more variety across NPCs.
   *
   * @default 3 (balanced pacing for diverse feed)
   * @env NPC_MIN_HOURS_BETWEEN_POSTS
   */
  minHoursBetweenPosts: envNonNegativeNumber('NPC_MIN_HOURS_BETWEEN_POSTS', 3),

  /**
   * Boost multiplier when actor was mentioned by a player.
   * Keeps engagement reactive to player actions.
   *
   * @default 1.3 (modest boost)
   * @env NPC_MENTION_BOOST
   */
  mentionBoost: envNumber('NPC_MENTION_BOOST', 1.3),

  /**
   * Boost multiplier when actor is affiliated with an active event.
   *
   * @default 1.2 (modest boost)
   * @env NPC_AFFILIATION_BOOST
   */
  affiliationBoost: envNumber('NPC_AFFILIATION_BOOST', 1.2),
} as const;

// =============================================================================
// TRADING CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC trading behavior.
 *
 * Controls how often NPCs consider trading and the limits on their trading activity.
 */
export const NPC_TRADING_CONFIG = {
  /**
   * Base probability for an NPC to consider trading per tick (0.0 - 1.0).
   * Higher than posting since trading is a core game mechanic.
   *
   * @default 0.6 (60% chance to consider trading per tick)
   * @env NPC_TRADE_PROBABILITY
   */
  baseProbability: envProbability('NPC_TRADE_PROBABILITY', 0.6),

  /**
   * Maximum trades per day per NPC to prevent excessive trading.
   * Higher than posts since trading is more central to gameplay.
   *
   * @default 20
   * @env NPC_MAX_TRADES_PER_DAY
   */
  maxTradesPerDay: envPositiveNumber('NPC_MAX_TRADES_PER_DAY', 20),

  /**
   * Minimum minutes between trades for the same NPC.
   * Prevents same NPC trading multiple times per tick.
   * A value of 0 allows back-to-back trading (useful for testing).
   *
   * @default 5 (5 minute cooldown)
   * @env NPC_MIN_MINUTES_BETWEEN_TRADES
   */
  minMinutesBetweenTrades: envNonNegativeNumber(
    'NPC_MIN_MINUTES_BETWEEN_TRADES',
    5
  ),
} as const;

// =============================================================================
// SOCIAL ENGAGEMENT CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC social engagement (likes, shares, comments).
 *
 * Controls how NPCs interact with existing posts on the feed.
 */
export const NPC_ENGAGEMENT_CONFIG = {
  /**
   * Base probability for an NPC to like a post (0.0 - 1.0).
   * HIGHER than posting - NPCs should engage more than create.
   *
   * @default 0.12 (doubled from original)
   * @env NPC_LIKE_PROBABILITY
   */
  baseLikeProbability: envProbability('NPC_LIKE_PROBABILITY', 0.12),

  /**
   * Base probability for an NPC to share/repost (0.0 - 1.0).
   *
   * @default 0.03 (doubled from original)
   * @env NPC_SHARE_PROBABILITY
   */
  baseShareProbability: envProbability('NPC_SHARE_PROBABILITY', 0.03),

  /**
   * Base probability for an NPC to comment (0.0 - 1.0).
   *
   * @default 0.04 (increased - comments are valuable engagement)
   * @env NPC_COMMENT_PROBABILITY
   */
  baseCommentProbability: envProbability('NPC_COMMENT_PROBABILITY', 0.04),

  /**
   * Boost multiplier when NPC shares an org affiliation with post author.
   *
   * @default 2.0 (increased for more org-based engagement)
   * @env NPC_ENGAGEMENT_AFFILIATION_BOOST
   */
  affiliationBoost: envNumber('NPC_ENGAGEMENT_AFFILIATION_BOOST', 2.0),

  /**
   * Boost multiplier for article-type posts (higher quality content).
   *
   * @default 1.8 (increased - encourage engagement with quality content)
   * @env NPC_ENGAGEMENT_ARTICLE_BOOST
   */
  articleBoost: envNumber('NPC_ENGAGEMENT_ARTICLE_BOOST', 1.8),

  /**
   * Maximum likes across all NPCs per tick.
   *
   * @default 20 (increased for more engagement)
   * @env NPC_MAX_LIKES_PER_TICK
   */
  maxLikesPerTick: envPositiveNumber('NPC_MAX_LIKES_PER_TICK', 20),

  /**
   * Maximum shares across all NPCs per tick.
   *
   * @default 8 (doubled for more reposting)
   * @env NPC_MAX_SHARES_PER_TICK
   */
  maxSharesPerTick: envPositiveNumber('NPC_MAX_SHARES_PER_TICK', 8),

  /**
   * Maximum total comments (including replies-to-comments) across all NPCs per tick.
   *
   * @default 18 (increased for deeper threads + more conversation)
   * @env NPC_MAX_COMMENTS_PER_TICK
   */
  maxCommentsPerTick: envPositiveNumber('NPC_MAX_COMMENTS_PER_TICK', 18),

  /**
   * Maximum comment replies (nested comments) per tick.
   *
   * This budget is used for 2nd+ level comment threads (comment → reply → reply ...).
   * If set too low, the feed has "lonely" one-off comments.
   *
   * @default 8
   * @env NPC_MAX_COMMENT_REPLIES_PER_TICK
   */
  maxCommentRepliesPerTick: envNonNegativeNumber(
    'NPC_MAX_COMMENT_REPLIES_PER_TICK',
    8
  ),

  /**
   * Maximum depth for NPC comment threads (root comment depth = 0).
   *
   * @default 3 (allows up to 4 total levels including the root)
   * @env NPC_MAX_COMMENT_THREAD_DEPTH
   */
  maxCommentThreadDepth: envPositiveNumber('NPC_MAX_COMMENT_THREAD_DEPTH', 3),

  /**
   * Base probability that the post author replies to a comment on their post.
   * Strong relationships (love/hate) increase the chance.
   *
   * @default 0.35
   * @env NPC_COMMENT_AUTHOR_REPLY_PROBABILITY
   */
  commentAuthorReplyProbability: envProbability(
    'NPC_COMMENT_AUTHOR_REPLY_PROBABILITY',
    0.35
  ),

  /**
   * Base probability that a thread continues after a reply (back-and-forth).
   * Strong relationships (love/hate) increase the chance.
   *
   * @default 0.45
   * @env NPC_COMMENT_THREAD_CONTINUE_PROBABILITY
   */
  commentThreadContinueProbability: envProbability(
    'NPC_COMMENT_THREAD_CONTINUE_PROBABILITY',
    0.45
  ),

  /**
   * Probability that the quoted person "clapbacks" by commenting on a quote-post about them.
   *
   * @default 0.6
   * @env NPC_QUOTE_CLAPBACK_PROBABILITY
   */
  quoteClapbackProbability: envProbability(
    'NPC_QUOTE_CLAPBACK_PROBABILITY',
    0.6
  ),

  /**
   * Probability that a discourse interaction becomes a quote-post instead of a reply.
   * Only applies when engaging with an original post (not a reply thread).
   *
   * @default 0.30 (30% quote-posts, 70% direct replies)
   * @env NPC_DISCOURSE_QUOTE_PROBABILITY
   */
  discourseQuoteProbability: envProbability(
    'NPC_DISCOURSE_QUOTE_PROBABILITY',
    0.3
  ),

  /**
   * Number of NPCs to sample for engagement each tick.
   *
   * @default 20 (increased for broader engagement)
   * @env NPC_ENGAGEMENT_ACTORS_TO_SAMPLE
   */
  actorsToSample: envPositiveNumber('NPC_ENGAGEMENT_ACTORS_TO_SAMPLE', 20),

  /**
   * Number of recent posts to consider for engagement.
   *
   * @default 40 (increased for more engagement opportunities)
   * @env NPC_ENGAGEMENT_POSTS_TO_CONSIDER
   */
  postsToConsider: envPositiveNumber('NPC_ENGAGEMENT_POSTS_TO_CONSIDER', 40),
} as const;

// =============================================================================
// DIVERSITY CONFIGURATION (TikTok-inspired feed diversity)
// =============================================================================

/**
 * Configuration for feed diversity mechanisms.
 *
 * Controls how NPC actions are distributed to prevent clustering and create
 * an organic social media feel. Based on TikTok/Twitter feed algorithms.
 */
export const NPC_DIVERSITY_CONFIG = {
  /**
   * Maximum consecutive same action type allowed (TikTok-style).
   * Used by the action diversity tracker to prevent clustering.
   * E.g., 1 means never allow 2 likes in a row.
   *
   * @default 1 (TikTok rule: never consecutive same type)
   * @env NPC_MAX_CONSECUTIVE_SAME_ACTION
   */
  maxConsecutiveSameAction: envPositiveNumber(
    'NPC_MAX_CONSECUTIVE_SAME_ACTION',
    1
  ),

  /**
   * Timestamp stagger window in milliseconds.
   * Actions within a tick get timestamps spread across this window.
   * Set to 0 to disable timestamp staggering.
   *
   * @default 300000 (5 minutes)
   * @env NPC_TIMESTAMP_STAGGER_MS
   */
  timestampStaggerMs: envNonNegativeNumber(
    'NPC_TIMESTAMP_STAGGER_MS',
    5 * 60 * 1000
  ),

  /**
   * Number of recent actions to track for diversity checking.
   * Larger values provide more context for detecting clustering patterns.
   * Must be at least as large as maxConsecutiveSameAction.
   *
   * @default 5
   * @env NPC_MAX_RECENT_ACTIONS
   */
  maxRecentActions: envPositiveNumber('NPC_MAX_RECENT_ACTIONS', 5),
} as const;

// =============================================================================
// SOCIAL ACTIONS CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC social actions (DMs, group invites).
 *
 * Controls how NPCs initiate direct interactions with players.
 */
export const NPC_SOCIAL_ACTIONS_CONFIG = {
  /**
   * Base probability for an NPC to invite a user to a group chat.
   *
   * @default 0.08 (increased for more player engagement)
   * @env NPC_GROUP_INVITE_PROBABILITY
   */
  baseInviteProbability: envProbability('NPC_GROUP_INVITE_PROBABILITY', 0.08),

  /**
   * Base probability for an NPC to send a direct message.
   *
   * @default 0.05 (increased for more player engagement)
   * @env NPC_DM_PROBABILITY
   */
  baseDmProbability: envProbability('NPC_DM_PROBABILITY', 0.05),

  /**
   * Minimum number of prior interactions needed before social action.
   * Must be positive (> 0) to prevent division by zero.
   *
   * @default 1 (lowered - engage players more readily)
   * @env NPC_MIN_INTERACTIONS_FOR_ACTION
   */
  minInteractionsForAction: envPositiveNumber(
    'NPC_MIN_INTERACTIONS_FOR_ACTION',
    1
  ),

  /**
   * Minimum average interaction quality score needed (0.0 - 1.0).
   * Validated and clamped to the [0,1] score range.
   *
   * @default 0.5 (lowered - be more inclusive)
   * @env NPC_MIN_INTERACTION_QUALITY
   */
  minInteractionQuality: envScore('NPC_MIN_INTERACTION_QUALITY', 0.5),
} as const;

// =============================================================================
// GROUP DYNAMICS CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC group dynamics (forming, joining, leaving groups).
 *
 * Controls how NPCs interact with group chats.
 */
export const NPC_GROUP_DYNAMICS_CONFIG = {
  /**
   * Probability for an eligible NPC to form a new group.
   *
   * @default 0.06 (modest increase)
   * @env NPC_FORM_GROUP_PROBABILITY
   */
  formGroupProbability: envProbability('NPC_FORM_GROUP_PROBABILITY', 0.06),

  /**
   * Probability for an eligible NPC to join an existing group.
   *
   * @default 0.12 (increased for more group activity)
   * @env NPC_JOIN_GROUP_PROBABILITY
   */
  joinGroupProbability: envProbability('NPC_JOIN_GROUP_PROBABILITY', 0.12),

  /**
   * Probability for an NPC to leave a group per membership per tick.
   *
   * @default 0.02 (unchanged - churn should be low)
   * @env NPC_LEAVE_GROUP_PROBABILITY
   */
  leaveGroupProbability: envProbability('NPC_LEAVE_GROUP_PROBABILITY', 0.02),

  /**
   * Probability for an NPC to invite a user to their group.
   *
   * @default 0.10 (increased to bring players into groups)
   * @env NPC_USER_INVITE_PROBABILITY
   */
  inviteUserProbability: envProbability('NPC_USER_INVITE_PROBABILITY', 0.1),

  /**
   * Probability to check for kicks each tick.
   *
   * @default 0.15 (unchanged)
   * @env NPC_KICK_CHECK_PROBABILITY
   */
  kickCheckProbability: envProbability('NPC_KICK_CHECK_PROBABILITY', 0.15),

  /**
   * Minimum group size before NPCs start leaving.
   *
   * @default 3
   * @env NPC_MIN_GROUP_SIZE
   */
  minGroupSize: envPositiveNumber('NPC_MIN_GROUP_SIZE', 3),

  /**
   * Maximum group size before NPCs stop joining.
   *
   * @default 12
   * @env NPC_MAX_GROUP_SIZE
   */
  maxGroupSize: envPositiveNumber('NPC_MAX_GROUP_SIZE', 12),

  /**
   * Ideal group size (influences join/leave decisions).
   *
   * @default 7
   * @env NPC_IDEAL_GROUP_SIZE
   */
  idealGroupSize: envPositiveNumber('NPC_IDEAL_GROUP_SIZE', 7),

  /**
   * When enabled, users with **zero** active group memberships will be auto-joined
   * into a random NPC group chat on the next tick.
   *
   * This is intended for local development to demonstrate that NPC private chats
   * are working and actively receiving messages.
   *
   * @default true in development, false otherwise
   * @env NPC_AUTO_JOIN_EMPTY_USERS_TO_NPC_GROUP_CHAT
   */
  autoJoinEmptyUsersToNpcGroupChat: envBoolean(
    'NPC_AUTO_JOIN_EMPTY_USERS_TO_NPC_GROUP_CHAT',
    process.env.NODE_ENV === 'development'
  ),

  /**
   * Maximum number of users to auto-join per tick when
   * `autoJoinEmptyUsersToNpcGroupChat` is enabled.
   *
   * @default 25
   * @env NPC_AUTO_JOIN_EMPTY_USERS_BATCH_SIZE
   */
  autoJoinEmptyUsersBatchSize: envPositiveNumber(
    'NPC_AUTO_JOIN_EMPTY_USERS_BATCH_SIZE',
    25
  ),
} as const;

// Validate minGroupSize <= maxGroupSize at module initialization
// Fail fast with an error to prevent the system from running with invalid config
if (
  NPC_GROUP_DYNAMICS_CONFIG.minGroupSize >
  NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize
) {
  throw new Error(
    `Invalid group size configuration: minGroupSize (${NPC_GROUP_DYNAMICS_CONFIG.minGroupSize}) > maxGroupSize (${NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize}). This will cause undefined behavior in group dynamics.`
  );
}

// Validate idealGroupSize is within [minGroupSize, maxGroupSize] range
// Fail fast with an error to prevent the system from running with invalid config
if (
  NPC_GROUP_DYNAMICS_CONFIG.idealGroupSize <
    NPC_GROUP_DYNAMICS_CONFIG.minGroupSize ||
  NPC_GROUP_DYNAMICS_CONFIG.idealGroupSize >
    NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize
) {
  throw new Error(
    `Invalid group size configuration: idealGroupSize (${NPC_GROUP_DYNAMICS_CONFIG.idealGroupSize}) must be within [minGroupSize (${NPC_GROUP_DYNAMICS_CONFIG.minGroupSize}), maxGroupSize (${NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize})]. This will cause undefined behavior in group dynamics.`
  );
}

// =============================================================================
// CONTENT PACING CONFIGURATION
// =============================================================================

/**
 * Configuration for content pacing (timing and rate of content generation).
 *
 * Controls how content is distributed over time.
 */
export const NPC_CONTENT_PACING_CONFIG = {
  /**
   * Activity multiplier during peak hours (9am-9pm).
   *
   * @default 1.0
   * @env NPC_PEAK_HOURS_MULTIPLIER
   */
  peakHoursMultiplier: envNumber('NPC_PEAK_HOURS_MULTIPLIER', 1.0),

  /**
   * Activity multiplier during off-peak hours (9pm-9am).
   *
   * @default 0.4 (increased - some global audience is awake)
   * @env NPC_OFF_PEAK_MULTIPLIER
   */
  offPeakMultiplier: envNumber('NPC_OFF_PEAK_MULTIPLIER', 0.4),

  /**
   * Maximum posts any single actor can make in 24 hours.
   *
   * @default 5 (NPCs should post regularly to keep feed active)
   * @env NPC_CONTENT_MAX_POSTS_PER_ACTOR_PER_DAY
   */
  maxPostsPerActorPerDay: envNumber(
    'NPC_CONTENT_MAX_POSTS_PER_ACTOR_PER_DAY',
    5
  ),

  /**
   * Minimum time in minutes between posts from the same actor.
   *
   * @default 30 (reasonable pacing)
   * @env NPC_MIN_MINUTES_BETWEEN_POSTS
   */
  minMinutesBetweenPosts: envNumber('NPC_MIN_MINUTES_BETWEEN_POSTS', 30),

  /**
   * Maximum posts to generate across all actors in a single tick.
   *
   * @default 4 (good amount of NPC activity)
   * @env NPC_MAX_POSTS_PER_TICK
   */
  maxPostsPerTick: envNumber('NPC_MAX_POSTS_PER_TICK', 4),

  /**
   * Target number of posts per hour across all actors.
   *
   * @default 12 (keeps the feed active)
   * @env NPC_TARGET_POSTS_PER_HOUR
   */
  targetPostsPerHour: envNumber('NPC_TARGET_POSTS_PER_HOUR', 12),

  /**
   * Start hour for peak activity (0-23).
   *
   * @default 9
   * @env NPC_PEAK_HOUR_START
   */
  peakHourStart: envNumber('NPC_PEAK_HOUR_START', 9),

  /**
   * End hour for peak activity (0-23).
   *
   * @default 21
   * @env NPC_PEAK_HOUR_END
   */
  peakHourEnd: envNumber('NPC_PEAK_HOUR_END', 21),
} as const;

// =============================================================================
// FOLLOWING CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC following behavior.
 *
 * Controls how NPCs follow/unfollow players and each other.
 */
export const NPC_FOLLOWING_CONFIG = {
  /**
   * Base probability for an NPC to proactively follow an active player.
   * Checked per active player per tick.
   *
   * @default 0.03 (3% chance per player per tick)
   * @env NPC_PROACTIVE_FOLLOW_PROBABILITY
   */
  proactiveFollowProbability: envProbability(
    'NPC_PROACTIVE_FOLLOW_PROBABILITY',
    0.03
  ),

  /**
   * Minimum posts by a player before NPCs consider following them.
   *
   * @default 3
   * @env NPC_MIN_POSTS_TO_FOLLOW
   */
  minPostsToFollow: envNumber('NPC_MIN_POSTS_TO_FOLLOW', 3),

  /**
   * Minimum engagement score for a player to be follow-worthy.
   * Calculated from likes, comments, and trading activity.
   *
   * @default 5 (accumulated engagement points)
   * @env NPC_MIN_ENGAGEMENT_TO_FOLLOW
   */
  minEngagementToFollow: envNumber('NPC_MIN_ENGAGEMENT_TO_FOLLOW', 5),

  /**
   * Maximum NPCs that can follow a player per tick.
   * Prevents sudden follower floods.
   *
   * @default 2
   * @env NPC_MAX_FOLLOWS_PER_PLAYER_PER_TICK
   */
  maxFollowsPerPlayerPerTick: envNumber(
    'NPC_MAX_FOLLOWS_PER_PLAYER_PER_TICK',
    2
  ),

  /**
   * Maximum total follows across all NPCs per tick.
   *
   * @default 5
   * @env NPC_MAX_FOLLOWS_PER_TICK
   */
  maxFollowsPerTick: envNumber('NPC_MAX_FOLLOWS_PER_TICK', 5),

  /**
   * Probability to check for unfollows each tick.
   *
   * @default 0.05 (5% chance to check)
   * @env NPC_UNFOLLOW_CHECK_PROBABILITY
   */
  unfollowCheckProbability: envProbability(
    'NPC_UNFOLLOW_CHECK_PROBABILITY',
    0.05
  ),

  /**
   * Days of inactivity before considering unfollow.
   *
   * @default 7
   * @env NPC_DAYS_BEFORE_UNFOLLOW
   */
  daysBeforeUnfollow: envNumber('NPC_DAYS_BEFORE_UNFOLLOW', 7),

  /**
   * Time window in days for engagement queries.
   * Limits how far back we look for player-NPC engagement.
   *
   * @default 14 (2 weeks)
   * @env NPC_ENGAGEMENT_WINDOW_DAYS
   */
  engagementWindowDays: envNumber('NPC_ENGAGEMENT_WINDOW_DAYS', 14),

  /**
   * Maximum NPC candidates to evaluate per player per tick.
   * Caps the work done when checking which NPCs should follow a player.
   *
   * @default 10
   * @env NPC_MAX_NPC_CANDIDATES_PER_PLAYER_PER_TICK
   */
  maxNpcCandidatesPerPlayerPerTick: envNumber(
    'NPC_MAX_NPC_CANDIDATES_PER_PLAYER_PER_TICK',
    10
  ),

  /**
   * Total maximum NPC candidates to evaluate per tick (across all players).
   * This is an absolute cap to prevent unbounded work regardless of player count.
   *
   * @default 50
   * @env NPC_TOTAL_MAX_NPC_CANDIDATES_PER_TICK
   */
  totalMaxNpcCandidatesPerTick: envNumber(
    'NPC_TOTAL_MAX_NPC_CANDIDATES_PER_TICK',
    50
  ),

  /**
   * Batch size for unfollow checks.
   * How many active follows to check per unfollow pass.
   *
   * @default 50
   * @env NPC_UNFOLLOW_CHECK_BATCH_SIZE
   */
  unfollowCheckBatchSize: envNumber('NPC_UNFOLLOW_CHECK_BATCH_SIZE', 50),

  /**
   * Maximum active players to consider for proactive following per tick.
   * Caps the query result to prevent processing too many candidates.
   *
   * @default 50
   * @env NPC_MAX_ACTIVE_PLAYERS_TO_CONSIDER
   */
  maxActivePlayersToConsider: envNumber(
    'NPC_MAX_ACTIVE_PLAYERS_TO_CONSIDER',
    50
  ),

  /**
   * Minimum average quality score to retain a follow.
   * If recent interactions fall below this threshold, NPC will unfollow.
   *
   * @default 0.4
   * @env NPC_MIN_QUALITY_TO_RETAIN_FOLLOW
   */
  minQualityToRetainFollow: envScore('NPC_MIN_QUALITY_TO_RETAIN_FOLLOW', 0.4),

  /**
   * Maximum hours of inactivity before NPC unfollows.
   * If no interactions occur within this window, NPC will unfollow.
   *
   * @default 24
   * @env NPC_MAX_INACTIVE_HOURS_BEFORE_UNFOLLOW
   */
  maxInactiveHoursBeforeUnfollow: envNumber(
    'NPC_MAX_INACTIVE_HOURS_BEFORE_UNFOLLOW',
    24
  ),
} as const;

// =============================================================================
// TICK PROCESSING CONFIGURATION
// =============================================================================

/**
 * Configuration for NPC tick processing.
 *
 * Controls how many NPCs are processed per tick and rate limiting.
 */
export const NPC_TICK_CONFIG = {
  /**
   * Number of NPCs to process per tick.
   * Higher batch size = more NPCs considered = better rotation across all NPCs.
   * With 140 NPCs and ~59 active at any time, 12/tick ensures good coverage.
   *
   * @default 12 (increased for better diversity across NPCs)
   * @env NPC_TICK_BATCH_SIZE
   */
  batchSize: envPositiveNumber('NPC_TICK_BATCH_SIZE', 12),

  /**
   * Maximum consecutive errors before aborting tick (circuit breaker).
   *
   * @default 5
   * @env NPC_TICK_MAX_ERRORS
   */
  maxConsecutiveErrors: envPositiveNumber('NPC_TICK_MAX_ERRORS', 5),

  /**
   * Maximum number of NPC discourse replies to generate per tick.
   * Controls how many NPCs can reply/quote to previous tick's posts.
   *
   * @default 6
   * @env NPC_MAX_DISCOURSE_REPLIES
   */
  maxDiscourseReplies: envPositiveNumber('NPC_MAX_DISCOURSE_REPLIES', 6),
} as const;

// =============================================================================
// COMBINED CONFIGURATION EXPORT
// =============================================================================

/**
 * Complete NPC activity configuration.
 *
 * Combines all configuration sections into a single export for convenience.
 */
export const NPC_ACTIVITY_CONFIG = {
  posting: NPC_POSTING_CONFIG,
  trading: NPC_TRADING_CONFIG,
  engagement: NPC_ENGAGEMENT_CONFIG,
  diversity: NPC_DIVERSITY_CONFIG,
  socialActions: NPC_SOCIAL_ACTIONS_CONFIG,
  groupDynamics: NPC_GROUP_DYNAMICS_CONFIG,
  contentPacing: NPC_CONTENT_PACING_CONFIG,
  following: NPC_FOLLOWING_CONFIG,
  tick: NPC_TICK_CONFIG,
} as const;

/**
 * Type for the complete NPC activity configuration.
 */
export type NPCActivityConfig = typeof NPC_ACTIVITY_CONFIG;

// =============================================================================
// PRESETS
// =============================================================================

/**
 * Preset configurations for common use cases.
 * These can be applied by setting NPC_ACTIVITY_PRESET environment variable.
 *
 * @example
 * ```bash
 * # Use the "active" preset for more NPC activity
 * NPC_ACTIVITY_PRESET=active
 * ```
 */
export const NPC_ACTIVITY_PRESETS = {
  /**
   * Default preset - balanced NPC activity.
   * NPCs post regularly to keep feed active while also engaging.
   */
  default: {
    // Active posting - NPCs keep the feed alive
    NPC_POST_PROBABILITY: '0.25',
    NPC_MAX_POSTS_PER_DAY: '4',
    NPC_MIN_HOURS_BETWEEN_POSTS: '2',
    NPC_TICK_BATCH_SIZE: '5',
    NPC_TARGET_POSTS_PER_HOUR: '12',
    NPC_MAX_POSTS_PER_TICK: '4',
    NPC_CONTENT_MAX_POSTS_PER_ACTOR_PER_DAY: '5',
    NPC_MIN_MINUTES_BETWEEN_POSTS: '30',
    // Good engagement
    NPC_LIKE_PROBABILITY: '0.12',
    NPC_SHARE_PROBABILITY: '0.03',
    NPC_COMMENT_PROBABILITY: '0.02',
    NPC_MAX_LIKES_PER_TICK: '20',
    NPC_MAX_SHARES_PER_TICK: '8',
    NPC_MAX_COMMENTS_PER_TICK: '6',
    // Social actions
    NPC_GROUP_INVITE_PROBABILITY: '0.08',
    NPC_DM_PROBABILITY: '0.05',
    NPC_MIN_INTERACTIONS_FOR_ACTION: '1',
    // Trading - balanced defaults
    NPC_TRADE_PROBABILITY: '0.6',
    NPC_MAX_TRADES_PER_DAY: '20',
    NPC_MIN_MINUTES_BETWEEN_TRADES: '5',
  },

  /**
   * Engagement-heavy preset - very low posting, very high engagement.
   * NPCs mostly interact with existing content and play the game.
   */
  engagement: {
    // Very low posting
    NPC_POST_PROBABILITY: '0.08',
    NPC_MAX_POSTS_PER_DAY: '1',
    NPC_MIN_HOURS_BETWEEN_POSTS: '4',
    NPC_TICK_BATCH_SIZE: '4',
    NPC_TARGET_POSTS_PER_HOUR: '4',
    NPC_MAX_POSTS_PER_TICK: '2',
    // Very high engagement
    NPC_LIKE_PROBABILITY: '0.18',
    NPC_SHARE_PROBABILITY: '0.05',
    NPC_COMMENT_PROBABILITY: '0.035',
    NPC_MAX_LIKES_PER_TICK: '30',
    NPC_MAX_SHARES_PER_TICK: '12',
    NPC_MAX_COMMENTS_PER_TICK: '10',
    NPC_ENGAGEMENT_ACTORS_TO_SAMPLE: '30',
    NPC_ENGAGEMENT_POSTS_TO_CONSIDER: '50',
    // High social activity
    NPC_GROUP_INVITE_PROBABILITY: '0.12',
    NPC_DM_PROBABILITY: '0.08',
    NPC_MIN_INTERACTIONS_FOR_ACTION: '1',
    NPC_MIN_INTERACTION_QUALITY: '0.4',
    NPC_JOIN_GROUP_PROBABILITY: '0.15',
    NPC_USER_INVITE_PROBABILITY: '0.12',
    // High trading - engagement-heavy NPCs play the game more
    NPC_TRADE_PROBABILITY: '0.8',
    NPC_MAX_TRADES_PER_DAY: '30',
    NPC_MIN_MINUTES_BETWEEN_TRADES: '3',
  },

  /**
   * Active preset - balanced but higher activity overall.
   * More posting AND more engagement.
   */
  active: {
    NPC_POST_PROBABILITY: '0.25',
    NPC_MAX_POSTS_PER_DAY: '4',
    NPC_MIN_HOURS_BETWEEN_POSTS: '2',
    NPC_TICK_BATCH_SIZE: '6',
    NPC_LIKE_PROBABILITY: '0.15',
    NPC_SHARE_PROBABILITY: '0.04',
    NPC_COMMENT_PROBABILITY: '0.025',
    NPC_MAX_LIKES_PER_TICK: '25',
    NPC_MAX_SHARES_PER_TICK: '10',
    NPC_MAX_COMMENTS_PER_TICK: '8',
    NPC_ENGAGEMENT_ACTORS_TO_SAMPLE: '25',
    NPC_ENGAGEMENT_POSTS_TO_CONSIDER: '50',
    NPC_GROUP_INVITE_PROBABILITY: '0.10',
    NPC_DM_PROBABILITY: '0.07',
    NPC_MIN_INTERACTIONS_FOR_ACTION: '1',
    NPC_MIN_INTERACTION_QUALITY: '0.4',
    NPC_FORM_GROUP_PROBABILITY: '0.08',
    NPC_JOIN_GROUP_PROBABILITY: '0.15',
    NPC_USER_INVITE_PROBABILITY: '0.12',
    NPC_TARGET_POSTS_PER_HOUR: '15',
    // Higher trading activity
    NPC_TRADE_PROBABILITY: '0.75',
    NPC_MAX_TRADES_PER_DAY: '25',
    NPC_MIN_MINUTES_BETWEEN_TRADES: '3',
  },

  /**
   * Quiet preset - reduced NPC activity.
   * Good for testing player-centric features.
   */
  quiet: {
    NPC_POST_PROBABILITY: '0.05',
    NPC_MAX_POSTS_PER_DAY: '1',
    NPC_TICK_BATCH_SIZE: '2',
    NPC_LIKE_PROBABILITY: '0.04',
    NPC_SHARE_PROBABILITY: '0.01',
    NPC_COMMENT_PROBABILITY: '0.005',
    NPC_TARGET_POSTS_PER_HOUR: '3',
    // Low trading - reduced NPC market activity
    NPC_TRADE_PROBABILITY: '0.2',
    NPC_MAX_TRADES_PER_DAY: '5',
    NPC_MIN_MINUTES_BETWEEN_TRADES: '15',
  },

  /**
   * Test preset - very high activity for automated testing.
   */
  test: {
    NPC_POST_PROBABILITY: '0.8',
    NPC_MAX_POSTS_PER_DAY: '20',
    NPC_MIN_HOURS_BETWEEN_POSTS: '0',
    NPC_TICK_BATCH_SIZE: '15',
    NPC_LIKE_PROBABILITY: '0.5',
    NPC_SHARE_PROBABILITY: '0.2',
    NPC_COMMENT_PROBABILITY: '0.1',
    NPC_TARGET_POSTS_PER_HOUR: '60',
    // Very high trading for automated testing
    NPC_TRADE_PROBABILITY: '0.9',
    NPC_MAX_TRADES_PER_DAY: '50',
    NPC_MIN_MINUTES_BETWEEN_TRADES: '0',
  },
} as const;

/**
 * Type alias for valid NPC activity preset names.
 * Provides compile-time autocomplete and type safety.
 */
export type NPCActivityPresetName = keyof typeof NPC_ACTIVITY_PRESETS;

/**
 * Get preset values by name.
 *
 * @param presetName - Name of the preset (typed for compile-time safety)
 * @returns Object with environment variable key-value pairs (frozen copy)
 */
export function getPreset(
  presetName: NPCActivityPresetName
): Record<string, string> {
  const preset = Object.prototype.hasOwnProperty.call(
    NPC_ACTIVITY_PRESETS,
    presetName
  )
    ? NPC_ACTIVITY_PRESETS[presetName as keyof typeof NPC_ACTIVITY_PRESETS]
    : undefined;

  if (!preset) {
    logger.warn(
      `Unknown preset "${presetName}", falling back to "default"`,
      { presetName },
      'npc-activity'
    );
    return Object.freeze({ ...NPC_ACTIVITY_PRESETS.default });
  }
  return Object.freeze({ ...preset });
}

/**
 * Log the current NPC activity configuration.
 * Useful for debugging and verifying environment variable overrides.
 */
export function logCurrentConfig(): void {
  logger.info('NPC Activity Configuration - Header', {}, 'npc-activity');
  logger.info(
    'NPC Activity Configuration - Posting',
    NPC_POSTING_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Trading',
    NPC_TRADING_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Engagement',
    NPC_ENGAGEMENT_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Diversity',
    NPC_DIVERSITY_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Social Actions',
    NPC_SOCIAL_ACTIONS_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Group Dynamics',
    NPC_GROUP_DYNAMICS_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Content Pacing',
    NPC_CONTENT_PACING_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Following',
    NPC_FOLLOWING_CONFIG,
    'npc-activity'
  );
  logger.info(
    'NPC Activity Configuration - Tick Processing',
    NPC_TICK_CONFIG,
    'npc-activity'
  );
  logger.info('NPC Activity Configuration - Footer', {}, 'npc-activity');
}

// =============================================================================
// TRADING CONFIGURATION GETTERS
// =============================================================================

/**
 * Get the base probability for an NPC to consider trading.
 *
 * @returns The trading probability (0.0 - 1.0)
 */
export function getTradingProbability(): number {
  return NPC_TRADING_CONFIG.baseProbability;
}

/**
 * Get the maximum number of trades per day per NPC.
 *
 * @returns The maximum trades per day
 */
export function getMaxTradesPerDay(): number {
  return NPC_TRADING_CONFIG.maxTradesPerDay;
}

/**
 * Get the minimum minutes between trades for the same NPC.
 *
 * @returns The minimum minutes between trades
 */
export function getMinMinutesBetweenTrades(): number {
  return NPC_TRADING_CONFIG.minMinutesBetweenTrades;
}
