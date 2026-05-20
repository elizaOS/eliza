/**
 * Shared Constants for Feed Game
 *
 * Centralized constants to eliminate magic strings across codebase
 */

/**
 * Actor tier levels (influence and prominence)
 */
export const ACTOR_TIERS = {
  S_TIER: 'S_TIER',
  A_TIER: 'A_TIER',
  B_TIER: 'B_TIER',
  C_TIER: 'C_TIER',
} as const;

/**
 * ActorTier type is exported from @feed/shared/types to avoid duplication
 */

/**
 * Feed Widget Configuration
 * These thresholds are used for determining what qualifies as breaking news or upcoming events
 */
export const FEED_WIDGET_CONFIG = {
  // Breaking News thresholds
  TRENDING_HOURS: 4, // Hours before an event is considered "trending"
  PRICE_TRENDING_HOURS: 2, // Hours before a price update is considered "trending"
  SIGNIFICANT_PRICE_CHANGE_PERCENT: 2, // Minimum % change to be considered significant
  MIN_PRICE_CHANGE_PERCENT: 0.5, // Minimum % change for any price update to show
  ATH_THRESHOLD_PERCENT: 2, // Minimum % change to qualify as ATH

  // Upcoming Events thresholds
  UPCOMING_EVENTS_DAYS: 7, // Days ahead to show upcoming events
  LIVE_EVENT_HOURS: 2, // Hours before event to mark as "LIVE"
  HINT_SHOW_DAYS: 1, // Days before event to show hint

  // Display limits
  MAX_BREAKING_NEWS_ITEMS: 3,
  MAX_UPCOMING_EVENTS: 3,
  MAX_WORLD_EVENTS_QUERY: 100,
  MAX_PRICE_UPDATES_QUERY: 50,
  MAX_POSTS_QUERY: 100,
} as const;

/**
 * Feed post types
 */
export const POST_TYPES = {
  WORLD_EVENT: 'world_event',
  REACTION: 'reaction',
  NEWS: 'news',
  THREAD: 'thread',
  RUMOR: 'rumor',
  POST: 'post',
  REPLY: 'reply',
  ARTICLE: 'article',
} as const;

/**
 * PostType is exported from @feed/shared/types to avoid duplication
 */

/**
 * Day ranges for escalation rules
 * Content gets progressively more chaotic as the game progresses
 */
export const DAY_RANGES = {
  EARLY: { min: 1, max: 10 }, // Days 1-10: Setup, introductions
  MID: { min: 11, max: 20 }, // Days 11-20: Rising action
  LATE: { min: 21, max: 30 }, // Days 21-30: Peak chaos
} as const;

/**
 * Organization types
 */
export const ORG_TYPES = {
  TECH_COMPANY: 'tech_company',
  MEDIA_OUTLET: 'media_outlet',
  GOVERNMENT: 'government',
  NONPROFIT: 'nonprofit',
  CRYPTO: 'crypto',
} as const;

export type OrgType = (typeof ORG_TYPES)[keyof typeof ORG_TYPES];

/**
 * Actor selection counts for game generation
 */
export const ACTOR_COUNTS = {
  MAIN: 3,
  SUPPORTING: 15,
  EXTRAS: 50,
} as const;

/**
 * Scenario and question counts
 */
export const GAME_STRUCTURE = {
  SCENARIOS: 3,
  QUESTIONS_PER_SCENARIO: 1,
  DAYS: 30,
} as const;

/**
 * Feed generation targets
 */
export const FEED_TARGETS = {
  MIN_POSTS: 300,
  MAX_POSTS: 500,
  MIN_GROUP_MESSAGES: 100,
  MAX_GROUP_MESSAGES: 200,
} as const;

/**
 * Canonical balance transaction types for peer-to-peer trading balance transfers.
 */
