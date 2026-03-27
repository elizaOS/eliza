/**
 * Moltbook API Client
 *
 * HTTP client with per-agent rate limiting, retry logic, and error handling.
 *
 * WHY LOGGER PARAMETER?
 * All public functions accept an optional logger parameter. When called from
 * service.ts (which has runtime), we pass runtime.logger for agent-scoped
 * logging. This makes logs include agent ID and other context, crucial for
 * debugging multi-agent deployments.
 *
 * The standalone `logger` is only used as a fallback for internal functions
 * or when no runtime logger is available.
 */

import type { UUID } from "@elizaos/core";
import { logger as coreLogger } from "@elizaos/core";
import {
  ENDPOINTS,
  HTTP_MAX_RETRIES,
  HTTP_RETRY_BASE_DELAY_MS,
  HTTP_TIMEOUT_MS,
  MOLTBOOK_API_URL,
} from "../constants";
import type {
  MoltbookComment,
  MoltbookFeed,
  MoltbookPost,
  MoltbookProfile,
  MoltbookSearchResults,
  MoltbookSubmolt,
} from "../types";
import {
  canComment,
  canMakeRequest,
  canPost,
  recordComment,
  recordPost,
  recordRequest,
  setRetryAfter,
} from "./rateLimiter";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Logger interface - uses 'any' for compatibility with both runtime.logger
 * and standalone logger from @elizaos/core.
 *
 * WHY 'any'? The core logger has complex overloaded types (LogFn) that
 * don't easily simplify to a single signature. Using 'any' allows both
 * logger types to work without TypeScript errors.
 */
interface Logger {
  debug: (obj: any, msg?: string) => void;
  info: (obj: any, msg?: string) => void;
  warn: (obj: any, msg?: string) => void;
  error: (obj: any, msg?: string) => void;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
  skipRateLimit?: boolean;
  /** Logger to use - defaults to core logger if not provided */
  logger?: Logger;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an HTTP request with retries and rate limiting
 */
async function request<T>(
  agentId: UUID,
  endpoint: string,
  apiKey: string | undefined,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const {
    method = "GET",
    body,
    headers = {},
    skipRateLimit = false,
    logger = coreLogger,
  } = options;

  // Check rate limits (unless skipped for auth endpoints)
  if (!skipRateLimit && !canMakeRequest(agentId)) {
    logger.warn({ agentId, endpoint, method }, "Moltbook API: Rate limited locally");
    return {
      success: false,
      error: "Rate limited - too many requests",
      status: 429,
    };
  }

  const url = `${MOLTBOOK_API_URL}${endpoint}`;
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "elizaOS-moltbook-plugin/1.0",
    ...headers,
  };

  if (apiKey) {
    requestHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  // Debug: Log request details
  logger.debug(
    {
      url,
      method,
      hasBody: !!body,
      hasAuth: !!apiKey,
      endpoint,
    },
    "Moltbook API: Making request"
  );

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < HTTP_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      logger.debug(
        { url, method, attempt, body: body ? JSON.stringify(body).slice(0, 200) : null },
        "Moltbook API: Fetching"
      );

      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Debug: Log response status
      logger.debug(
        {
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
        },
        "Moltbook API: Response received"
      );

      // Record the request for rate limiting
      if (!skipRateLimit) {
        recordRequest(agentId);
      }

      // Handle rate limit response
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        logger.warn({ url, retryAfter }, "Moltbook API: Rate limited by server");
        if (retryAfter) {
          setRetryAfter(agentId, parseInt(retryAfter, 10));
        }
        return {
          success: false,
          error: "Rate limited by server",
          status: 429,
        };
      }

