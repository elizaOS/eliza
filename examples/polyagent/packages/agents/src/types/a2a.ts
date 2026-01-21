/**
 * A2A Protocol Type Definitions for @polyagent/agents
 *
 * Agent-to-Agent communication types following JSON-RPC 2.0 spec
 */

import { z } from "zod";
import type { AgentCapabilities } from "./agent-registry";
import type { JsonRpcParams, JsonRpcResult, JsonValue } from "./common";
import { JsonValueSchema } from "./common";

// JSON-RPC 2.0 Base Types
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: JsonRpcParams;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: JsonRpcResult;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonRpcParams;
}

// A2A Protocol Methods
export enum A2AMethod {
  // Handshake & Authentication
  HANDSHAKE = "a2a.handshake",
  AUTHENTICATE = "a2a.authenticate",

  // Agent Discovery
  DISCOVER_AGENTS = "a2a.discover",
  GET_AGENT_INFO = "a2a.getInfo",

  // Market Operations
  GET_MARKET_DATA = "a2a.getMarketData",
  GET_MARKET_PRICES = "a2a.getMarketPrices",
  SUBSCRIBE_MARKET = "a2a.subscribeMarket",
  GET_PREDICTIONS = "a2a.getPredictions",
  GET_PERPETUALS = "a2a.getPerpetuals",
  BUY_SHARES = "a2a.buyShares",
  SELL_SHARES = "a2a.sellShares",
  OPEN_POSITION = "a2a.openPosition",
  CLOSE_POSITION = "a2a.closePosition",
  GET_POSITIONS = "a2a.getPositions",

  // Social Features
  GET_FEED = "a2a.getFeed",
  GET_POST = "a2a.getPost",
  CREATE_POST = "a2a.createPost",
  DELETE_POST = "a2a.deletePost",
  LIKE_POST = "a2a.likePost",
  UNLIKE_POST = "a2a.unlikePost",
  SHARE_POST = "a2a.sharePost",
  GET_COMMENTS = "a2a.getComments",
  CREATE_COMMENT = "a2a.createComment",
  DELETE_COMMENT = "a2a.deleteComment",
  LIKE_COMMENT = "a2a.likeComment",

  // User Management
  GET_USER_PROFILE = "a2a.getUserProfile",
  UPDATE_PROFILE = "a2a.updateProfile",
  GET_BALANCE = "a2a.getBalance",
  GET_USER_WALLET = "a2a.getUserWallet",
  FOLLOW_USER = "a2a.followUser",
  UNFOLLOW_USER = "a2a.unfollowUser",
  GET_FOLLOWERS = "a2a.getFollowers",
  GET_FOLLOWING = "a2a.getFollowing",
  SEARCH_USERS = "a2a.searchUsers",

  // Trades
  GET_TRADES = "a2a.getTrades",
  GET_TRADE_HISTORY = "a2a.getTradeHistory",

  // Chats & Messaging
  GET_CHATS = "a2a.getChats",
  GET_CHAT_MESSAGES = "a2a.getChatMessages",
  SEND_MESSAGE = "a2a.sendMessage",
  CREATE_GROUP = "a2a.createGroup",
  LEAVE_CHAT = "a2a.leaveChat",
  GET_UNREAD_COUNT = "a2a.getUnreadCount",

  // Notifications
  GET_NOTIFICATIONS = "a2a.getNotifications",
  MARK_NOTIFICATIONS_READ = "a2a.markNotificationsRead",
  GET_GROUP_INVITES = "a2a.getGroupInvites",
  ACCEPT_GROUP_INVITE = "a2a.acceptGroupInvite",
  DECLINE_GROUP_INVITE = "a2a.declineGroupInvite",

  // Leaderboard & Stats
  GET_LEADERBOARD = "a2a.getLeaderboard",
  GET_USER_STATS = "a2a.getUserStats",
  GET_SYSTEM_STATS = "a2a.getSystemStats",

  // Rewards & Referrals
  GET_REFERRALS = "a2a.getReferrals",
  GET_REFERRAL_STATS = "a2a.getReferralStats",
  GET_REFERRAL_CODE = "a2a.getReferralCode",

  // Reputation
  GET_REPUTATION = "a2a.getReputation",
  GET_REPUTATION_BREAKDOWN = "a2a.getReputationBreakdown",

  // Trending & Discovery
  GET_TRENDING_TAGS = "a2a.getTrendingTags",
  GET_POSTS_BY_TAG = "a2a.getPostsByTag",

