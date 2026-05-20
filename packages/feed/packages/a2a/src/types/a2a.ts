/**
 * A2A Protocol Type Definitions
 *
 * Agent-to-Agent communication types following JSON-RPC 2.0 specification.
 * Defines request/response types, method enums, and protocol structures.
 *
 * @public
 */

import type {
  AgentCapabilities,
  GameNetworkInfo,
  JsonRpcParams,
  JsonValue,
} from '@feed/shared';
import {
  AgentCapabilitiesSchema,
  GameNetworkInfoSchema,
  JsonValueSchema,
} from '@feed/shared';
import { z } from 'zod';

/**
 * Result type for JSON-RPC responses
 */
export type JsonRpcResult = JsonValue | Record<string, JsonValue> | JsonValue[];

export type { AgentCapabilities, GameNetworkInfo, JsonRpcParams, JsonValue };
export { AgentCapabilitiesSchema, GameNetworkInfoSchema, JsonValueSchema };

/**
 * JSON-RPC 2.0 request structure
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
  id: string | number;
}

/**
 * JSON-RPC 2.0 response structure
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: JsonRpcResult;
  error?: JsonRpcError;
  id: string | number | null;
}

/**
 * JSON-RPC 2.0 error structure
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

/**
 * JSON-RPC 2.0 notification structure
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
}

/**
 * A2A Protocol method names
 */
export enum A2AMethod {
  HANDSHAKE = 'a2a.handshake',
  AUTHENTICATE = 'a2a.authenticate',
  DISCOVER_AGENTS = 'a2a.discover',
  GET_AGENT_INFO = 'a2a.getInfo',
  GET_MARKET_DATA = 'a2a.getMarketData',
  GET_MARKET_PRICES = 'a2a.getMarketPrices',
  SUBSCRIBE_MARKET = 'a2a.subscribeMarket',
  GET_PREDICTIONS = 'a2a.getPredictions',
  GET_PERPETUALS = 'a2a.getPerpetuals',
  BUY_SHARES = 'a2a.buyShares',
  SELL_SHARES = 'a2a.sellShares',
  OPEN_POSITION = 'a2a.openPosition',
  CLOSE_POSITION = 'a2a.closePosition',
  GET_POSITIONS = 'a2a.getPositions',
  GET_FEED = 'a2a.getFeed',
  GET_POST = 'a2a.getPost',
  CREATE_POST = 'a2a.createPost',
  DELETE_POST = 'a2a.deletePost',
  LIKE_POST = 'a2a.likePost',
  UNLIKE_POST = 'a2a.unlikePost',
  SHARE_POST = 'a2a.sharePost',
  GET_COMMENTS = 'a2a.getComments',
  CREATE_COMMENT = 'a2a.createComment',
  DELETE_COMMENT = 'a2a.deleteComment',
  LIKE_COMMENT = 'a2a.likeComment',
  GET_USER_PROFILE = 'a2a.getUserProfile',
  UPDATE_PROFILE = 'a2a.updateProfile',
  GET_BALANCE = 'a2a.getBalance',
  GET_USER_WALLET = 'a2a.getUserWallet',
  FOLLOW_USER = 'a2a.followUser',
  UNFOLLOW_USER = 'a2a.unfollowUser',
  GET_FOLLOWERS = 'a2a.getFollowers',
  GET_FOLLOWING = 'a2a.getFollowing',
  SEARCH_USERS = 'a2a.searchUsers',
  GET_TRADES = 'a2a.getTrades',
  GET_TRADE_HISTORY = 'a2a.getTradeHistory',
  GET_CHATS = 'a2a.getChats',
  GET_CHAT_MESSAGES = 'a2a.getChatMessages',
  SEND_MESSAGE = 'a2a.sendMessage',
  CREATE_GROUP = 'a2a.createGroup',
  LEAVE_CHAT = 'a2a.leaveChat',
  GET_UNREAD_COUNT = 'a2a.getUnreadCount',
  GET_NOTIFICATIONS = 'a2a.getNotifications',
  MARK_NOTIFICATIONS_READ = 'a2a.markNotificationsRead',
  GET_GROUP_INVITES = 'a2a.getGroupInvites',
  ACCEPT_GROUP_INVITE = 'a2a.acceptGroupInvite',
  DECLINE_GROUP_INVITE = 'a2a.declineGroupInvite',
  GET_LEADERBOARD = 'a2a.getLeaderboard',
  GET_USER_STATS = 'a2a.getUserStats',
  GET_SYSTEM_STATS = 'a2a.getSystemStats',
  GET_REFERRALS = 'a2a.getReferrals',
  GET_REFERRAL_STATS = 'a2a.getReferralStats',
  GET_REFERRAL_CODE = 'a2a.getReferralCode',
  GET_REPUTATION = 'a2a.getReputation',
  GET_REPUTATION_BREAKDOWN = 'a2a.getReputationBreakdown',
  GET_TRENDING_TAGS = 'a2a.getTrendingTags',
  GET_POSTS_BY_TAG = 'a2a.getPostsByTag',
  GET_ORGANIZATIONS = 'a2a.getOrganizations',
  PAYMENT_REQUEST = 'a2a.paymentRequest',
  PAYMENT_RECEIPT = 'a2a.paymentReceipt',
  BLOCK_USER = 'a2a.blockUser',
  UNBLOCK_USER = 'a2a.unblockUser',
  MUTE_USER = 'a2a.muteUser',
  UNMUTE_USER = 'a2a.unmuteUser',
  REPORT_USER = 'a2a.reportUser',
  REPORT_POST = 'a2a.reportPost',
  GET_BLOCKS = 'a2a.getBlocks',
  GET_MUTES = 'a2a.getMutes',
  CHECK_BLOCK_STATUS = 'a2a.checkBlockStatus',
  CHECK_MUTE_STATUS = 'a2a.checkMuteStatus',
  CREATE_ESCROW_PAYMENT = 'a2a.createEscrowPayment',
  VERIFY_ESCROW_PAYMENT = 'a2a.verifyEscrowPayment',
  REFUND_ESCROW_PAYMENT = 'a2a.refundEscrowPayment',
  LIST_ESCROW_PAYMENTS = 'a2a.listEscrowPayments',
  APPEAL_BAN = 'a2a.appealBan',
  APPEAL_BAN_WITH_ESCROW = 'a2a.appealBanWithEscrow',
  FAVORITE_PROFILE = 'a2a.favoriteProfile',
  UNFAVORITE_PROFILE = 'a2a.unfavoriteProfile',
  GET_FAVORITES = 'a2a.getFavorites',
  GET_FAVORITE_POSTS = 'a2a.getFavoritePosts',
}

