/**
 * Shared constants for the web app
 */

/**
 * Maximum reply count to display before showing "X+"
 * Used for efficient BFS counting in deeply nested comment threads
 */
export const MAX_REPLY_COUNT = 99;

/**
 * Number of messages to load per page in chat
 * Used for initial load and infinite scroll pagination
 */
export const CHAT_PAGE_SIZE = 50;

/**
 * Points cost per message for each model tier
 * Used in agent chat API and settings UI
 */
export const MODEL_TIER_POINTS_COST = {
  free: 0,
  pro: 1,
} as const;
