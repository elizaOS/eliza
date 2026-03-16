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
 * Content limits
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