/**
 * Agent authentication credentials
 */
export interface AgentCredentials {
  address: string; // Ethereum address
  tokenId: number; // ERC-8004 token ID
  signature: string; // Signed message proving ownership
  timestamp: number;
}

/**
 * Agent profile with capabilities and reputation
 */
export interface AgentProfile {
  agentId?: string; // Optional agent ID for registry tracking
  tokenId: number;
  address: string;
  name: string;
  endpoint: string;
  capabilities: AgentCapabilities;
  reputation: AgentReputation;
  isActive: boolean;
}

/**
 * Agent reputation metrics
 */
export interface AgentReputation {
  totalBets: number;
  winningBets: number;
  accuracyScore: number;
  trustScore: number;
  totalVolume: string;
  profitLoss: number;
  isBanned: boolean;
}

/**
 * Active agent connection information
 */
export interface AgentConnection {
  agentId: string;
  address: string;
  tokenId: number;
  capabilities: AgentCapabilities;
  authenticated: boolean;
  connectedAt: number;
  lastActivity: number;
}

/**
 * Market data structure
 */
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

/**
 * X402 payment request structure
 */
export interface PaymentRequest {
  requestId: string;
  from: string;
  to: string;
  amount: string; // in wei
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

/**
 * Payment receipt structure
 */
export interface PaymentReceipt {
  requestId: string;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  timestamp: number;
  confirmed: boolean;
}

/**
 * A2A Protocol error codes
 *
 * Includes JSON-RPC 2.0 standard codes and A2A-specific custom codes.
 */
export enum ErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
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

/**
 * A2A protocol event structure
 */
export interface A2AEvent {
  type: string;
  data: JsonValue | Record<string, JsonValue>;
  timestamp: number;
}

/**
 * A2A protocol event types
 */
export enum A2AEventType {
  AGENT_CONNECTED = 'agent.connected',
  AGENT_DISCONNECTED = 'agent.disconnected',
  MARKET_UPDATE = 'market.update',
  PAYMENT_RECEIVED = 'payment.received',
}

/**
 * Handshake request structure
 */
export interface HandshakeRequest {
  credentials: AgentCredentials;
  capabilities: AgentCapabilities;
  endpoint: string;
}

/**
 * Handshake response structure
 */
export interface HandshakeResponse {
  agentId: string;
  sessionToken: string;
  serverCapabilities: string[];
  expiresAt: number;
}

/**
 * Agent discovery request parameters
 */
export interface DiscoverRequest {
  filters?: {
    strategies?: string[];
    minReputation?: number;
    markets?: string[];
  };
  limit?: number;
}

/**
 * Agent discovery response structure
 */
export interface DiscoverResponse {
  agents: AgentProfile[];
  total: number;
}

/**
 * Market subscription information
 */
export interface MarketSubscription {
  marketId: string;
  agentId: string;
  subscribedAt: number;
}
