/**
 * Rate Limiter for Moltbook API
 *
 * TWO LEVELS OF RATE LIMITING:
 *
 * 1. GLOBAL (IP-level) - Shared across ALL agents in this process
 *    WHY? Many agents from one IP could trigger Moltbook's IP-level blocks.
 *    We limit total requests to a safe global maximum.
 *
 * 2. PER-AGENT - Each agent has their own Moltbook account limits
 *    WHY? Moltbook tracks per-account rate limits (100 req/min, etc.)
 *    Each agent needs independent tracking.
 *
 * The global limiter is more conservative to ensure we don't get IP-banned
 * when running many agents from the same machine.
 */

import type { UUID } from "@elizaos/core";
import {
  GLOBAL_POSTS_PER_HOUR,
  GLOBAL_REQUESTS_PER_MIN,
  RATE_LIMIT_COMMENT_WINDOW_MS,
  RATE_LIMIT_COMMENTS_PER_HOUR,
  RATE_LIMIT_POST_INTERVAL_SEC,
  RATE_LIMIT_REQUEST_WINDOW_MS,
  RATE_LIMIT_REQUESTS_PER_MIN,
} from "../constants";
import type { AgentMoltbookState } from "../types";

// =============================================================================
// GLOBAL RATE LIMITING (IP-level protection)
// =============================================================================

/** Window for global request rate limiting (1 minute) */
const GLOBAL_REQUEST_WINDOW_MS = 60 * 1000;

/** Window for global post rate limiting (1 hour) */
const GLOBAL_POST_WINDOW_MS = 60 * 60 * 1000;

/** Global state shared across ALL agents */
interface GlobalRateLimitState {
  requests: { timestamp: number }[];
  posts: { timestamp: number }[];
  retryAfter?: number; // If Moltbook returns 429, ALL agents pause
}

const globalState: GlobalRateLimitState = {
  requests: [],
  posts: [],
};

/**
 * Check if we can make a request globally (IP-level)
 */
function canMakeGlobalRequest(): boolean {
  // Check global retry-after (if any agent got 429, all pause)
  if (globalState.retryAfter && Date.now() < globalState.retryAfter) {
    return false;
  }

  // Prune old requests
  const cutoff = Date.now() - GLOBAL_REQUEST_WINDOW_MS;
  globalState.requests = globalState.requests.filter((r) => r.timestamp > cutoff);

  return globalState.requests.length < GLOBAL_REQUESTS_PER_MIN;
}

/**
 * Check if we can post globally (IP-level)
 */
function canPostGlobally(): boolean {
  // Prune old posts
  const cutoff = Date.now() - GLOBAL_POST_WINDOW_MS;
  globalState.posts = globalState.posts.filter((p) => p.timestamp > cutoff);

  return globalState.posts.length < GLOBAL_POSTS_PER_HOUR;
}

/**
 * Record a global request
 */
function recordGlobalRequest(): void {
  globalState.requests.push({ timestamp: Date.now() });
}

/**
 * Record a global post
 */
function recordGlobalPost(): void {
  globalState.posts.push({ timestamp: Date.now() });
}

/**
 * Set global retry-after (affects ALL agents)
 */
export function setGlobalRetryAfter(retryAfterSeconds: number): void {
  globalState.retryAfter = Date.now() + retryAfterSeconds * 1000;
}

/**
 * Get global rate limit status
 */
export function getGlobalRateLimitStatus(): {
  canRequest: boolean;
  canPost: boolean;
  requestsUsed: number;
  requestsMax: number;
  postsUsed: number;
  postsMax: number;
  retryAfter?: number;
} {
  // Prune old entries
  const requestCutoff = Date.now() - GLOBAL_REQUEST_WINDOW_MS;
  const postCutoff = Date.now() - GLOBAL_POST_WINDOW_MS;
  globalState.requests = globalState.requests.filter((r) => r.timestamp > requestCutoff);
  globalState.posts = globalState.posts.filter((p) => p.timestamp > postCutoff);

  return {
    canRequest: canMakeGlobalRequest(),
    canPost: canPostGlobally(),
    requestsUsed: globalState.requests.length,
    requestsMax: GLOBAL_REQUESTS_PER_MIN,
    postsUsed: globalState.posts.length,
    postsMax: GLOBAL_POSTS_PER_HOUR,
    retryAfter: globalState.retryAfter,
  };
}

// =============================================================================
// PER-AGENT RATE LIMITING
// =============================================================================

/**
 * Per-agent state storage
 * Key: agentId, Value: agent's Moltbook state
 */
const agentStates = new Map<UUID, AgentMoltbookState>();

/**
 * Get or create state for an agent
 */
export function getAgentState(agentId: UUID): AgentMoltbookState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = {
      rateLimits: {
        requests: [],
        posts: [],
        comments: [],
      },
    };
    agentStates.set(agentId, state);
  }
  return state;
}

/**
 * Clean up old entries from rate limit arrays
 */
function pruneOldEntries(
  entries: { timestamp: number }[],
  windowMs: number
): { timestamp: number }[] {
  const cutoff = Date.now() - windowMs;
  return entries.filter((e) => e.timestamp > cutoff);
}

/**
 * Check if we can make a general API request
 *
 * Checks BOTH global (IP-level) and per-agent limits.
 * Both must allow the request for it to proceed.
 */
