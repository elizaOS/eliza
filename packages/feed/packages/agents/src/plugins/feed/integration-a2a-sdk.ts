/**
 * Feed Plugin Integration Service - A2A SDK
 *
 * Feed A2A client implementation using @a2a-js/sdk
 *
 * Architecture optimized for 300k+ users:
 * - Singleton A2A base client (agent card is shared across all agents)
 * - Agent identity caching with Redis/memory fallback
 * - Lazy header injection per-request (not per-client initialization)
 */

import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { db } from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { logger } from "../../shared/logger";
import type { JsonValue } from "../../types/common";

type FeedRuntime = AgentRuntime & { a2aClient?: FeedA2AClient };

function isA2AExplicitlyDisabled(): boolean {
  const value = process.env.FEED_DISABLE_A2A?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// =============================================================================
// Agent Identity Cache - Redis/Memory fallback for 300k+ users
// =============================================================================

/**
 * Cached agent identity for A2A headers.
 * TTL: 5 minutes (agents rarely change identity)
 */
interface CachedAgentIdentity {
  agentUserId: string;
  displayName: string | null;
  cachedAt: number;
}

/**
 * In-memory LRU cache for agent identities
 * Max 10,000 entries with 5-minute TTL
 */
const AGENT_IDENTITY_CACHE = new Map<string, CachedAgentIdentity>();
const AGENT_IDENTITY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AGENT_IDENTITY_MAX_SIZE = 10000;

/**
 * Get agent identity from cache or database.
 * Optimized for high concurrency with lazy refresh.
 * Supports both USER_CONTROLLED agents (User table) and NPCs (StaticDataRegistry).
 */
async function getCachedAgentIdentity(
  agentUserId: string,
): Promise<CachedAgentIdentity | null> {
  const now = Date.now();
  const cached = AGENT_IDENTITY_CACHE.get(agentUserId);

  if (cached && now - cached.cachedAt < AGENT_IDENTITY_TTL_MS) {
    return cached;
  }

  // First try User table (USER_CONTROLLED agents)
  const user = await db.user.findUnique({
    where: { id: agentUserId },
    select: {
      id: true,
      isAgent: true,
      displayName: true,
    },
  });

  if (user?.isAgent) {
    const identity: CachedAgentIdentity = {
      agentUserId,
      displayName: user.displayName,
      cachedAt: now,
    };
    cacheIdentity(agentUserId, identity);
    return identity;
  }

  // Fall back to static actor data (NPC agents)
  const actor = StaticDataRegistry.getActor(agentUserId);
  if (actor) {
    const identity: CachedAgentIdentity = {
      agentUserId,
      displayName: actor.name,
      cachedAt: now,
    };
    cacheIdentity(agentUserId, identity);
    return identity;
  }

  return null;
}

/**
 * Helper to cache identity with LRU eviction
 */
function cacheIdentity(
  agentUserId: string,
  identity: CachedAgentIdentity,
): void {
  // LRU eviction if at capacity
  if (AGENT_IDENTITY_CACHE.size >= AGENT_IDENTITY_MAX_SIZE) {
    const oldestKey = AGENT_IDENTITY_CACHE.keys().next().value;
    if (oldestKey) {
      AGENT_IDENTITY_CACHE.delete(oldestKey);
    }
  }

  AGENT_IDENTITY_CACHE.set(agentUserId, identity);
}

// =============================================================================
// Agent Card Cache - Fetched once, reused for all agents
// =============================================================================

/**
 * Cached agent card to avoid repeated HTTP fetches
 * The agent card is the same for all agents
 */
interface CachedAgentCard {
  agentCard: AgentCard;
  baseUrl: string;
  fetchedAt: number;
}

let cachedAgentCard: CachedAgentCard | null = null;
let agentCardFetchPromise: Promise<CachedAgentCard | null> | null = null;
const AGENT_CARD_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get or fetch the agent card JSON (singleton with TTL)
 */
async function getCachedAgentCard(): Promise<CachedAgentCard | null> {
  const now = Date.now();

  // Return cached if valid
  if (cachedAgentCard && now - cachedAgentCard.fetchedAt < AGENT_CARD_TTL_MS) {
    return cachedAgentCard;
  }

  // Prevent multiple concurrent fetches
  if (agentCardFetchPromise) {
    return agentCardFetchPromise;
  }

  agentCardFetchPromise = fetchAgentCard();
  const card = await agentCardFetchPromise;
  agentCardFetchPromise = null;
  return card;
}

/**
 * Fetch the agent card JSON from the server
 */
async function fetchAgentCard(): Promise<CachedAgentCard | null> {
  if (isA2AExplicitlyDisabled()) {
    logger.debug(
      "Skipping agent card fetch because FEED_DISABLE_A2A is enabled",
      undefined,
      "FeedIntegration",
    );
    return null;
  }

  const baseUrl =
    process.env.FEED_A2A_ENDPOINT ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  const agentCardUrl = `${baseUrl}/.well-known/agent-card.json`;

  try {
    logger.info(
      "Fetching agent card (cached for 30 minutes)",
      { agentCardUrl },
      "FeedIntegration",
    );

    const response = await fetch(agentCardUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch agent card: ${response.status}`);
    }

    const agentCard = (await response.json()) as AgentCard;
    cachedAgentCard = {
      agentCard,
      baseUrl,
      fetchedAt: Date.now(),
    };

    logger.info(
      "✅ Agent card cached (used for all agents)",
      { agentCardUrl },
      "FeedIntegration",
    );

    return cachedAgentCard;
  } catch (error) {
    logger.error(
      "Failed to fetch agent card",
      {
        agentCardUrl,
        error: error instanceof Error ? error.message : String(error),
      },
      "FeedIntegration",
    );
    return null;
  }
}

// =============================================================================
// Per-Agent Client Factory with Identity Headers
// =============================================================================

/**
 * Create authenticated fetch for an agent that injects identity headers
 * Headers come from cached identity (refreshed every 5 minutes max)
 */
function createAuthenticatedFetchForAgent(
  identity: CachedAgentIdentity,
): typeof fetch {
  const customFetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);

    // Always set agent ID for request correlation
    headers.set("x-agent-id", identity.agentUserId);

    // Add API key if configured
    const apiKey = process.env.FEED_A2A_API_KEY;
    if (apiKey) {
      headers.set("x-feed-api-key", apiKey);
    }

    return fetch(url, { ...init, headers });
  };

  // Bun may expose a non-standard `fetch.preconnect`; preserve it when present.
  const maybePreconnect = (fetch as unknown as { preconnect?: unknown })
    .preconnect;
  if (maybePreconnect) {
    (customFetch as unknown as { preconnect?: unknown }).preconnect =
      maybePreconnect;
  }

  return customFetch as typeof fetch;
}

/**
 * Create A2A client for an agent using cached agent card
 * Each agent gets its own client with identity-specific headers
 *
 * OPTIMIZED: Uses constructor directly with cached AgentCard object
 * This avoids repeated HTTP requests to fetch the agent card for each agent
 */
async function createA2AClientForAgent(
  identity: CachedAgentIdentity,
): Promise<A2AClient | null> {
  const card = await getCachedAgentCard();
  if (!card) {
    return null;
  }

  // Create client with custom fetch that injects this agent's identity headers
  const fetchImpl = createAuthenticatedFetchForAgent(identity);

  // Use constructor directly with cached AgentCard - avoids re-fetching!
  // The A2AClient constructor accepts AgentCard | string
  return new A2AClient(card.agentCard, { fetchImpl });
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Initialize A2A SDK client for an agent
 *
 * OPTIMIZED FOR 300K+ USERS:
 * - Agent card fetched once and cached (30-minute TTL)
 * - Agent identity cached with 5-minute TTL
 * - Per-agent client with identity-specific headers
 */
async function initializeA2ASdkClient(
  agentUserId: string,
): Promise<{ client: A2AClient; identity: CachedAgentIdentity } | null> {
  if (isA2AExplicitlyDisabled()) {
    logger.debug(
      "Skipping A2A client initialization because FEED_DISABLE_A2A is enabled",
      { agentUserId },
      "FeedIntegration",
    );
    return null;
  }

  // Get cached agent identity (or fetch from DB)
  const identity = await getCachedAgentIdentity(agentUserId);

  if (!identity) {
    throw new Error(`Agent user ${agentUserId} not found or not an agent`);
  }

  // Log identity status (only on first init, not on cache hit)
  // Create A2A client with cached agent card and identity-specific headers
  const client = await createA2AClientForAgent(identity);

  if (!client) {
    logger.warn(
      "A2A client creation failed - agent card not available",
      { agentUserId },
      "FeedIntegration",
    );
    return null;
  }

  logger.debug("A2A client ready for agent", {
    agentUserId,
    agentName: identity.displayName,
  });

  return { client, identity };
}

/**
 * Feed A2A Client - uses message/send with skills
 * Converts a2a.* method calls to A2A protocol
 *
 * OPTIMIZED FOR 300K+ USERS:
 * - Agent card cached (30-minute TTL) - one HTTP fetch for all agents
 * - Agent identity cached (5-minute TTL) - one DB query per 5 min per agent
 * - Per-agent client with identity-specific headers baked in at creation
 *
 */
export class FeedA2AClient {
  public readonly agentId: string;
  private sdkClient: A2AClient | null;

  constructor(
    sdkClient: A2AClient | null,
    agentId: string,
    _identity: CachedAgentIdentity, // Used during creation for headers, stored for reference
  ) {
    this.sdkClient = sdkClient;
    this.agentId = agentId;
  }

  /**
   * Check if client is connected
   * Returns false if SDK client is null (A2A not available)
   */
  isConnected(): boolean {
    // Check if underlying SDK client exists
    // If sdkClient is null, A2A is not available
    return this.sdkClient !== null && this.sdkClient !== undefined;
  }

  /**
   * Execute via A2A message/send with skills
   * Maps a2a.* methods to A2A protocol
   *
   * On server-side (Vercel serverless), uses direct executor to avoid HTTP self-call issues.
   * On client-side or when A2A protocol is explicitly needed, uses SDK client with HTTP.
   */
  private async executeViaA2A(
    action: string,
    params: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    // Map camelCase actions to category.snake_case operation names
    // This follows the executor's convention (e.g., 'social.create_post', 'stats.leaderboard')
    const operationMap: Record<string, string> = {
      // Portfolio operations
      getBalance: "portfolio.get_balance",
      getPositions: "portfolio.get_positions",
      getUserWallet: "portfolio.get_user_wallet",
      // Social operations
      createPost: "social.create_post",
      getFeed: "social.get_feed",
      likePost: "social.like_post",
      // Stats operations
      getSystemStats: "stats.system",
      getLeaderboard: "stats.leaderboard",
      getTrendingTags: "stats.trending_tags",
      getPostsByTag: "stats.posts_by_tag",
      getOrganizations: "stats.get_organizations",
      // Markets operations
      getPredictions: "markets.list_prediction",
      getPerpetuals: "markets.list_perpetuals",
      // Users operations
      searchUsers: "users.search",
      getUserProfile: "users.get_profile",
      // Messaging operations
      getChats: "messaging.get_chats",
      getChatMessages: "messaging.get_chat_messages",
      sendMessage: "messaging.send_message",
      createGroup: "messaging.create_group",
      leaveChat: "messaging.leave_chat",
      getUnreadCount: "messaging.get_unread_count",
      // Notifications operations
      getNotifications: "messaging.get_notifications",
      markNotificationsRead: "notifications.mark_read",
      getGroupInvites: "notifications.get_group_invites",
      acceptGroupInvite: "notifications.accept_invite",
      declineGroupInvite: "notifications.decline_invite",
    };

    const operationName = operationMap[action] || action;

    // On server-side (Next.js API routes), use direct executor to bypass HTTP
    // This fixes Vercel serverless 503 errors from self-calls
    const isServerSide = typeof window === "undefined";
    if (isServerSide) {
      const { FeedAgentExecutor } = await import("@feed/a2a");
      return FeedAgentExecutor.executeDirectly(
        operationName,
        params,
        this.agentId,
      );
    }

    // Client-side: use A2A SDK with HTTP (for true agent-to-agent communication)
    if (!this.sdkClient) {
      throw new Error("A2A client not available");
    }

    // Map action to skill ID - comprehensive mapping for all 69+ A2A methods
    const skillMap: Record<string, string> = {
      // Portfolio & Balance
      getBalance: "portfolio-balance",
      getPositions: "portfolio-balance",
      getUserWallet: "portfolio-balance",
      // Prediction Markets
      getPredictions: "prediction-markets",
      buyShares: "prediction-markets",
      sellShares: "prediction-markets",
      getTrades: "prediction-markets",
      getTradeHistory: "prediction-markets",
      // Perpetual Futures
      getPerpetuals: "perpetual-futures",
      openPosition: "perpetual-futures",
      closePosition: "perpetual-futures",
      // Market Data
      getMarketData: "prediction-markets",
      getMarketPrices: "prediction-markets",
      subscribeMarket: "prediction-markets",
      // Social Feed
      getFeed: "social-feed",
      getPost: "social-feed",
      createPost: "social-feed",
      deletePost: "social-feed",
      likePost: "social-feed",
      unlikePost: "social-feed",
      sharePost: "social-feed",
      getComments: "social-feed",
      createComment: "social-feed",
      deleteComment: "social-feed",
      likeComment: "social-feed",
      // User Management
      getUserProfile: "user-social-graph",
      updateProfile: "user-social-graph",
      followUser: "user-social-graph",
      unfollowUser: "user-social-graph",
      getFollowers: "user-social-graph",
      getFollowing: "user-social-graph",
      searchUsers: "user-social-graph",
      favoriteProfile: "user-social-graph",
      unfavoriteProfile: "user-social-graph",
      getFavorites: "user-social-graph",
      getFavoritePosts: "user-social-graph",
      // Messaging
      getChats: "messaging-chats",
      getChatMessages: "messaging-chats",
      sendMessage: "messaging-chats",
      createGroup: "messaging-chats",
      leaveChat: "messaging-chats",
      getUnreadCount: "messaging-chats",
      // Notifications
      getNotifications: "messaging-chats",
      markNotificationsRead: "messaging-chats",
      getGroupInvites: "messaging-chats",
      acceptGroupInvite: "messaging-chats",
      declineGroupInvite: "messaging-chats",
      // Stats & Discovery
      getLeaderboard: "stats-discovery",
      getUserStats: "stats-discovery",
      getSystemStats: "stats-discovery",
      getReferrals: "stats-discovery",
      getReferralStats: "stats-discovery",
      getReferralCode: "stats-discovery",
      getReputation: "stats-discovery",
      getReputationBreakdown: "stats-discovery",
      getTrendingTags: "stats-discovery",
      getPostsByTag: "stats-discovery",
      getOrganizations: "stats-discovery",
      // Agent Discovery
      discoverAgents: "stats-discovery",
      getAgentInfo: "stats-discovery",
      // Payments
      paymentRequest: "portfolio-balance",
      paymentReceipt: "portfolio-balance",
      // Moderation
      blockUser: "user-social-graph",
      unblockUser: "user-social-graph",
      muteUser: "user-social-graph",
      unmuteUser: "user-social-graph",
      reportUser: "user-social-graph",
      reportPost: "social-feed",
      getBlocks: "user-social-graph",
      getMutes: "user-social-graph",
      checkBlockStatus: "user-social-graph",
      checkMuteStatus: "user-social-graph",
    };

    const skillId = skillMap[action] || "portfolio-balance";

    const response = await this.sdkClient.sendMessage({
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            kind: "data",
            data: { operation: operationName, params },
            metadata: {
              skillId,
            },
          },
        ],
      },
    });

    // Type for data part in A2A messages
    interface DataPart {
      kind: "data";
      data: JsonValue;
    }

    function isDataPart(part: { kind: string }): part is DataPart {
      return part.kind === "data" && "data" in part;
    }

    // Handle response - extract Task or Message
    let task: Task | undefined;
    if ("result" in response && response.result) {
      const result = response.result;
      if (typeof result === "object" && result !== null && "kind" in result) {
        if (result.kind === "task") {
          task = result as Task;
        } else if (result.kind === "message") {
          // Direct message response
          const msg = result as Message;
          const dataPart = msg.parts.find((p) => isDataPart(p));
          return dataPart && isDataPart(dataPart) ? dataPart.data : {};
        }
      }
    }

    if (!task) {
      throw new Error("Expected task response from A2A");
    }

    // Poll for completion
    const maxWaitMs = 30000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const taskResponse = await this.sdkClient.getTask({ id: task.id });

      if ("result" in taskResponse && taskResponse.result) {
        const result = taskResponse.result as { task?: Task };
        if (result.task) {
          task = result.task;
        }
      }

      const state = task.status?.state;
      if (state === "completed") {
        if (task.artifacts && task.artifacts.length > 0) {
          const artifact = task.artifacts[0];
          if (artifact) {
            const dataPart = artifact.parts.find((p) => isDataPart(p));
            return dataPart && isDataPart(dataPart) ? dataPart.data : {};
          }
        }
        return {};
      }

      if (state === "failed" || state === "canceled" || state === "rejected") {
        const messagePart = task.status?.message?.parts?.[0];
        const errorText =
          messagePart && "text" in messagePart
            ? messagePart.text
            : "Unknown error";
        throw new Error(`Task ${state}: ${errorText}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("Task did not complete within timeout");
  }

  /**
   * Core request method - uses A2A protocol
   * Accepts params with potential undefined values and filters them out
   * Returns unknown since A2A responses can be any JSON structure
   */
  async request(
    method: string,
    params?: Record<string, JsonValue | undefined>,
  ): Promise<JsonValue> {
    if (method.startsWith("a2a.")) {
      // Map a2a.* methods to actions
      const action = method
        .replace("a2a.", "")
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase();
      // Convert back to camelCase for skill mapping
      const camelAction = action
        .split("_")
        .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join("");
      // Filter out undefined values from params and convert to JsonValue
      const cleanParams: Record<string, JsonValue> = {};
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) {
            // Value is known to be defined, safe to cast to JsonValue
            cleanParams[key] = value as JsonValue;
          } else if (value === null) {
            cleanParams[key] = null;
          }
        }
      }
      return this.executeViaA2A(camelAction, cleanParams);
    }
    throw new Error(`Method ${method} must use A2A protocol`);
  }

  /**
   * Alias for request() for backward compatibility with providers
   */
  async sendRequest(
    method: string,
    params?: Record<string, JsonValue | undefined>,
  ): Promise<JsonValue> {
    return this.request(method, params);
  }

  // ==================== Market Data Methods ====================
  async getMarketData(marketId: string) {
    return this.request("a2a.getMarketData", { marketId });
  }

  async getMarketPrices(marketId: string) {
    return this.request("a2a.getMarketPrices", { marketId });
  }

  async subscribeMarket(marketId: string) {
    return this.request("a2a.subscribeMarket", { marketId });
  }

  // ==================== Portfolio Methods ====================
  async getBalance(userId?: string) {
    return this.request("a2a.getBalance", userId ? { userId } : {});
  }

  async getPositions(userId?: string) {
    return this.request("a2a.getPositions", userId ? { userId } : {});
  }

  async getUserWallet(userId: string) {
    return this.request("a2a.getUserWallet", { userId });
  }

  // ==================== Agent Discovery Methods ====================
  async discoverAgents(
    filters?: {
      strategies?: string[];
      markets?: string[];
      minReputation?: number;
    },
    limit?: number,
  ) {
    return this.request("a2a.discover", {
      filters: filters as JsonValue,
      limit,
    });
  }

  async getAgentInfo(agentId: string) {
    return this.request("a2a.getInfo", { agentId });
  }

  // ==================== Trading Methods ====================
  async getPredictions(params?: {
    userId?: string;
    status?: "active" | "resolved";
  }) {
    return this.request("a2a.getPredictions", params || {});
  }

  async getPerpetuals() {
    return this.request("a2a.getPerpetuals", {});
  }

  async buyShares(marketId: string, outcome: "YES" | "NO", amount: number) {
    return this.request("a2a.buyShares", { marketId, outcome, amount });
  }

  async sellShares(positionId: string, shares: number) {
    return this.request("a2a.sellShares", { positionId, shares });
  }

  async openPosition(
    ticker: string,
    side: "LONG" | "SHORT",
    amount: number,
    leverage: number,
  ) {
    return this.request("a2a.openPosition", { ticker, side, amount, leverage });
  }

  async closePosition(positionId: string) {
    return this.request("a2a.closePosition", { positionId });
  }

  async getTrades(params?: { limit?: number; marketId?: string }) {
    return this.request("a2a.getTrades", params || {});
  }

  async getTradeHistory(userId: string, limit?: number) {
    return this.request("a2a.getTradeHistory", { userId, limit });
  }

  // ==================== Social Features ====================
  async getFeed(params?: {
    limit?: number;
    offset?: number;
    following?: boolean;
    type?: "post" | "article";
  }) {
    return this.request("a2a.getFeed", params || {});
  }

  async getPost(postId: string) {
    return this.request("a2a.getPost", { postId });
  }

  async createPost(content: string, type: "post" | "article" = "post") {
    return this.request("a2a.createPost", { content, type });
  }

  async deletePost(postId: string) {
    return this.request("a2a.deletePost", { postId });
  }

  async likePost(postId: string) {
    return this.request("a2a.likePost", { postId });
  }

  async unlikePost(postId: string) {
    return this.request("a2a.unlikePost", { postId });
  }

  async sharePost(postId: string, comment?: string) {
    return this.request("a2a.sharePost", { postId, comment });
  }

  async getComments(postId: string, limit?: number) {
    return this.request("a2a.getComments", { postId, limit });
  }

  async createComment(postId: string, content: string) {
    return this.request("a2a.createComment", { postId, content });
  }

  async deleteComment(commentId: string) {
    return this.request("a2a.deleteComment", { commentId });
  }

  async likeComment(commentId: string) {
    return this.request("a2a.likeComment", { commentId });
  }

  // ==================== User Management ====================
  async getUserProfile(userId: string) {
    return this.request("a2a.getUserProfile", { userId });
  }

  async updateProfile(params: {
    displayName?: string;
    bio?: string;
    username?: string;
    profileImageUrl?: string;
  }) {
    return this.request("a2a.updateProfile", params);
  }

  async followUser(userId: string) {
    return this.request("a2a.followUser", { userId });
  }

  async unfollowUser(userId: string) {
    return this.request("a2a.unfollowUser", { userId });
  }

  async getFollowers(userId: string, limit?: number) {
    return this.request("a2a.getFollowers", { userId, limit });
  }

  async getFollowing(userId: string, limit?: number) {
    return this.request("a2a.getFollowing", { userId, limit });
  }

  async searchUsers(query: string, limit?: number) {
    return this.request("a2a.searchUsers", { query, limit });
  }

  // ==================== Messaging ====================
  async getChats(filter?: "all" | "dms" | "groups") {
    return this.request("a2a.getChats", filter ? { filter } : {});
  }

  async getChatMessages(chatId: string, limit?: number, offset?: number) {
    return this.request("a2a.getChatMessages", { chatId, limit, offset });
  }

  async sendMessage(chatId: string, content: string) {
    return this.request("a2a.sendMessage", { chatId, content });
  }

  async createGroup(name: string, memberIds: string[], description?: string) {
    return this.request("a2a.createGroup", { name, memberIds, description });
  }

  async leaveChat(chatId: string) {
    return this.request("a2a.leaveChat", { chatId });
  }

  async getUnreadCount() {
    return this.request("a2a.getUnreadCount", {});
  }

  // ==================== Notifications ====================
  async getNotifications(limit?: number) {
    return this.request("a2a.getNotifications", { limit });
  }

  async markNotificationsRead(notificationIds: string[]) {
    return this.request("a2a.markNotificationsRead", { notificationIds });
  }

  async getGroupInvites() {
    return this.request("a2a.getGroupInvites", {});
  }

  async acceptGroupInvite(inviteId: string) {
    return this.request("a2a.acceptGroupInvite", { inviteId });
  }

  async declineGroupInvite(inviteId: string) {
    return this.request("a2a.declineGroupInvite", { inviteId });
  }

  // ==================== Stats & Discovery ====================
  async getLeaderboard(params?: {
    page?: number;
    pageSize?: number;
    pointsType?: "all" | "earned" | "referral";
    minPoints?: number;
  }) {
    return this.request("a2a.getLeaderboard", params || {});
  }

  async getUserStats(userId: string) {
    return this.request("a2a.getUserStats", { userId });
  }

  async getSystemStats() {
    return this.request("a2a.getSystemStats", {});
  }

  async getReferrals() {
    return this.request("a2a.getReferrals", {});
  }

  async getReferralStats() {
    return this.request("a2a.getReferralStats", {});
  }

  async getReferralCode() {
    return this.request("a2a.getReferralCode", {});
  }

  async getReputation(userId?: string) {
    return this.request("a2a.getReputation", userId ? { userId } : {});
  }

  async getReputationBreakdown(userId: string) {
    return this.request("a2a.getReputationBreakdown", { userId });
  }

  async getTrendingTags(limit?: number) {
    return this.request("a2a.getTrendingTags", { limit });
  }

  async getPostsByTag(tag: string, limit?: number, offset?: number) {
    return this.request("a2a.getPostsByTag", { tag, limit, offset });
  }

  async getOrganizations(limit?: number) {
    return this.request("a2a.getOrganizations", { limit });
  }

  // ==================== Payments (x402) ====================
  async paymentRequest(params: {
    to: string;
    amount: string;
    service: string;
    metadata?: Record<string, JsonValue>;
    from?: string;
  }) {
    return this.request(
      "a2a.paymentRequest",
      params as Record<string, JsonValue>,
    );
  }

  async paymentReceipt(requestId: string, txHash: string) {
    return this.request("a2a.paymentReceipt", { requestId, txHash });
  }

  // ==================== Moderation Methods ====================
  async blockUser(userId: string, reason?: string) {
    return this.request("a2a.blockUser", { userId, reason });
  }

  async unblockUser(userId: string) {
    return this.request("a2a.unblockUser", { userId });
  }

  async muteUser(userId: string, reason?: string) {
    return this.request("a2a.muteUser", { userId, reason });
  }

  async unmuteUser(userId: string) {
    return this.request("a2a.unmuteUser", { userId });
  }

  async reportUser(params: {
    userId: string;
    category:
      | "spam"
      | "harassment"
      | "hate_speech"
      | "violence"
      | "misinformation"
      | "inappropriate"
      | "impersonation"
      | "self_harm"
      | "other";
    reason: string;
    evidence?: string;
  }) {
    return this.request("a2a.reportUser", params);
  }

  async reportPost(params: {
    postId: string;
    category:
      | "spam"
      | "harassment"
      | "hate_speech"
      | "violence"
      | "misinformation"
      | "inappropriate"
      | "impersonation"
      | "self_harm"
      | "other";
    reason: string;
    evidence?: string;
  }) {
    return this.request("a2a.reportPost", params);
  }

  async getBlocks(params?: { limit?: number; offset?: number }) {
    return this.request("a2a.getBlocks", params || {});
  }

  async getMutes(params?: { limit?: number; offset?: number }) {
    return this.request("a2a.getMutes", params || {});
  }

  async checkBlockStatus(userId: string) {
    return this.request("a2a.checkBlockStatus", { userId });
  }

  async checkMuteStatus(userId: string) {
    return this.request("a2a.checkMuteStatus", { userId });
  }

  // ==================== Favorites ====================
  async favoriteProfile(userId: string) {
    return this.request("a2a.favoriteProfile", { userId });
  }

  async unfavoriteProfile(userId: string) {
    return this.request("a2a.unfavoriteProfile", { userId });
  }

  async getFavorites(params?: { limit?: number; offset?: number }) {
    return this.request("a2a.getFavorites", params || {});
  }

  async getFavoritePosts(params?: { limit?: number; offset?: number }) {
    return this.request("a2a.getFavoritePosts", params || {});
  }

  async close(): Promise<void> {
    // No cleanup needed
  }
}