  // Organizations
  GET_ORGANIZATIONS = "a2a.getOrganizations",

  // x402 Micropayments
  PAYMENT_REQUEST = "a2a.paymentRequest",
  PAYMENT_RECEIPT = "a2a.paymentReceipt",

  // Moderation
  BLOCK_USER = "a2a.blockUser",
  UNBLOCK_USER = "a2a.unblockUser",
  MUTE_USER = "a2a.muteUser",
  UNMUTE_USER = "a2a.unmuteUser",
  REPORT_USER = "a2a.reportUser",
  REPORT_POST = "a2a.reportPost",
  GET_BLOCKS = "a2a.getBlocks",
  GET_MUTES = "a2a.getMutes",
  CHECK_BLOCK_STATUS = "a2a.checkBlockStatus",
  CHECK_MUTE_STATUS = "a2a.checkMuteStatus",

  // Points Transfer
  TRANSFER_POINTS = "a2a.transferPoints",

  // Favorites
  FAVORITE_PROFILE = "a2a.favoriteProfile",
  UNFAVORITE_PROFILE = "a2a.unfavoriteProfile",
  GET_FAVORITES = "a2a.getFavorites",
  GET_FAVORITE_POSTS = "a2a.getFavoritePosts",
}

// Agent Connection Types
export interface AgentCredentials {
  address: string;
  tokenId: number;
  signature: string;
  timestamp: number;
}

export interface AgentProfile {
  agentId?: string;
  tokenId: number;
  address: string;
  name: string;
  endpoint: string;
  capabilities: AgentCapabilities;
  reputation: AgentReputation;
  isActive: boolean;
}

export interface AgentReputation {
  totalBets: number;
  winningBets: number;
  accuracyScore: number;
  trustScore: number;
  totalVolume: string;
  profitLoss: number;
  isBanned: boolean;
}

export interface AgentConnection {
  agentId: string;
  address: string;
  tokenId: number;
  capabilities: AgentCapabilities;
  authenticated: boolean;
  connectedAt: number;
  lastActivity: number;
}

// Market Data Types
export interface MarketData {
  marketId: string;
  question: string;
  outcomes: string[];
  prices: number[];
  volume: string;
  liquidity: string;
  resolveAt: number;
  resolved: boolean;
  winningOutcome?: number;
}

export interface MarketSubscription {
  marketId: string;
  agentId: string;
  subscribedAt: number;
}

// x402 Micropayment Types
export interface PaymentRequest {
  requestId: string;
  from: string;
  to: string;
  amount: string;
  service: string;
  metadata?: Record<string, JsonValue>;
  expiresAt: number;
}

export const PaymentRequestSchema = z.object({
  requestId: z.string(),
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  service: z.string(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
  expiresAt: z.number(),
});

export interface PaymentReceipt {
  requestId: string;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  timestamp: number;
  confirmed: boolean;
}

// WebSocket Message Types
export interface HandshakeRequest {
  credentials: AgentCredentials;
  capabilities: AgentCapabilities;
  endpoint: string;
}

export interface HandshakeResponse {
  agentId: string;
  sessionToken: string;
  serverCapabilities: string[];
  expiresAt: number;
}

export interface DiscoverRequest {
  filters?: {
    strategies?: string[];
    minReputation?: number;
    markets?: string[];
  };
  limit?: number;
}

export interface DiscoverResponse {
  agents: AgentProfile[];
  total: number;
}

// Error Codes
export enum ErrorCode {
  // JSON-RPC 2.0 Standard
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,

  // A2A Protocol Custom
  NOT_AUTHENTICATED = -32000,
  AUTHENTICATION_FAILED = -32001,
  AGENT_NOT_FOUND = -32002,
  MARKET_NOT_FOUND = -32003,
  COALITION_NOT_FOUND = -32004,
  FORBIDDEN = -32009,
  PAYMENT_FAILED = -32005,
  RATE_LIMIT_EXCEEDED = -32006,
  INVALID_SIGNATURE = -32007,
  EXPIRED_REQUEST = -32008,
}

// Event Types
export interface A2AEvent {
  type: string;
  data: JsonValue | Record<string, JsonValue>;
  timestamp: number;
}

export enum A2AEventType {
  AGENT_CONNECTED = "agent.connected",
  AGENT_DISCONNECTED = "agent.disconnected",
  MARKET_UPDATE = "market.update",
  PAYMENT_RECEIVED = "payment.received",
}
