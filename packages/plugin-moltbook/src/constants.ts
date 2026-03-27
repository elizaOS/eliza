/**
 * Moltbook Plugin Constants
 *
 * WHY CENTRALIZE CONSTANTS?
 *
 * 1. **Single Source of Truth**: All magic numbers in one place.
 *    When Moltbook changes their API limits, we update one file.
 *
 * 2. **Documentation**: Constants have comments explaining WHY they exist.
 *    New developers understand the reasoning, not just the values.
 *
 * 3. **Type Safety**: Exported as const ensures TypeScript knows the exact values.
 *    Prevents typos in string literals across the codebase.
 *
 * 4. **Easy Configuration**: All tunables are visible and adjustable.
 *    Want longer cache? Change CACHE_TTL_FEED_MS here.
 */

// =============================================================================
// API CONFIGURATION
// =============================================================================

/**
 * Base URL for the Moltbook API
 *
 * IMPORTANT: Must use www.moltbook.com!
 *
 * WHY? Without "www", the server redirects to www.moltbook.com.
 * HTTP redirects (302/301) strip the Authorization header for security.
 * Result: API calls fail with 401 Unauthorized.
 *
 * Always use the canonical URL to avoid redirect-related auth issues.
 */
export const MOLTBOOK_API_URL = "https://www.moltbook.com/api/v1";

/**
 * API endpoints - based on https://www.moltbook.com/skill.md
 *
 * WHY centralize endpoints?
 * - Easy to update when API changes
 * - Prevents typos across multiple files
 * - Functions (name => `/agents/${name}`) handle URL encoding automatically
 *
 * NOTE: All endpoints are relative to MOLTBOOK_API_URL.
 * The api.ts request() function prepends the base URL.
 */
export const ENDPOINTS = {
  // -------------------------------------------------------------------------
  // AUTHENTICATION / AGENT MANAGEMENT
  // -------------------------------------------------------------------------

  /** POST: Register a new agent. Body: { name, description } */
  REGISTER: "/agents/register",

  /** GET: Get authenticated agent's profile. Requires API key. */
  ME: "/agents/me",

  /** GET: Check agent's claim status (pending_claim or claimed) */
  STATUS: "/agents/status",

  /** GET: Get any agent's public profile by name */
  AGENT_PROFILE: (name: string) => `/agents/profile?name=${encodeURIComponent(name)}`,

  /** POST/DELETE: Follow or unfollow an agent */
  AGENT_FOLLOW: (name: string) => `/agents/${encodeURIComponent(name)}/follow`,

  // -------------------------------------------------------------------------
  // POSTS
  // -------------------------------------------------------------------------

  /** GET: Personalized feed for authenticated agent */
  FEED: "/feed",

  /** GET/POST: List posts or create new post */
  POSTS: "/posts",

  /** GET/DELETE: Get or delete a specific post */
  POST_BY_ID: (id: string) => `/posts/${id}`,

  // -------------------------------------------------------------------------
  // COMMENTS
  // -------------------------------------------------------------------------

  /** GET/POST: Get comments on a post or add new comment */
  COMMENTS: (postId: string) => `/posts/${postId}/comments`,

  // -------------------------------------------------------------------------
  // VOTING
  // WHY separate endpoints for up/down? Moltbook API design choice.
  // Voting twice in same direction = no-op, opposite direction = changes vote.
  // -------------------------------------------------------------------------

  /** POST: Upvote a post */
  UPVOTE: (postId: string) => `/posts/${postId}/upvote`,

  /** POST: Downvote a post */
  DOWNVOTE: (postId: string) => `/posts/${postId}/downvote`,

  /** POST: Upvote a comment */
  COMMENT_UPVOTE: (commentId: string) => `/comments/${commentId}/upvote`,

  /** POST: Downvote a comment */
  COMMENT_DOWNVOTE: (commentId: string) => `/comments/${commentId}/downvote`,

  // -------------------------------------------------------------------------
  // SUBMOLTS (communities/subreddits)
  // -------------------------------------------------------------------------

  /** GET: List all submolts */
  SUBMOLTS: "/submolts",

  /** GET: Get specific submolt by name */
  SUBMOLT_BY_NAME: (name: string) => `/submolts/${name}`,

  /** GET: Get feed for a specific submolt */
  SUBMOLT_FEED: (name: string) => `/submolts/${name}/feed`,

  /** POST/DELETE: Subscribe or unsubscribe from submolt */
  SUBMOLT_SUBSCRIBE: (name: string) => `/submolts/${name}/subscribe`,

  // -------------------------------------------------------------------------
  // SEARCH
  // -------------------------------------------------------------------------

  /** GET: Semantic AI-powered search. Query params: q, type (posts|comments|all) */
  SEARCH: "/search",
} as const;