/**
 * Initialize A2A client for an agent
 *
 * OPTIMIZED FOR 300K+ USERS:
 * - Uses cached agent identity (avoids DB query per init)
 * - Uses singleton A2A client (agent card fetched once)
 * - Returns null if A2A is not available (for graceful fallback)
 */
export async function initializeAgentA2AClient(
  agentUserId: string,
): Promise<FeedA2AClient | null> {
  const result = await initializeA2ASdkClient(agentUserId);

  // If SDK client is null, A2A is not available
  if (!result) {
    return null;
  }

  // Create client with cached identity - headers injected per-request
  return new FeedA2AClient(result.client, agentUserId, result.identity);
}

/**
 * Enhance agent runtime with Feed plugin
 *
 * OPTIMIZED FOR 300K+ USERS:
 * - Uses singleton A2A client shared across all agents
 * - Identity cached with 5-minute TTL
 */
export async function enhanceRuntimeWithFeed(
  runtime: AgentRuntime,
  agentUserId: string,
  plugin: Plugin,
): Promise<void> {
  const feedRuntime = runtime as FeedRuntime;

  // Initialize A2A client with cached identity and shared base client
  const result = await initializeA2ASdkClient(agentUserId);

  if (!result) {
    if (isA2AExplicitlyDisabled()) {
      logger.debug("A2A explicitly disabled; Feed plugin running without A2A", {
        agentUserId,
        pluginName: plugin.name,
      });
    } else {
      logger.warn(
        "A2A client initialization failed - plugin will have limited functionality",
        {
          agentUserId,
          pluginName: plugin.name,
        },
      );
    }
    // Create a disconnected client for graceful degradation
    const fallbackIdentity: CachedAgentIdentity = {
      agentUserId,
      displayName: null,
      cachedAt: Date.now(),
    };
    feedRuntime.a2aClient = new FeedA2AClient(
      null,
      agentUserId,
      fallbackIdentity,
    );
  } else {
    feedRuntime.a2aClient = new FeedA2AClient(
      result.client,
      agentUserId,
      result.identity,
    );
  }

  const a2aConnected = feedRuntime.a2aClient.isConnected();

  runtime.registerPlugin(plugin);

  // Use debug level for per-agent plugin registration to reduce startup noise
  const a2aMode = a2aConnected ? "a2a" : "database-fallback";
  logger.debug("Feed plugin registered", {
    agentUserId,
    mode: a2aMode,
    a2aEnabled: a2aConnected,
    providersCount: plugin.providers?.length || 0,
    actionsCount: plugin.actions?.length || 0,
  });
}

/**
 * Disconnect A2A client for an agent
 */
export async function disconnectAgentA2AClient(
  runtime: AgentRuntime,
): Promise<void> {
  const feedRuntime = runtime as FeedRuntime;

  if (!feedRuntime.a2aClient?.isConnected()) {
    return;
  }

  if (feedRuntime.a2aClient && "close" in feedRuntime.a2aClient) {
    await (feedRuntime.a2aClient as { close: () => Promise<void> }).close();
  }
  feedRuntime.a2aClient = undefined;

  logger.info("A2A client disconnected", { agentId: runtime.agentId });
}

/**
 * Check if agent runtime has active A2A connection
 */
export function hasActiveA2AConnection(runtime: AgentRuntime): boolean {
  const feedRuntime = runtime as FeedRuntime;
  return !!feedRuntime.a2aClient?.isConnected();
}
