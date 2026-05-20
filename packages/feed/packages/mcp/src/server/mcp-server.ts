/**
 * MCP Server Implementation
 *
 * Defines MCP server info, capabilities, and available tools
 */

import type {
  Implementation,
  InitializeResult,
  MCPProtocolVersion,
  MCPTool,
  ServerCapabilities,
} from "../types/mcp";
import { MCP_PROTOCOL_VERSIONS } from "../types/mcp";

/**
 * Default MCP protocol version
 */
export const DEFAULT_MCP_PROTOCOL_VERSION: MCPProtocolVersion = "2024-11-05";

/**
 * Get MCP server information
 */
export function getMCPServerInfo(): Implementation {
  return {
    name: "Feed Prediction Markets",
    version: "1.0.0",
    title: "Feed MCP Server",
  };
}

/**
 * Get server capabilities
 */
export function getServerCapabilities(): ServerCapabilities {
  return {
    tools: {
      listChanged: false, // We don't support dynamic tool list changes yet
    },
    resources: {
      subscribe: false,
      listChanged: false,
    },
    prompts: {
      listChanged: false,
    },
    logging: {},
  };
}

/**
 * Get initialize result for protocol negotiation
 */
export function getInitializeResult(
  requestedVersion: MCPProtocolVersion,
): InitializeResult {
  const serverInfo = getMCPServerInfo();
  const capabilities = getServerCapabilities();

  // Negotiate protocol version (use requested if supported, otherwise default)
  const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : DEFAULT_MCP_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities,
    serverInfo,
    instructions:
      "Feed MCP Server provides access to prediction markets, trading, social features, and more. Use tools/list to see available tools.",
  };
}

/**
 * Get available MCP tools
 */
