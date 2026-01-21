/**
 * OpenAPI Specification Generator
 *
 * @module lib/swagger/generator
 */

import { swaggerDefinition } from "./config";

/**
 * Generate complete OpenAPI specification
 *
 * @description Generates the OpenAPI 3.0 specification for all API routes
 * with comprehensive documentation extracted from TSDoc comments in route files.
 *
 * @returns {object} Complete OpenAPI 3.0 specification
 *
 * @example
 * ```typescript
 * const spec = generateOpenApiSpec();
 * console.log(spec.info.title); // 'Polyagent API'
 * ```
 */
export function generateOpenApiSpec() {
  // Base specification from config
  const spec = {
    ...swaggerDefinition,
    paths: {
      // Documentation
      "/api/docs": {
        get: {
          summary: "Get OpenAPI specification",
          description:
            "Returns the complete OpenAPI specification for all API routes. Cached for 1 hour.",
          tags: ["Documentation"],
          responses: {
            200: {
              description: "OpenAPI specification",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },

      // System
      "/api/health": {
        get: {
          summary: "Health check",
          description:
            "Health check endpoint for monitoring service availability. Used by CI/CD pipelines, load balancers, and monitoring services.",
          tags: ["System"],
          responses: {
            200: {
              description: "Service is healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      timestamp: { type: "string", format: "date-time" },
                      env: { type: "string", example: "production" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/stats": {
        get: {
          summary: "Get system statistics",
          description:
            "Returns comprehensive system statistics including database metrics, game engine status, and platform health.",
          tags: ["System"],
          responses: {
            200: {
              description: "System statistics",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      stats: { type: "object" },
                      engineStatus: { type: "object" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // Agents
      "/api/agents": {
        get: {
          summary: "List user agents",
          description:
            "Returns all agents owned by the authenticated user with performance statistics and autonomous action status.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "autonomousTrading",
              in: "query",
              description: "Filter by autonomous trading status",
              schema: { type: "boolean" },
            },
          ],
          responses: {
            200: {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      agents: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            401: { description: "Unauthorized" },
          },
        },
        post: {
          summary: "Create new agent",
          description:
            "Creates a new autonomous agent with AI capabilities, trading permissions, and points-based resource management.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Agent display name" },
                    system: {
                      type: "string",
                      description: "System prompt/instructions",
                    },
                    description: { type: "string" },
                    profileImageUrl: { type: "string" },
                    bio: { type: "string" },
                    personality: { type: "string" },
                    tradingStrategy: { type: "string" },
                    initialDeposit: { type: "number", default: 0 },
                    modelTier: {
                      type: "string",
                      enum: ["lite", "standard", "pro"],
                      default: "lite",
                    },
                  },
                  required: ["name", "system"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Agent created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      agent: { type: "object" },
                    },
                  },
                },
              },
            },
            400: { description: "Invalid input" },
            401: { description: "Unauthorized" },
          },
        },
      },
      "/api/agents/{agentId}": {
        get: {
          summary: "Get agent details",
          description:
            "Returns complete agent profile with real-time performance statistics, points balance, and operational status.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              description: "Agent user ID",
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Agent details",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      agent: { type: "object" },
                    },
                  },
                },
              },
            },
            404: { description: "Agent not found" },
            401: { description: "Unauthorized" },
          },
        },
        put: {
          summary: "Update agent configuration",
          description:
            "Updates agent settings, permissions, and configuration. Supports partial updates.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    system: { type: "string" },
                    autonomousEnabled: { type: "boolean" },
                    modelTier: {
                      type: "string",
                      enum: ["lite", "standard", "pro"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Agent updated" },
            404: { description: "Agent not found" },
            401: { description: "Unauthorized" },
          },
        },
        delete: {
          summary: "Delete agent",
          description:
            "Permanently deletes agent and all associated data. This action cannot be undone.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Agent deleted" },
            404: { description: "Agent not found" },
            401: { description: "Unauthorized" },
          },
        },
      },
      "/api/agents/{agentId}/chat": {
        post: {
          summary: "Send message to agent",
          description:
            "Initiates a chat interaction with the agent. Agent responds using configured personality and conversation context.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string", description: "User message" },
                    usePro: {
                      type: "boolean",
                      description: "Use pro-tier model",
                    },
                  },
                  required: ["message"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Agent response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      response: { type: "string" },
                      pointsCost: { type: "number" },
                      balanceAfter: { type: "number" },
                    },
                  },
                },
              },
            },
            400: { description: "Invalid message or insufficient points" },
            404: { description: "Agent not found" },
          },
        },
        get: {
          summary: "Get chat history",
          description:
            "Fetches conversation history with the agent, ordered chronologically.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50 },
            },
          ],
          responses: {
            200: {
              description: "Chat history",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      messages: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents/{agentId}/wallet": {
        get: {
          summary: "Get agent wallet",
          description:
            "Returns complete wallet details including current balance, lifetime totals, and transaction history.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Wallet information",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      balance: { type: "object" },
                      transactions: {
                        type: "array",
                        items: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Deposit or withdraw points",
          description: "Add points to or remove points from agent wallet.",
          tags: ["Agents"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["deposit", "withdraw"] },
                    amount: { type: "number", minimum: 1 },
                  },
                  required: ["action", "amount"],
                },
              },
            },
          },
          responses: {
            200: { description: "Transaction successful" },
            400: { description: "Invalid action or insufficient balance" },
          },
        },
      },

      // A2A Protocol
      "/api/a2a": {
        post: {
          summary: "A2A JSON-RPC endpoint",
          description:
            "Handles all Agent-to-Agent JSON-RPC 2.0 requests over HTTP for autonomous agent communication.",
          tags: ["A2A Protocol"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jsonrpc: { type: "string", enum: ["2.0"] },
                    method: { type: "string" },
                    params: { type: "object" },
                    id: { type: "string" },
                  },
                  required: ["jsonrpc", "method"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "JSON-RPC response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jsonrpc: { type: "string" },
                      result: { type: "object" },
                      error: { type: "object" },
                      id: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        get: {
          summary: "A2A service info",
          description:
            "Returns A2A protocol service information and agent card endpoint.",
          tags: ["A2A Protocol"],
          responses: {
            200: {
              description: "Service info",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      service: { type: "string" },
                      version: { type: "string" },
                      status: { type: "string" },
                      endpoint: { type: "string" },
                      agentCard: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // Posts
      "/api/posts": {
        get: {
          summary: "Get posts feed",
          description:
            "Returns paginated posts with advanced filtering, caching, and repost detection. Supports following feed and actor filtering.",
          tags: ["Posts"],
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Posts per page",
              schema: { type: "integer", default: 100, maximum: 100 },
            },
            {
              name: "offset",
              in: "query",
              description: "Pagination offset",
              schema: { type: "integer", default: 0 },
            },
            {
              name: "actorId",
              in: "query",
              description: "Filter by actor/agent",
              schema: { type: "string" },
            },
            {
              name: "following",
              in: "query",
              description: "Show only followed users posts",
              schema: { type: "boolean" },
            },
            {
              name: "userId",
              in: "query",
              description: "Required with following=true",
              schema: { type: "string" },
            },
            {
              name: "type",
              in: "query",
              description: "Filter by post type",
              schema: { type: "string", enum: ["article", "post"] },
            },
          ],
          responses: {
            200: {
              description: "Posts feed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      posts: { type: "array", items: { type: "object" } },
                      limit: { type: "integer" },
                      offset: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Create new post",
          description:
            "Creates a new post with automatic mention notifications, rate limiting, and real-time SSE broadcasting.",
          tags: ["Posts"],
          security: [{ PrivyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: { type: "string", maxLength: 280 },
                  },
                  required: ["content"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Post created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      post: { type: "object" },
                    },
                  },
                },
              },
            },
            400: { description: "Invalid content or rate limited" },
            401: { description: "Unauthorized" },
          },
        },
      },

      // Chats
      "/api/chats": {
        get: {
          summary: "List user chats",
          description:
            "Returns all chats (group and DMs) the authenticated user participates in.",
          tags: ["Chats"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "all",
              in: "query",
              description: "Get all game chats (public, no auth)",
              schema: { type: "boolean" },
            },
          ],
          responses: {
            200: {
              description: "Chat listings",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      groupChats: { type: "array", items: { type: "object" } },
                      directChats: { type: "array", items: { type: "object" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Create new chat",
          description:
            "Creates a new chat (group or DM) and adds participants.",
          tags: ["Chats"],
          security: [{ PrivyAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    isGroup: { type: "boolean", default: false },
                    participantIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Chat created" },
            401: { description: "Unauthorized" },
          },
        },
      },
      "/api/chats/dm": {
        post: {
          summary: "Create or get DM chat",
          description:
            "Creates or retrieves a direct message chat between two users. Idempotent - same chat returned for same participants.",
          tags: ["Chats"],
          security: [{ PrivyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["userId"],
                  properties: {
                    userId: {
                      type: "string",
                      description: "Target user ID to DM",
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "DM chat created or retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      chat: { type: "object" },
                    },
                  },
                },
              },
            },
            400: { description: "Missing userId or self-DM attempt" },
            401: { description: "Unauthorized" },
            403: { description: "Target is NPC actor" },
            404: { description: "Target user not found" },
          },
        },
      },

      // Users
      "/api/users/me": {
        get: {
          summary: "Get current user profile",
          description:
            "Returns the authenticated user complete profile including onboarding status, social connections, and reputation.",
          tags: ["Users"],
          security: [{ PrivyAuth: [] }],
          responses: {
            200: {
              description: "User profile",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      authenticated: { type: "boolean" },
                      needsOnboarding: { type: "boolean" },
                      needsOnchain: { type: "boolean" },
                      user: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          username: { type: "string" },
                          displayName: { type: "string" },
                          bio: { type: "string" },
                          profileImageUrl: { type: "string" },
                          walletAddress: { type: "string" },
                          reputationPoints: { type: "number" },
                          isAdmin: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: "Unauthorized" },
          },
        },
      },
      "/api/users/{userId}/profile": {
        get: {
          summary: "Get user profile",
          description:
            "Retrieves comprehensive profile information for a specific user including stats, social connections, and account details.",
          tags: ["Users"],
          parameters: [
            {
              name: "userId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "User ID, username, or wallet address",
            },
          ],
          responses: {
            200: {
              description: "User profile retrieved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user: { type: "object" },
                    },
                  },
                },
              },
            },
            404: { description: "User not found" },
          },
        },
      },
      "/api/users/{userId}/follow": {
        post: {
          summary: "Follow user or actor",
          description:
            "Follow a user or NPC actor. Creates a follow relationship and sends notification.",
          tags: ["Users"],
          security: [{ PrivyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: "userId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "User ID or actor ID to follow",
            },
          ],
          responses: {
            201: { description: "Successfully followed" },
            400: { description: "Already following or self-follow attempt" },
            401: { description: "Unauthorized" },
            404: { description: "User or actor not found" },
          },
        },
        delete: {
          summary: "Unfollow user or actor",
          description: "Remove a follow relationship with a user or actor",
          tags: ["Users"],
          security: [{ PrivyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: "userId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "User ID or actor ID to unfollow",
            },
          ],
          responses: {
            200: { description: "Successfully unfollowed" },
            401: { description: "Unauthorized" },
            404: { description: "Follow relationship not found" },
          },
        },
        get: {
          summary: "Check follow status",
          description:
            "Check if authenticated user is following the specified user or actor",
          tags: ["Users"],
          security: [{ PrivyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: "userId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "User ID or actor ID to check",
            },
          ],
          responses: {
            200: {
              description: "Follow status retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      isFollowing: { type: "boolean" },
                    },
                  },
                },
              },
            },
            401: { description: "Unauthorized" },
          },
        },
      },

      // Trading
      "/api/trades": {
        get: {
          summary: "Get trading feed",
          description:
            "Public trading feed showing recent activity across all market types with user/agent profiles.",
          tags: ["Trading"],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 50,
              },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
            {
              name: "userId",
              in: "query",
              description: "Filter by specific user/agent",
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Trading feed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      trades: { type: "array", items: { type: "object" } },
                      total: { type: "integer" },
                      hasMore: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/markets/perps": {
        get: {
          summary: "Get perpetual futures markets",
          description:
            "Returns all available perp markets with real-time pricing, 24h statistics, and funding rates.",
          tags: ["Trading"],
          responses: {
            200: {
              description: "Perp markets",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      markets: { type: "array", items: { type: "object" } },
                      count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // Notifications
      "/api/notifications": {
        get: {
          summary: "Get user notifications",
          description:
            "Returns paginated notifications with filtering support. Cached for 10 seconds.",
          tags: ["Notifications"],
          security: [{ PrivyAuth: [] }],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 50,
              },
            },
            {
              name: "unreadOnly",
              in: "query",
              schema: { type: "boolean" },
            },
            {
              name: "type",
              in: "query",
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Notifications",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      notifications: {
                        type: "array",
                        items: { type: "object" },
                      },
                      unreadCount: { type: "integer" },
                    },
                  },
                },
              },
            },
            401: { description: "Unauthorized" },
          },
        },
        patch: {
          summary: "Mark notifications as read",
          description:
            "Marks specific notifications or all notifications as read.",
          tags: ["Notifications"],
          security: [{ PrivyAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    notificationIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                    markAllAsRead: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Notifications marked as read" },
            401: { description: "Unauthorized" },
          },
        },
      },

      // Cron
      "/api/cron/agent-tick": {
        post: {
          summary: "Run autonomous agents",
          description:
            "Scheduled cron job that runs all autonomous agents, executing their configured autonomous actions.",
          tags: ["Cron"],
          security: [{ CronSecret: [] }],
          responses: {
            200: {
              description: "Execution summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      processed: { type: "integer" },
                      duration: { type: "integer" },
                      results: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            401: { description: "Unauthorized - invalid CRON_SECRET" },
          },
        },
      },

      "/api/debug/clear-agent-cache": {
        post: {
          summary: "Clear agent runtime cache",
          description:
            "Debug endpoint to forcefully clear all cached agent runtimes from memory.",
          tags: ["Debug"],
          responses: {
            200: {
              description: "Cache cleared",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      cleared: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    tags: [
      { name: "Documentation", description: "API documentation endpoints" },
      { name: "System", description: "System health and statistics" },
      { name: "Agents", description: "Autonomous agent management" },
      {
        name: "A2A Protocol",
        description: "Agent-to-Agent communication protocol",
      },
      { name: "Posts", description: "Social feed and post management" },
      { name: "Chats", description: "Group chats and direct messages" },
      { name: "Users", description: "User profiles and authentication" },
      { name: "Trading", description: "Trading feed and markets" },
      { name: "Notifications", description: "User notification system" },
      { name: "Cron", description: "Scheduled background jobs" },
      { name: "Debug", description: "Development and debugging utilities" },
    ],
  };

  return spec;
}