export function canMakeRequest(agentId: UUID): boolean {
  // FIRST: Check global (IP-level) limits
  if (!canMakeGlobalRequest()) {
    return false;
  }

  // THEN: Check per-agent limits
  const state = getAgentState(agentId);

  // Check agent-specific retry-after header
  if (state.rateLimits.retryAfter && Date.now() < state.rateLimits.retryAfter) {
    return false;
  }

  // Prune old requests
  state.rateLimits.requests = pruneOldEntries(
    state.rateLimits.requests,
    RATE_LIMIT_REQUEST_WINDOW_MS
  );

  return state.rateLimits.requests.length < RATE_LIMIT_REQUESTS_PER_MIN;
}

/**
 * Record a request was made
 *
 * Records in BOTH global and per-agent tracking.
 */
export function recordRequest(agentId: UUID): void {
  // Record globally
  recordGlobalRequest();

  // Record per-agent
  const state = getAgentState(agentId);
  state.rateLimits.requests.push({ timestamp: Date.now() });
}

/**
 * Set retry-after from server response
 *
 * Sets for the specific agent, AND globally if it's a 429.
 * WHY globally? A 429 often indicates IP-level throttling,
 * so ALL agents should back off.
 */
export function setRetryAfter(agentId: UUID, retryAfterSeconds: number): void {
  // Set for this agent
  const state = getAgentState(agentId);
  state.rateLimits.retryAfter = Date.now() + retryAfterSeconds * 1000;

  // ALSO set globally - if one agent gets 429, all should pause
  // This protects against IP-level bans
  setGlobalRetryAfter(retryAfterSeconds);
}

/**
 * Check if we can make a post
 *
 * Checks BOTH global and per-agent post limits.
 */
export function canPost(agentId: UUID): boolean {
  // FIRST: Check if requests are allowed at all
  if (!canMakeRequest(agentId)) return false;

  // SECOND: Check global post limit (IP-level)
  if (!canPostGlobally()) return false;

  // THIRD: Check per-agent post limit
  const state = getAgentState(agentId);

  // Get the most recent post
  const lastPost = state.rateLimits.posts[state.rateLimits.posts.length - 1];
  if (lastPost) {
    const timeSinceLastPost = Date.now() - lastPost.timestamp;
    if (timeSinceLastPost < RATE_LIMIT_POST_INTERVAL_SEC * 1000) {
      return false;
    }
  }

  return true;
}

/**
 * Record a post was made
 *
 * Records in BOTH global and per-agent tracking.
 */
export function recordPost(agentId: UUID): void {
  // Record globally
  recordGlobalPost();

  // Record per-agent
  const state = getAgentState(agentId);
  state.rateLimits.posts.push({ timestamp: Date.now() });
  recordRequest(agentId);
}

/**
 * Get time until next post is allowed (in ms)
 */
export function getTimeUntilCanPost(agentId: UUID): number {
  const state = getAgentState(agentId);
  const lastPost = state.rateLimits.posts[state.rateLimits.posts.length - 1];

  if (!lastPost) return 0;

  const elapsed = Date.now() - lastPost.timestamp;
  const required = RATE_LIMIT_POST_INTERVAL_SEC * 1000;

  return Math.max(0, required - elapsed);
}

/**
 * Check if we can make a comment
 */
export function canComment(agentId: UUID): boolean {
  if (!canMakeRequest(agentId)) return false;

  const state = getAgentState(agentId);

  // Prune old comments
  state.rateLimits.comments = pruneOldEntries(
    state.rateLimits.comments,
    RATE_LIMIT_COMMENT_WINDOW_MS
  );

  return state.rateLimits.comments.length < RATE_LIMIT_COMMENTS_PER_HOUR;
}

/**
 * Record a comment was made
 */
export function recordComment(agentId: UUID): void {
  const state = getAgentState(agentId);
  state.rateLimits.comments.push({ timestamp: Date.now() });
  recordRequest(agentId);
}

/**
 * Get remaining comment quota
 */
export function getRemainingComments(agentId: UUID): number {
  const state = getAgentState(agentId);

  // Prune old comments
  state.rateLimits.comments = pruneOldEntries(
    state.rateLimits.comments,
    RATE_LIMIT_COMMENT_WINDOW_MS
  );

  return RATE_LIMIT_COMMENTS_PER_HOUR - state.rateLimits.comments.length;
}

/**
 * Get rate limit status summary for an agent
 */
export function getRateLimitStatus(agentId: UUID): {
  canRequest: boolean;
  canPost: boolean;
  canComment: boolean;
  requestsRemaining: number;
  commentsRemaining: number;
  timeUntilCanPost: number;
  retryAfter?: number;
} {
  const state = getAgentState(agentId);

  // Prune old entries
  state.rateLimits.requests = pruneOldEntries(
    state.rateLimits.requests,
    RATE_LIMIT_REQUEST_WINDOW_MS
  );
  state.rateLimits.comments = pruneOldEntries(
    state.rateLimits.comments,
    RATE_LIMIT_COMMENT_WINDOW_MS
  );

  return {
    canRequest: canMakeRequest(agentId),
    canPost: canPost(agentId),
    canComment: canComment(agentId),
    requestsRemaining: RATE_LIMIT_REQUESTS_PER_MIN - state.rateLimits.requests.length,
    commentsRemaining: RATE_LIMIT_COMMENTS_PER_HOUR - state.rateLimits.comments.length,
    timeUntilCanPost: getTimeUntilCanPost(agentId),
    retryAfter: state.rateLimits.retryAfter,
  };
}

/**
 * Clear all state for an agent (useful for testing)
 */
export function clearAgentState(agentId: UUID): void {
  agentStates.delete(agentId);
}

/**
 * Clear all agent states (useful for testing)
 */
export function clearAllStates(): void {
  agentStates.clear();
}