// =============================================================================
// RATE LIMITS (per Moltbook API docs)
// =============================================================================
//
// TWO LEVELS OF RATE LIMITING:
//
// 1. **GLOBAL (IP-level)**: Shared across ALL agents in this process
//    WHY? Many agents from one IP could trigger Moltbook's IP-level blocks.
//    Even if each agent is under their per-account limit, the IP could get banned.
//
// 2. **PER-AGENT (Account-level)**: Each agent has their own Moltbook account
//    These match Moltbook's documented per-account limits.
//
// The global limiter is MORE CONSERVATIVE to protect the shared IP.
// =============================================================================

// -----------------------------------------------------------------------------
// GLOBAL LIMITS (IP-level, shared across all agents)
// -----------------------------------------------------------------------------

/**
 * Maximum total API requests per minute from this IP/process
 * WHY 200? Conservative for shared IP. 20 agents = 10 req/min each.
 */
export const GLOBAL_REQUESTS_PER_MIN = 200;

/**
 * Maximum total posts per hour from this IP/process
 * WHY 20? Prevents one IP from flooding the site with posts.
 */
export const GLOBAL_POSTS_PER_HOUR = 20;

// -----------------------------------------------------------------------------
// PER-AGENT LIMITS (Account-level, per Moltbook API docs)
// -----------------------------------------------------------------------------

/** Maximum API requests per minute (general rate limit) */
export const RATE_LIMIT_REQUESTS_PER_MIN = 100;

/**
 * Minimum seconds between posts
 *
 * WHY 30 MINUTES? Moltbook wants quality over quantity.
 * This limit encourages agents to make thoughtful posts rather than spamming.
 * 30 minutes = ~48 posts/day max, which is plenty for meaningful participation.
 */
export const RATE_LIMIT_POST_INTERVAL_SEC = 30 * 60; // 30 minutes = 1800 seconds

/**
 * Maximum comments per hour
 *
 * WHY 50/hour? Allows active engagement without flooding discussions.
 * That's nearly 1 comment per minute - generous for quality responses.
 */
export const RATE_LIMIT_COMMENTS_PER_HOUR = 50;

/** Rate limit window for general requests (1 minute in ms) */
export const RATE_LIMIT_REQUEST_WINDOW_MS = 60 * 1000;

/** Rate limit window for comments (1 hour in ms) */
export const RATE_LIMIT_COMMENT_WINDOW_MS = 60 * 60 * 1000;

// =============================================================================
// CACHE CONFIGURATION
// =============================================================================
//
// WHY CACHE?
//
// 1. **Reduce API Calls**: Moltbook has rate limits, caching reduces pressure
// 2. **Improve Latency**: Cached responses are instant
// 3. **Save Resources**: Fewer network requests = less CPU/bandwidth
//
// WHY THESE TTLs?
//
// - Feed (5m): Posts change frequently, but not every second
// - Profile (15m): Profile data changes rarely
// - Analysis (30m): Community patterns evolve slowly
//
// All caches include fetchedAt timestamp for freshness checks.
// Callers can use newerThan option to require fresher data.
// =============================================================================

/** Default cache TTL for feed data (5 minutes) */
export const CACHE_TTL_FEED_MS = 5 * 60 * 1000;

/** Default cache TTL for profile data (15 minutes) */
export const CACHE_TTL_PROFILE_MS = 15 * 60 * 1000;

/** Default cache TTL for community analysis (30 minutes) */
export const CACHE_TTL_ANALYSIS_MS = 30 * 60 * 1000;

// =============================================================================
// QUALITY THRESHOLDS
// =============================================================================
//
// WHY QUALITY GATES?
//
// Every post reflects on elizaOS. Bad posts hurt:
// - The community (noise, spam)
// - The agent's reputation (unfollows)
// - elizaOS's reputation (platform perception)
//
// The quality gate ensures content meets a bar before publishing.
// Posts are judged on: relevance, interestingness, originality, voice, value.
//
// WHY DIFFERENT THRESHOLDS?
//
// - Autonomous (7/10): Agent chooses to post - higher bar
// - User-requested (5/10): Human asked for this - lower bar, trust user intent
//
// =============================================================================

/**
 * Minimum score (1-10) for autonomous posting
 *
 * WHY 7? High enough to filter mediocre content, low enough to not block
 * everything. Agents posting autonomously have no human oversight -
 * the quality gate IS the oversight.
 */
export const MIN_QUALITY_SCORE_AUTONOMOUS = 7;

/**
 * Minimum score for user-requested posting
 *
 * WHY 5? When a human explicitly asks to post, we trust their judgment
 * more. Still catch truly bad content, but give benefit of doubt.
 */
export const MIN_QUALITY_SCORE_USER = 5;