      // Handle other error statuses
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Unknown error");
        logger.error(
          {
            url,
            method,
            status: response.status,
            statusText: response.statusText,
            errorBody: errorBody.slice(0, 500),
          },
          "Moltbook API: Request failed"
        );
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorBody}`,
          status: response.status,
        };
      }

      // Parse successful response
      const responseText = await response.text();
      logger.debug({ url, responseLength: responseText.length }, "Moltbook API: Parsing response");

      let data: T;
      try {
        data = JSON.parse(responseText) as T;
      } catch (parseError) {
        logger.error(
          { url, responseText: responseText.slice(0, 500), parseError },
          "Moltbook API: Failed to parse JSON response"
        );
        return {
          success: false,
          error: `Failed to parse response: ${responseText.slice(0, 100)}`,
          status: response.status,
        };
      }

      logger.debug({ url, method, status: response.status }, "Moltbook API: Request successful");

      return {
        success: true,
        data,
        status: response.status,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.error(
        {
          url,
          method,
          attempt,
          errorName: lastError.name,
          errorMessage: lastError.message,
        },
        "Moltbook API: Request exception"
      );

      // Don't retry on abort (timeout)
      if (lastError.name === "AbortError") {
        logger.warn({ url }, "Moltbook API: Request timeout");
        return {
          success: false,
          error: "Request timeout",
          status: 408,
        };
      }

      // Exponential backoff for retries
      if (attempt < HTTP_MAX_RETRIES - 1) {
        const delay = HTTP_RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.debug({ attempt, delay, error: lastError.message }, "Moltbook API: Retrying");
        await sleep(delay);
      }
    }
  }

  logger.error({ url, method, error: lastError?.message }, "Moltbook API: All retries exhausted");

  return {
    success: false,
    error: lastError?.message || "Request failed after retries",
    status: 0,
  };
}

// =============================================================================
// AUTH API
// =============================================================================

/**
 * Register a new Moltbook account for an agent
 */
/**
 * Registration response from Moltbook API
 */
interface RegisterResponse {
  agent: {
    api_key: string;
    claim_url: string;
    verification_code: string;
  };
  important: string;
}

/**
 * Register a new Moltbook agent account
 * Per skill.md: POST /agents/register with {name, description}
 */
export async function register(
  agentId: UUID,
  name: string,
  description?: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ apiKey: string; claimUrl: string; verificationCode: string }>> {
  logger.info(
    {
      name,
      description: description?.slice(0, 50),
      apiUrl: MOLTBOOK_API_URL,
      endpoint: ENDPOINTS.REGISTER,
      fullUrl: `${MOLTBOOK_API_URL}${ENDPOINTS.REGISTER}`,
    },
    "Moltbook: Attempting to register new agent"
  );

  const result = await request<RegisterResponse>(agentId, ENDPOINTS.REGISTER, undefined, {
    method: "POST",
    body: { name, description: description || `elizaOS agent: ${name}` },
    skipRateLimit: true,
    logger,
  });

  if (result.success && result.data?.agent) {
    logger.info(
      {
        name,
        claimUrl: result.data.agent.claim_url,
        verificationCode: result.data.agent.verification_code,
      },
      "Moltbook: Registration successful - SAVE YOUR API KEY!"
    );

    return {
      success: true,
      data: {
        apiKey: result.data.agent.api_key,
        claimUrl: result.data.agent.claim_url,
        verificationCode: result.data.agent.verification_code,
      },
      status: result.status,
    };
  } else {
    logger.error(
      {
        name,
        error: result.error,
        status: result.status,
        fullUrl: `${MOLTBOOK_API_URL}${ENDPOINTS.REGISTER}`,
        responseData: result.data,
      },
      "Moltbook: Registration failed"
    );

    return {
      success: false,
      error: result.error,
      status: result.status,
    };
  }
}

/**
 * Agent profile from /agents/me
 */
interface AgentMeResponse {
  success: boolean;
  agent: {
    name: string;
    description: string;
    karma: number;
    follower_count: number;
    following_count: number;
    is_claimed: boolean;
    is_active: boolean;
    created_at: string;
    last_active: string;
  };
}

/**
 * Validate an API key by fetching the agent's profile
 * Per API: GET /agents/me
 */
export async function validateKey(
  agentId: UUID,
  apiKey: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ valid: boolean; name: string; isClaimed: boolean }>> {
  logger.debug({ agentId }, "Moltbook: Validating API key via /agents/me");

  const result = await request<AgentMeResponse>(agentId, ENDPOINTS.ME, apiKey, {
    method: "GET",
    skipRateLimit: true,
    logger,
  });

  // Success case - agent is claimed and we got profile
  if (result.success && result.data?.agent) {
    return {
      success: true,
      data: {
        valid: true,
        name: result.data.agent.name,
        isClaimed: result.data.agent.is_claimed,
      },
      status: result.status,
    };
  }

  // Special case: 401 "not yet claimed" means the API key IS valid,
  // but the agent hasn't been claimed by a human yet
  // WHY? Moltbook returns 401 for unclaimed agents, not 200 with is_claimed=false
  if (result.status === 401 && result.error?.includes("not yet claimed")) {
    logger.debug("Moltbook: API key valid but agent not yet claimed");
    return {
      success: true, // Key IS valid!
      data: {
        valid: true,
        name: "", // We don't have the name from this response
        isClaimed: false, // Explicitly unclaimed
      },
      status: result.status,
    };
  }

  // Actual failure - invalid key or other error
  return {
    success: false,
    data: { valid: false, name: "", isClaimed: false },
    error: result.error,
    status: result.status,
  };
}

/**
 * Status response from /agents/status
 */
interface AgentStatusResponse {
  status: "pending_claim" | "claimed";
}

/**
 * Check claim status for an account
 * Per API: GET /agents/status
 */
export async function checkClaimStatus(
  agentId: UUID,
  apiKey: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ claimed: boolean; status: string }>> {
  logger.debug({ agentId }, "Moltbook: Checking claim status");

  const result = await request<AgentStatusResponse>(agentId, ENDPOINTS.STATUS, apiKey, {
    method: "GET",
    skipRateLimit: true,
    logger,
  });

  if (result.success && result.data) {
    return {
      success: true,
      data: {
        claimed: result.data.status === "claimed",
        status: result.data.status,
      },
      status: result.status,
    };
  }

  return {
    success: false,
    error: result.error,
    status: result.status,
  };
}

// =============================================================================
// FEED API
// =============================================================================

type SortOption = "hot" | "new" | "top" | "rising";

/**
 * Get the personalized feed (from subscribed submolts + followed moltys)
 * Per API: GET /feed?sort=hot&limit=25
 */
export async function getFeed(
  agentId: UUID,
  apiKey: string,
  options: { sort?: SortOption; limit?: number; logger?: Logger } = {}
): Promise<ApiResponse<MoltbookFeed>> {
  const { sort, limit, logger = coreLogger } = options;
  const params = new URLSearchParams();
  if (sort) params.set("sort", sort);
  if (limit) params.set("limit", String(limit));

  const query = params.toString();
  const endpoint = query ? `${ENDPOINTS.FEED}?${query}` : ENDPOINTS.FEED;

  return request(agentId, endpoint, apiKey, { logger });
}

/**
 * Get global posts (not personalized)
 * Per API: GET /posts?sort=hot&limit=25
 */
export async function getPosts(
  agentId: UUID,
  apiKey: string,
  options: { sort?: SortOption; submolt?: string; limit?: number; logger?: Logger } = {}
): Promise<ApiResponse<MoltbookFeed>> {
  const { sort, submolt, limit, logger = coreLogger } = options;
  const params = new URLSearchParams();
  if (sort) params.set("sort", sort);
  if (submolt) params.set("submolt", submolt);
  if (limit) params.set("limit", String(limit));

  const query = params.toString();
  const endpoint = query ? `${ENDPOINTS.POSTS}?${query}` : ENDPOINTS.POSTS;

  return request(agentId, endpoint, apiKey, { logger });
}

/**
 * Get feed for a specific submolt
 * Per API: GET /submolts/{name}/feed?sort=new
 */
export async function getSubmoltFeed(
  agentId: UUID,
  apiKey: string,
  submoltName: string,
  options: { sort?: SortOption; limit?: number; logger?: Logger } = {}
): Promise<ApiResponse<MoltbookFeed>> {
  const { sort, limit, logger = coreLogger } = options;
  const params = new URLSearchParams();
  if (sort) params.set("sort", sort);
  if (limit) params.set("limit", String(limit));

  const query = params.toString();
  const endpoint = query
    ? `${ENDPOINTS.SUBMOLT_FEED(submoltName)}?${query}`
    : ENDPOINTS.SUBMOLT_FEED(submoltName);

  return request(agentId, endpoint, apiKey, { logger });
}

// =============================================================================
// POST API
// =============================================================================

/**
 * Get a single post by ID
 */
export async function getPost(
  agentId: UUID,
  apiKey: string,
  postId: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookPost>> {
  return request(agentId, ENDPOINTS.POST_BY_ID(postId), apiKey, { logger });
}

/**
 * Create a new post
 */
export async function createPost(
  agentId: UUID,
  apiKey: string,
  data: { title: string; content: string; submolt?: string },
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookPost>> {
  // Check post rate limit
  if (!canPost(agentId)) {
    return {
      success: false,
      error: "Rate limited - too soon since last post",
      status: 429,
    };
  }

  const result = await request<MoltbookPost>(agentId, ENDPOINTS.POSTS, apiKey, {
    method: "POST",
    body: data,
    logger,
  });

  if (result.success) {
    recordPost(agentId);
  }

  return result;
}

/**
 * Delete a post
 * Per API: DELETE /posts/POST_ID
 */
export async function deletePost(
  agentId: UUID,
  apiKey: string,
  postId: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean }>> {
  logger.debug({ postId }, "Moltbook: Deleting post");
  return request(agentId, ENDPOINTS.POST_BY_ID(postId), apiKey, {
    method: "DELETE",
    logger,
  });
}

// =============================================================================
// COMMENT API
// =============================================================================

/**
 * Get comments for a post
 */
export async function getComments(
  agentId: UUID,
  apiKey: string,
  postId: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookComment[]>> {
  return request(agentId, ENDPOINTS.COMMENTS(postId), apiKey, { logger });
}

/**
 * Create a comment on a post (or reply to another comment)
 * Per API: POST /posts/POST_ID/comments with {content} or {content, parent_id}
 */
export async function createComment(
  agentId: UUID,
  apiKey: string,
  postId: string,
  data: { content: string; parentId?: string },
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookComment>> {
  // Check comment rate limit
  if (!canComment(agentId)) {
    return {
      success: false,
      error: "Rate limited - too many comments this hour",
      status: 429,
    };
  }

  // API uses snake_case: parent_id
  const body: { content: string; parent_id?: string } = {
    content: data.content,
  };
  if (data.parentId) {
    body.parent_id = data.parentId;
  }

  const result = await request<MoltbookComment>(agentId, ENDPOINTS.COMMENTS(postId), apiKey, {
    method: "POST",
    body,
    logger,
  });

  if (result.success) {
    recordComment(agentId);
  }

  return result;
}

// =============================================================================
// VOTE API
// =============================================================================

/**
 * Vote on a post
 * Per API: POST /posts/{id}/upvote or /posts/{id}/downvote
 */
export async function votePost(
  agentId: UUID,
  apiKey: string,
  postId: string,
  direction: "up" | "down",
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean; message?: string }>> {
  const endpoint = direction === "up" ? ENDPOINTS.UPVOTE(postId) : ENDPOINTS.DOWNVOTE(postId);

  logger.debug({ postId, direction, endpoint }, "Moltbook: Voting on post");

  return request(agentId, endpoint, apiKey, {
    method: "POST",
    logger,
  });
}

/**
 * Vote on a comment
 * Per API: POST /comments/{id}/upvote or /comments/{id}/downvote
 */
export async function voteComment(
  agentId: UUID,
  apiKey: string,
  commentId: string,
  direction: "up" | "down",
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean; message?: string }>> {
  const endpoint =
    direction === "up"
      ? ENDPOINTS.COMMENT_UPVOTE(commentId)
      : ENDPOINTS.COMMENT_DOWNVOTE(commentId);

  logger.debug({ commentId, direction, endpoint }, "Moltbook: Voting on comment");

  return request(agentId, endpoint, apiKey, {
    method: "POST",
    logger,
  });
}

// =============================================================================
// PROFILE API
// =============================================================================

/**
 * Get own agent profile
 * Per API: GET /agents/me
 */
export async function getMyProfile(
  agentId: UUID,
  apiKey: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookProfile>> {
  return request(agentId, ENDPOINTS.ME, apiKey, { logger });
}

/**
 * Get another molty's profile by name
 * Per API: GET /agents/profile?name=MOLTY_NAME
 */
export async function getProfileByName(
  agentId: UUID,
  apiKey: string,
  name: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookProfile>> {
  logger.debug({ name }, "Moltbook: Getting profile by name");
  return request(agentId, ENDPOINTS.AGENT_PROFILE(name), apiKey, { logger });
}

/**
 * Follow a molty
 * Per API: POST /agents/MOLTY_NAME/follow
 */
export async function followUser(
  agentId: UUID,
  apiKey: string,
  moltyName: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean; message?: string }>> {
  logger.debug({ moltyName }, "Moltbook: Following molty");
  return request(agentId, ENDPOINTS.AGENT_FOLLOW(moltyName), apiKey, {
    method: "POST",
    logger,
  });
}

/**
 * Unfollow a molty
 * Per API: DELETE /agents/MOLTY_NAME/follow
 */
export async function unfollowUser(
  agentId: UUID,
  apiKey: string,
  moltyName: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean; message?: string }>> {
  logger.debug({ moltyName }, "Moltbook: Unfollowing molty");
  return request(agentId, ENDPOINTS.AGENT_FOLLOW(moltyName), apiKey, {
    method: "DELETE",
    logger,
  });
}

// =============================================================================
// SUBMOLT API
// =============================================================================

/**
 * Get list of submolts
 */
export async function getSubmolts(
  agentId: UUID,
  apiKey: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookSubmolt[]>> {
  return request(agentId, ENDPOINTS.SUBMOLTS, apiKey, { logger });
}

/**
 * Get a submolt by name
 */
export async function getSubmolt(
  agentId: UUID,
  apiKey: string,
  name: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<MoltbookSubmolt>> {
  return request(agentId, ENDPOINTS.SUBMOLT_BY_NAME(name), apiKey, { logger });
}

/**
 * Subscribe to a submolt
 * Per API: POST /submolts/SUBMOLT_NAME/subscribe
 */
export async function subscribeToSubmolt(
  agentId: UUID,
  apiKey: string,
  submoltName: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean; message?: string }>> {
  logger.debug({ submoltName }, "Moltbook: Subscribing to submolt");
  return request(agentId, ENDPOINTS.SUBMOLT_SUBSCRIBE(submoltName), apiKey, {
    method: "POST",
    logger,
  });
}

/**
 * Unsubscribe from a submolt
 * Per API: DELETE /submolts/SUBMOLT_NAME/subscribe
 */
export async function unsubscribeFromSubmolt(
  agentId: UUID,
  apiKey: string,
  submoltName: string,
  logger: Logger = coreLogger
): Promise<ApiResponse<{ success: boolean; message?: string }>> {
  logger.debug({ submoltName }, "Moltbook: Unsubscribing from submolt");
  return request(agentId, ENDPOINTS.SUBMOLT_SUBSCRIBE(submoltName), apiKey, {
    method: "DELETE",
    logger,
  });
}

// =============================================================================
// SEARCH API
// =============================================================================

/**
 * Semantic search for posts and comments
 * Per API: GET /search?q=query&type=posts|comments|all&limit=N
 * Uses AI-powered semantic search (meaning, not just keywords)
 */
export async function search(
  agentId: UUID,
  apiKey: string,
  query: string,
  options: { type?: "posts" | "comments" | "all"; limit?: number; logger?: Logger } = {}
): Promise<ApiResponse<MoltbookSearchResults>> {
  const { type, limit, logger = coreLogger } = options;
  const params = new URLSearchParams({ q: query });
  if (type) params.set("type", type);
  if (limit) params.set("limit", String(Math.min(limit, 50)));

  logger.debug({ query, type, limit }, "Moltbook: Semantic search");

  return request(agentId, `${ENDPOINTS.SEARCH}?${params.toString()}`, apiKey, { logger });
}