export const PEER_TRANSFER_IN_TRANSACTION_TYPE = 'peer_transfer_in';
export const PEER_TRANSFER_OUT_TRANSACTION_TYPE = 'peer_transfer_out';
export const CANONICAL_PEER_TRANSFER_TRANSACTION_TYPES = [
  PEER_TRANSFER_IN_TRANSACTION_TYPE,
  PEER_TRANSFER_OUT_TRANSACTION_TYPE,
] as const;

/**
 * Canonical balance transaction types for agent-initiated trading balance sends.
 *
 * These remain distinct from peer user transfers so wallet/team capital-base
 * semantics can evolve independently from autonomous agent payout behavior.
 */
export const AGENT_TRANSFER_IN_TRANSACTION_TYPE = 'agent_transfer_in';
export const AGENT_TRANSFER_OUT_TRANSACTION_TYPE = 'agent_transfer_out';
export const CANONICAL_AGENT_TRANSFER_TRANSACTION_TYPES = [
  AGENT_TRANSFER_IN_TRANSACTION_TYPE,
  AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
] as const;

/**
 * Escalation rules for content intensity
 * Controls how wild content can get based on day number
 */
export function getEscalationLevel(
  day: number
): 'mild' | 'moderate' | 'intense' {
  if (day <= DAY_RANGES.EARLY.max) return 'mild';
  if (day <= DAY_RANGES.MID.max) return 'moderate';
  return 'intense';
}

/**
 * Relationship types between actors
 */
export const RELATIONSHIP_TYPES = {
  // Hierarchical
  MENTOR_STUDENT: 'mentor-student',
  INDUSTRY_LEADER_FOLLOWER: 'industry-leader-follower',
  INFLUENCER_FAN: 'influencer-fan',
  // Collaborative
  ALLIES: 'allies',
  COLLABORATORS: 'collaborators',
  CO_FOUNDERS: 'co-founders',
  BUSINESS_PARTNERS: 'business-partners',
  // Competitive
  RIVALS: 'rivals',
  COMPETITORS: 'competitors',
  FRENEMIES: 'frenemies',
  // Critical
  CRITIC_SUBJECT: 'critic-subject',
  WATCHDOG_TARGET: 'watchdog-target',
  REGULATOR_REGULATED: 'regulator-regulated',
  // Social
  FRIENDS: 'friends',
  ACQUAINTANCES: 'acquaintances',
  FORMER_COLLEAGUES: 'former-colleagues',
} as const;

/**
 * Group chat configuration
 * Controls group participation limits
 *
 * With the tiered group system, users get:
 * - 3 default Tier 3 groups on signup (Followers)
 * - Can earn invites to higher tiers through engagement
 * - MAX_ACTIVE_USER_GROUPS includes both default and invited groups
 */
/** Helper to safely parse int from env var with fallback */
function parseEnvInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const GROUP_CONFIG = {
  /**
   * Max NPC groups a user can be in simultaneously (env: MAX_ACTIVE_USER_GROUPS)
   * Note: User-created groups don't count toward this limit
   *
   * Set to 10 to accommodate:
   * - 3 default Tier 3 groups (assigned on signup)
   * - Up to 7 additional invites earned through engagement
   */
  MAX_ACTIVE_USER_GROUPS: parseEnvInt(process.env.MAX_ACTIVE_USER_GROUPS, 10),
  /**
   * Minimum number of default NPC groups to assign on signup.
   * Users get this many Tier 3 groups automatically.
   */
  MIN_DEFAULT_GROUPS: parseEnvInt(process.env.MIN_DEFAULT_GROUPS, 3),
  /** Min members for NPC group */
  MIN_GROUP_SIZE: 3,
  /** Max members for Tier 1 groups (Inner Circle) */
  MAX_GROUP_SIZE: 12,
  /** Ideal NPC group size */
  IDEAL_GROUP_SIZE: 7,
  /** Hours after joining before next invite eligible */
  INVITE_COOLDOWN_HOURS: 4,
  /** UI warning threshold for group member count (soft cap, not enforced) */
  MEMBER_WARNING_THRESHOLD: 100,
} as const;