/**
 * Maximum composition retries before giving up
 *
 * WHY 3? Diminishing returns after a few attempts. If we can't generate
 * good content in 3 tries, better to skip than keep burning tokens.
 */
export const MAX_COMPOSE_RETRIES = 3;

// =============================================================================
// TASK CONFIGURATION
// =============================================================================
//
// WHY BACKGROUND TASKS?
//
// Agents should participate naturally without constant human prompting.
// The cycle task runs periodically to:
// - Refresh community context
// - Find engagement opportunities
// - Maybe post or comment (if auto-engage enabled)
//
// =============================================================================

/** Task name for the periodic cycle */
export const MOLTBOOK_CYCLE_TASK = "MOLTBOOK_CYCLE";

/**
 * Default cycle interval (15 minutes)
 *
 * WHY 15 MINUTES? Frequent enough to stay current, infrequent enough to
 * not waste resources. Community context doesn't change faster than this.
 */
export const CYCLE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Minimum time between autonomous posts (1 hour)
 *
 * WHY 1 HOUR? Even if API allows posting every 30 minutes, an agent posting
 * every 30 minutes feels spammy. 1 hour gap feels more natural and human-like.
 */
export const MIN_AUTONOMOUS_POST_INTERVAL_MS = 60 * 60 * 1000;

// =============================================================================
// MEMORY KEYS
// =============================================================================
//
// WHY DETERMINISTIC KEYS?
//
// Using createUniqueUuid(runtime, key) generates a deterministic UUID based on
// the agent ID + key. This means:
// - Same agent always gets same UUID for "moltbook_creds"
// - Different agents get different UUIDs (isolated storage)
// - We can reliably retrieve data without scanning all memories
//
// =============================================================================

/** Key prefix for credential memory */
export const CRED_MEMORY_KEY = "moltbook_creds";

/** Key prefix for community analysis memory */
export const COMMUNITY_ANALYSIS_KEY = "moltbook_community_analysis";

// =============================================================================
// HTTP CONFIGURATION
// =============================================================================

/**
 * Request timeout in milliseconds
 *
 * WHY 30 SECONDS? Long enough for slow responses, short enough to fail fast
 * on hung connections. Moltbook should respond in <5s normally.
 */
export const HTTP_TIMEOUT_MS = 30 * 1000;

/**
 * Maximum retries for failed requests
 *
 * WHY 3? Handles transient failures (network blips, 503s) without
 * excessive hammering on persistent failures.
 */
export const HTTP_MAX_RETRIES = 3;

/**
 * Base delay for exponential backoff (ms)
 *
 * Retry delays: 1s, 2s, 4s (exponential backoff)
 * WHY EXPONENTIAL? Gives server time to recover while being responsive.
 */
export const HTTP_RETRY_BASE_DELAY_MS = 1000;

// =============================================================================
// CONTENT LIMITS (per Moltbook API)
// =============================================================================

/** Maximum title length */
export const MAX_TITLE_LENGTH = 300;

/** Maximum post content length (40KB is generous for text) */
export const MAX_POST_LENGTH = 40000;

/** Maximum comment length */
export const MAX_COMMENT_LENGTH = 10000;

// =============================================================================
// PLUGIN METADATA
// =============================================================================

/**
 * Plugin name - used for service registration and logging.
 * Must be unique across all plugins.
 */
export const PLUGIN_NAME = "moltbook";

/** Plugin description shown in agent capabilities */
export const PLUGIN_DESCRIPTION =
  "Moltbook social integration - community participation for AI agents";

// =============================================================================
// NEW: Constants from next branch for enhanced functionality
// =============================================================================

/**
 * Service name for registration
 */
export const MOLTBOOK_SERVICE_NAME = "moltbook";

/**
 * External service URLs
 */
export const URLS = {
  moltbook: "https://www.moltbook.com/api/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;

/**
 * Default autonomy settings
 */
export const AUTONOMY_DEFAULTS = {
  /** Interval between autonomy cycles (30-90 seconds random) */
  minIntervalMs: 30000,
  maxIntervalMs: 90000,
  /** Maximum tool calls per cycle */
  maxToolCalls: 5,
  /** Default LLM model */
  defaultModel: "deepseek/deepseek-chat-v3-0324",
} as const;

/**
 * Content limits (for new API compatibility)
 */
export const CONTENT_LIMITS = {
  /** Default number of posts to browse */
  defaultBrowseLimit: 10,
  /** Maximum post content length */
  maxContentLength: 10000,
  /** Maximum title length */
  maxTitleLength: 300,
  /** Maximum comment length */
  maxCommentLength: 5000,
} as const;

/**
 * Default submolt (subreddit equivalent)
 */
export const DEFAULT_SUBMOLT = "iq";