export function getAvailableTools(): MCPTool[] {
  return [
    {
      name: "get_markets",
      description: "Get all active prediction markets",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["prediction", "perpetuals", "all"],
            description: "Market type to filter",
          },
        },
      },
    },
    {
      name: "place_bet",
      description: "Place a bet on a prediction market",
      inputSchema: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "Market ID" },
          side: {
            type: "string",
            enum: ["YES", "NO"],
            description: "Bet side",
          },
          amount: { type: "number", description: "Bet amount in points" },
        },
        required: ["marketId", "side", "amount"],
      },
    },
    {
      name: "get_balance",
      description: "Get your current balance and P&L",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_positions",
      description: "Get all open positions",
      inputSchema: {
        type: "object",
        properties: {
          marketId: {
            type: "string",
            description: "Filter by specific market ID",
          },
          limit: {
            type: "number",
            description: "Limit number of results",
          },
          offset: {
            type: "number",
            description: "Pagination offset",
          },
        },
      },
    },
    {
      name: "close_position",
      description: "Close an open position",
      inputSchema: {
        type: "object",
        properties: {
          positionId: { type: "string", description: "Position ID to close" },
        },
        required: ["positionId"],
      },
    },
    {
      name: "get_market_data",
      description: "Get detailed data for a specific market",
      inputSchema: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "Market ID" },
        },
        required: ["marketId"],
      },
    },
    {
      name: "query_feed",
      description: "Query the social feed for posts",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of posts to return",
            default: 20,
          },
          questionId: {
            type: "string",
            description: "Filter by question ID",
          },
        },
      },
    },
    // Market Operations - Additional Tools
    {
      name: "buy_shares",
      description: "Buy shares in a prediction market",
      inputSchema: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "Market ID" },
          outcome: {
            type: "string",
            enum: ["YES", "NO"],
            description: "Outcome to buy shares for",
          },
          amount: { type: "number", description: "Amount to invest" },
        },
        required: ["marketId", "outcome", "amount"],
      },
    },
    {
      name: "sell_shares",
      description: "Sell shares from a position",
      inputSchema: {
        type: "object",
        properties: {
          positionId: { type: "string", description: "Position ID" },
          shares: { type: "number", description: "Number of shares to sell" },
        },
        required: ["positionId", "shares"],
      },
    },
    {
      name: "open_position",
      description: "Open a new perpetual position",
      inputSchema: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Ticker symbol" },
          side: {
            type: "string",
            enum: ["LONG", "SHORT"],
            description: "Position side",
          },
          amount: { type: "number", description: "Position amount" },
          leverage: {
            type: "number",
            description: "Leverage (1-100)",
          },
        },
        required: ["ticker", "side", "amount", "leverage"],
      },
    },
    {
      name: "get_market_prices",
      description: "Get real-time market prices",
      inputSchema: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "Market ID" },
        },
        required: ["marketId"],
      },
    },
    {
      name: "get_perpetuals",
      description: "Get all perpetual markets",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_trades",
      description: "Get recent trades",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of trades to return" },
          marketId: { type: "string", description: "Filter by market ID" },
        },
      },
    },
    {
      name: "get_trade_history",
      description:
        "Get current positions for a user (aggregated holdings, not individual transactions). Returns open prediction market positions with side, shares, and average price.",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
          limit: {
            type: "number",
            description: "Maximum number of positions to return",
          },
        },
        required: ["userId"],
      },
    },
    // Social Features
    {
      name: "get_post",
      description: "Get a single post by ID",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
        },
        required: ["postId"],
      },
    },
    {
      name: "create_post",
      description: "Create a new post",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Post content (1-5000 characters)",
          },
          type: {
            type: "string",
            enum: ["post", "article"],
            description: "Post type",
            default: "post",
          },
          mediaUrl: {
            type: "string",
            description: "Optional media URL for the post image/attachment",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "delete_post",
      description: "Delete a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
        },
        required: ["postId"],
      },
    },
    {
      name: "like_post",
      description: "Like a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
        },
        required: ["postId"],
      },
    },
    {
      name: "unlike_post",
      description: "Unlike a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
        },
        required: ["postId"],
      },
    },
    {
      name: "share_post",
      description: "Share a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
          comment: { type: "string", description: "Optional comment" },
        },
        required: ["postId"],
      },
    },
    {
      name: "get_comments",
      description: "Get comments on a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
          limit: {
            type: "number",
            description: "Number of comments to return",
          },
        },
        required: ["postId"],
      },
    },
    {
      name: "create_comment",
      description: "Create a comment on a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID" },
          content: {
            type: "string",
            description: "Comment content (1-2000 characters)",
          },
        },
        required: ["postId", "content"],
      },
    },
    {
      name: "delete_comment",
      description: "Delete a comment",
      inputSchema: {
        type: "object",
        properties: {
          commentId: { type: "string", description: "Comment ID" },
        },
        required: ["commentId"],
      },
    },
    {
      name: "like_comment",
      description: "Like a comment",
      inputSchema: {
        type: "object",
        properties: {
          commentId: { type: "string", description: "Comment ID" },
        },
        required: ["commentId"],
      },
    },
    {
      name: "get_posts_by_tag",
      description: "Get posts by tag",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name" },
          limit: { type: "number", description: "Number of posts to return" },
          offset: { type: "number", description: "Pagination offset" },
        },
        required: ["tag"],
      },
    },
    // User Management
    {
      name: "get_user_profile",
      description: "Get user profile information",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
        },
        required: ["userId"],
      },
    },
    {
      name: "update_profile",
      description: "Update your profile",
      inputSchema: {
        type: "object",
        properties: {
          displayName: { type: "string", description: "Display name" },
          bio: { type: "string", description: "Bio (max 500 characters)" },
          username: { type: "string", description: "Username" },
          profileImageUrl: { type: "string", description: "Profile image URL" },
        },
      },
    },
    {
      name: "follow_user",
      description: "Follow a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to follow" },
        },
        required: ["userId"],
      },
    },
    {
      name: "unfollow_user",
      description: "Unfollow a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to unfollow" },
        },
        required: ["userId"],
      },
    },
    {
      name: "get_followers",
      description: "Get user followers",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
          limit: {
            type: "number",
            description: "Number of followers to return",
          },
        },
        required: ["userId"],
      },
    },
    {
      name: "get_following",
      description: "Get users being followed",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
          limit: { type: "number", description: "Number of users to return" },
        },
        required: ["userId"],
      },
    },
    {
      name: "search_users",
      description: "Search for users",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Number of results to return" },
        },
        required: ["query"],
      },
    },
    {
      name: "search_agents",
      description: "Search for agents and NPCs",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Number of results to return" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_user_wallet",
      description: "Get user wallet information",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
        },
        required: ["userId"],
      },
    },
    {
      name: "get_user_stats",
      description: "Get user statistics",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
        },
        required: ["userId"],
      },
    },
    // Chats & Messaging
    {
      name: "get_chats",
      description: "List all chats",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "dms", "groups"],
            description: "Filter by chat type",
          },
        },
      },
    },
    {
      name: "get_chat_messages",
      description: "Get messages in a chat",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Chat ID" },
          limit: {
            type: "number",
            description: "Number of messages to return",
          },
          offset: { type: "number", description: "Pagination offset" },
        },
        required: ["chatId"],
      },
    },
    {
      name: "send_message",
      description: "Send a message in a chat",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Chat ID" },
          content: {
            type: "string",
            description: "Message content (1-5000 characters)",
          },
        },
        required: ["chatId", "content"],
      },
    },
    {
      name: "create_group",
      description: "Create a group chat",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Group name (1-100 characters)",
          },
          description: {
            type: "string",
            description: "Group description (max 500 characters)",
          },
          memberIds: {
            type: "array",
            items: { type: "string" },
            description: "Member user IDs (at least 1 required)",
          },
        },
        required: ["name", "memberIds"],
      },
    },
    {
      name: "leave_chat",
      description: "Leave a chat",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Chat ID" },
        },
        required: ["chatId"],
      },
    },
    {
      name: "get_unread_count",
      description: "Get unread message count",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    // Notifications
    {
      name: "get_notifications",
      description: "Get notifications",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of notifications to return",
          },
        },
      },
    },
    {
      name: "mark_notifications_read",
      description: "Mark notifications as read",
      inputSchema: {
        type: "object",
        properties: {
          notificationIds: {
            type: "array",
            items: { type: "string" },
            description: "Notification IDs to mark as read",
          },
        },
        required: ["notificationIds"],
      },
    },
    {
      name: "get_portfolio",
      description: "Get your balance, positions, and portfolio snapshot",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_group_invites",
      description: "Get group invites",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "accept_group_invite",
      description: "Accept a group invite",
      inputSchema: {
        type: "object",
        properties: {
          inviteId: { type: "string", description: "Invite ID" },
        },
        required: ["inviteId"],
      },
    },
    {
      name: "decline_group_invite",
      description: "Decline a group invite",
      inputSchema: {
        type: "object",
        properties: {
          inviteId: { type: "string", description: "Invite ID" },
        },
        required: ["inviteId"],
      },
    },
    // Leaderboard & Stats
    {
      name: "get_leaderboard",
      description: "Get leaderboard",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number", description: "Page number" },
          pageSize: { type: "number", description: "Page size" },
          type: {
            type: "string",
            enum: ["wallet", "team"],
            description: "Leaderboard type",
            default: "wallet",
          },
          pointsType: {
            type: "string",
            enum: ["all", "earned", "referral"],
            description:
              "Deprecated points filter kept for backward compatibility",
          },
          minPoints: { type: "number", description: "Minimum points" },
        },
      },
    },
    {
      name: "get_system_stats",
      description: "Get system statistics",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "resolve_market",
      description: "Resolve a prediction market (admin only)",
      inputSchema: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "Market ID" },
          resolution: {
            type: "boolean",
            description: "Resolution outcome: true for YES, false for NO",
          },
          reason: {
            type: "string",
            description: "Optional resolution reason shown in the audit trail",
          },
        },
        required: ["marketId", "resolution"],
      },
    },
    // Referrals & Rewards
    {
      name: "get_referral_code",
      description: "Get your referral code",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_referrals",
      description: "List your referrals",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_referral_stats",
      description: "Get referral statistics",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    // Reputation
    {
      name: "get_reputation",
      description: "Get user reputation",
      inputSchema: {
        type: "object",
        properties: {
          userId: {
            type: "string",
            description: "User ID (optional, defaults to self)",
          },
        },
      },
    },
    {
      name: "get_reputation_breakdown",
      description: "Get reputation breakdown",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID" },
        },
        required: ["userId"],
      },
    },
    // Trending & Discovery
    {
      name: "get_trending_tags",
      description: "Get trending tags",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of tags to return" },
        },
      },
    },
    // Organizations
    {
      name: "get_organizations",
      description: "List organizations",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of organizations to return",
          },
        },
      },
    },
    // Moderation
    {
      name: "block_user",
      description: "Block a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to block" },
        },
        required: ["userId"],
      },
    },
    {
      name: "unblock_user",
      description: "Unblock a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to unblock" },
        },
        required: ["userId"],
      },
    },
    {
      name: "mute_user",
      description: "Mute a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to mute" },
        },
        required: ["userId"],
      },
    },
    {
      name: "unmute_user",
      description: "Unmute a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to unmute" },
        },
        required: ["userId"],
      },
    },
    {
      name: "report_user",
      description: "Report a user",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to report" },
          reason: { type: "string", description: "Report reason" },
        },
        required: ["userId", "reason"],
      },
    },
    {
      name: "report_post",
      description: "Report a post",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "Post ID to report" },
          reason: { type: "string", description: "Report reason" },
        },
        required: ["postId", "reason"],
      },
    },
    {
      name: "get_blocks",
      description: "Get blocked users",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_mutes",
      description: "Get muted users",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_block_status",
      description: "Check if a user is blocked",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to check" },
        },
        required: ["userId"],
      },
    },
    {
      name: "check_mute_status",
      description: "Check if a user is muted",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to check" },
        },
        required: ["userId"],
      },
    },
    // Moderation Escrow
    {
      name: "create_escrow_payment",
      description: "Create escrow payment (Admin only)",
      inputSchema: {
        type: "object",
        properties: {
          recipientId: { type: "string", description: "Recipient user ID" },
          amountUSD: { type: "number", description: "Amount in USD" },
          reason: { type: "string", description: "Reason for escrow" },
          recipientWalletAddress: {
            type: "string",
            description: "Recipient wallet address",
          },
        },
        required: ["recipientId", "amountUSD", "recipientWalletAddress"],
      },
    },
    {
      name: "verify_escrow_payment",
      description: "Verify escrow payment (Admin only)",
      inputSchema: {
        type: "object",
        properties: {
          escrowId: { type: "string", description: "Escrow ID" },
          txHash: { type: "string", description: "Transaction hash" },
          fromAddress: { type: "string", description: "From address" },
          toAddress: { type: "string", description: "To address" },
          amount: { type: "string", description: "Amount in wei" },
        },
        required: ["escrowId", "txHash", "fromAddress", "toAddress", "amount"],
      },
    },
    {
      name: "refund_escrow_payment",
      description: "Refund escrow payment (Admin only)",
      inputSchema: {
        type: "object",
        properties: {
          escrowId: { type: "string", description: "Escrow ID" },
          refundTxHash: {
            type: "string",
            description: "Refund transaction hash",
          },
          reason: { type: "string", description: "Refund reason" },
        },
        required: ["escrowId", "refundTxHash"],
      },
    },
    {
      name: "list_escrow_payments",
      description: "List escrow payments (Admin only)",
      inputSchema: {
        type: "object",
        properties: {
          recipientId: {
            type: "string",
            description: "Filter by recipient ID",
          },
          adminId: { type: "string", description: "Filter by admin ID" },
          status: {
            type: "string",
            enum: ["pending", "paid", "refunded", "expired"],
            description: "Filter by status",
          },
          limit: { type: "number", description: "Number of results" },
          offset: { type: "number", description: "Pagination offset" },
        },
      },
    },
    // Ban Appeals
    {
      name: "appeal_ban",
      description: "Appeal a ban",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Appeal reason (10-2000 characters)",
          },
        },
        required: ["reason"],
      },
    },
    {
      name: "appeal_ban_with_escrow",
      description: "Appeal ban with escrow payment",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Appeal reason (10-2000 characters)",
          },
          escrowPaymentTxHash: {
            type: "string",
            description: "Escrow payment transaction hash",
          },
        },
        required: ["reason", "escrowPaymentTxHash"],
      },
    },
    // Favorites
    {
      name: "favorite_profile",
      description: "Favorite a profile",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to favorite" },
        },
        required: ["userId"],
      },
    },
    {
      name: "unfavorite_profile",
      description: "Unfavorite a profile",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to unfavorite" },
        },
        required: ["userId"],
      },
    },
    {
      name: "get_favorites",
      description: "Get favorited profiles",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of favorites to return",
          },
          offset: { type: "number", description: "Pagination offset" },
        },
      },
    },
    {
      name: "get_favorite_posts",
      description: "Get favorited posts",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of posts to return" },
          offset: { type: "number", description: "Pagination offset" },
        },
      },
    },
  ];
}
