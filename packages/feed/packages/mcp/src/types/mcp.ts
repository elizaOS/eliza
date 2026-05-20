/**
 * MCP Protocol Type Definitions
 * Model Context Protocol types following JSON-RPC 2.0 spec
 */

import type {
  JsonRpcParams,
  JsonRpcResult,
  JsonValue,
  StringRecord,
} from '@feed/shared';

// Re-export JSON-RPC types from shared for consistency
export type { JsonRpcParams, JsonRpcResult, JsonValue };

// JSON-RPC 2.0 Base Types (matching A2A structure)
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
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
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
}

// MCP Protocol Methods
export enum MCPMethod {
  // Lifecycle
  INITIALIZE = 'initialize',
  PING = 'ping',

  // Tools
  TOOLS_LIST = 'tools/list',
  TOOLS_CALL = 'tools/call',

  // Resources (for future expansion)
  RESOURCES_LIST = 'resources/list',
  RESOURCES_READ = 'resources/read',

  // Prompts (for future expansion)
  PROMPTS_LIST = 'prompts/list',
  PROMPTS_GET = 'prompts/get',
}

// MCP Protocol Versions
export const MCP_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
] as const;

export type MCPProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

// Client Capabilities
export interface ClientCapabilities {
  roots?: {
    listChanged?: boolean;
  };
  sampling?: Record<string, JsonValue>;
  tools?: {
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
}

// Server Capabilities
export interface ServerCapabilities {
  logging?: Record<string, JsonValue>;
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

// Implementation Info
export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

// Initialize Request Params
export interface InitializeParams {
  protocolVersion: MCPProtocolVersion;
  capabilities: ClientCapabilities;
  clientInfo: Implementation;
}

// Initialize Result
export interface InitializeResult {
  protocolVersion: MCPProtocolVersion;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  instructions?: string;
}

// Tool Input Schema Property
export interface MCPToolInputSchemaProperty {
  type: string;
  description?: string;
  enum?: readonly string[];
  default?: JsonValue;
  properties?: StringRecord<MCPToolInputSchemaProperty>;
  items?: MCPToolInputSchemaProperty;
  required?: string[];
}

// MCP Tool Definition
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: StringRecord<MCPToolInputSchemaProperty>;
    required?: string[];
  };
}

// Tools List Result
export interface ToolsListResult {
  tools: MCPTool[];
  nextCursor?: string;
}

// Tool Call Params
export interface ToolCallParams {
  name: string;
  arguments: StringRecord<JsonValue>;
}

// Tool Result Content
export interface TextContent {
  type: 'text';
  text: string;
  mimeType?: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export interface ResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    name?: string;
    title?: string;
    mimeType?: string;
    text?: string;
    blob?: string; // base64
  };
}

export type ToolResultContent = TextContent | ImageContent | ResourceContent;

// Tool Call Result
export interface ToolCallResult {
  content: ToolResultContent[];
  isError?: boolean;
}

// Authenticated Agent (for internal use)
export interface AuthenticatedAgent {
  agentId: string;
  userId: string;
}

// Authentication (handled via headers)
export interface MCPAuthContext {
  apiKey?: string;
  userId?: string; // Set after authentication
}

// Tool-specific argument types
export interface GetMarketsArgs {
  type?: 'prediction' | 'perpetuals' | 'all';
}

export interface PlaceBetArgs {
  marketId: string;
  side: 'YES' | 'NO';
  amount: number;
}

export interface GetBalanceArgs {
  // No arguments - balance is always for the authenticated agent
}

export interface GetPositionsArgs {
  marketId?: string; // Filter by specific market
  limit?: number; // Limit number of results (default: all)
  offset?: number; // Pagination offset
}

export interface ClosePositionArgs {
  positionId: string;
}

export interface GetMarketDataArgs {
  marketId: string;
}

export interface QueryFeedArgs {
  limit?: number;
  questionId?: string;
}

// Market Operations - Additional Args
export interface BuySharesArgs {
  marketId: string;
  outcome: 'YES' | 'NO';
  amount: number;
}

export interface SellSharesArgs {
  positionId: string;
  shares: number;
}

export interface OpenPositionArgs {
  ticker: string;
  side: 'LONG' | 'SHORT';
  amount: number;
  leverage: number;
}

export interface GetMarketPricesArgs {
  marketId: string;
}

export interface GetPerpetualsArgs {
  // No arguments
}

export interface GetTradesArgs {
  limit?: number;
  marketId?: string;
}

export interface GetTradeHistoryArgs {
  userId: string;
  limit?: number;
}

// Social Features - Args
export interface GetPostArgs {
  postId: string;
}

export interface CreatePostArgs {
  content: string;
  type?: 'post' | 'article';
  mediaUrl?: string;
}

export interface DeletePostArgs {
  postId: string;
}

export interface LikePostArgs {
  postId: string;
}

export interface UnlikePostArgs {
  postId: string;
}

export interface SharePostArgs {
  postId: string;
  comment?: string;
}

export interface GetCommentsArgs {
  postId: string;
  limit?: number;
}

export interface CreateCommentArgs {
  postId: string;
  content: string;
}

export interface DeleteCommentArgs {
  commentId: string;
}

export interface LikeCommentArgs {
  commentId: string;
}

export interface GetPostsByTagArgs {
  tag: string;
  limit?: number;
  offset?: number;
}

// User Management - Args
export interface GetUserProfileArgs {
  userId: string;
}

export interface UpdateProfileArgs {
  displayName?: string;
  bio?: string;
  username?: string;
  profileImageUrl?: string;
}

export interface FollowUserArgs {
  userId: string;
}

export interface UnfollowUserArgs {
  userId: string;
}

export interface GetFollowersArgs {
  userId: string;
  limit?: number;
}

export interface GetFollowingArgs {
  userId: string;
  limit?: number;
}

export interface SearchUsersArgs {
  query: string;
  limit?: number;
}

export interface SearchAgentsArgs {
  query: string;
  limit?: number;
}

export interface GetUserWalletArgs {
  userId: string;
}

export interface GetUserStatsArgs {
  userId: string;
}

// Chats & Messaging - Args
export interface GetChatsArgs {
  filter?: 'all' | 'dms' | 'groups';
}

export interface GetChatMessagesArgs {
  chatId: string;
  limit?: number;
  offset?: number;
}

export interface SendMessageArgs {
  chatId: string;
  content: string;
}

export interface CreateGroupArgs {
  name: string;
  description?: string;
  memberIds: string[];
}

export interface LeaveChatArgs {
  chatId: string;
}

export interface GetUnreadCountArgs {
  // No arguments
}

// Notifications - Args
export interface GetNotificationsArgs {
  limit?: number;
}

export interface MarkNotificationsReadArgs {
  notificationIds: string[];
}

export interface GetPortfolioArgs {
  // No arguments
}

export interface GetGroupInvitesArgs {
  // No arguments
}

export interface AcceptGroupInviteArgs {
  inviteId: string;
}

export interface DeclineGroupInviteArgs {
  inviteId: string;
}

// Leaderboard & Stats - Args
export interface GetLeaderboardArgs {
  page?: number;
  pageSize?: number;
  type?: 'wallet' | 'team';
  pointsType?: 'all' | 'earned' | 'referral';
  minPoints?: number;
}

export interface GetSystemStatsArgs {
  // No arguments
}

export interface ResolveMarketArgs {
  marketId: string;
  resolution: boolean;
  reason?: string;
}

// Referrals & Rewards - Args
export interface GetReferralCodeArgs {
  // No arguments
}

export interface GetReferralsArgs {
  // No arguments
}

export interface GetReferralStatsArgs {
  // No arguments
}

// Reputation - Args
export interface GetReputationArgs {
  userId?: string;
}

export interface GetReputationBreakdownArgs {
  userId: string;
}

// Trending & Discovery - Args
export interface GetTrendingTagsArgs {
  limit?: number;
}

// Organizations - Args
export interface GetOrganizationsArgs {
  limit?: number;
}

// x402 Micropayments - Args
export interface PaymentRequestArgs {
  to: string;
  amount: string;
  service: string;
  metadata?: StringRecord<JsonValue>;
  from?: string;
}

export interface PaymentReceiptArgs {
  requestId: string;
  txHash: string;
}

// Moderation - Args
export interface BlockUserArgs {
  userId: string;
}

export interface UnblockUserArgs {
  userId: string;
}

export interface MuteUserArgs {
  userId: string;
}

export interface UnmuteUserArgs {
  userId: string;
}

export interface ReportUserArgs {
  userId: string;
  reason: string;
}

export interface ReportPostArgs {
  postId: string;
  reason: string;
}

export interface GetBlocksArgs {
  // No arguments
}

export interface GetMutesArgs {
  // No arguments
}

export interface CheckBlockStatusArgs {
  userId: string;
}

export interface CheckMuteStatusArgs {
  userId: string;
}

// Moderation Escrow - Args
export interface CreateEscrowPaymentArgs {
  recipientId: string;
  amountUSD: number;
  reason?: string;
  recipientWalletAddress: string;
}

export interface VerifyEscrowPaymentArgs {
  escrowId: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
}

export interface RefundEscrowPaymentArgs {
  escrowId: string;
  refundTxHash: string;
  reason?: string;
}

export interface ListEscrowPaymentsArgs {
  recipientId?: string;
  adminId?: string;
  status?: 'pending' | 'paid' | 'refunded' | 'expired';
  limit?: number;
  offset?: number;
}

// Ban Appeals - Args
export interface AppealBanArgs {
  reason: string;
}

export interface AppealBanWithEscrowArgs {
  reason: string;
  escrowPaymentTxHash: string;
}

// Favorites - Args
export interface FavoriteProfileArgs {
  userId: string;
}

export interface UnfavoriteProfileArgs {
  userId: string;
}

export interface GetFavoritesArgs {
  limit?: number;
  offset?: number;
}

export interface GetFavoritePostsArgs {
  limit?: number;
  offset?: number;
}

// Tool-specific return types (internal, before conversion to MCP format)
export interface GetMarketsResult {
  markets: Array<{
    id: string;
    question: string;
    yesShares: string;
    noShares: string;
    liquidity: string;
    endDate: string;
  }>;
}

export interface PlaceBetResult extends StringRecord<JsonValue> {
  // API response from /api/markets/{id}/bet
}

export interface GetBalanceResult {
  balance: string;
  lifetimePnL: string;
}

export interface GetPositionsResult {
  positions: Array<{
    id: string;
    marketId: string;
    question: string | null;
    side: 'YES' | 'NO';
    shares: string;
    avgPrice: string;
  }>;
}

export interface ClosePositionResult extends StringRecord<JsonValue> {
  // API response from /api/positions/{id}/close
}

export interface GetMarketDataResult {
  id: string;
  question: string;
  description: string | null;
  yesShares: string;
  noShares: string;
  liquidity: string;
  resolved: boolean;
  resolution: boolean | null;
  endDate: string;
}

export interface QueryFeedResult {
  posts: Array<{
    id: string;
    content: string;
    authorId: string;
    timestamp: string;
  }>;
}

// Market Operations - Results
export interface BuySharesResult extends StringRecord<JsonValue> {
  // API response
}

export interface SellSharesResult extends StringRecord<JsonValue> {
  // API response
}

export interface OpenPositionResult extends StringRecord<JsonValue> {
  // API response
}

export interface GetMarketPricesResult {
  marketId: string;
  yesPrice: number;
  noPrice: number;
  timestamp: string;
}

export interface GetPerpetualsResult {
  markets: Array<{
    ticker: string;
    currentPrice: number;
    priceChange24h?: number;
    volume24h?: number;
  }>;
}

export interface GetTradesResult {
  trades: Array<{
    id: string;
    marketId: string;
    userId: string;
    side: 'YES' | 'NO';
    shares: string;
    price: string;
    timestamp: string;
  }>;
}

export interface GetTradeHistoryResult {
  trades: Array<{
    id: string;
    marketId: string;
    side: 'YES' | 'NO';
    shares: string;
    price: string;
    timestamp: string;
  }>;
}

// Social Features - Results
export interface GetPostResult extends StringRecord<JsonValue> {
  // API response from /api/posts/[id]
}

export interface CreatePostResult {
  success: boolean;
  postId: string;
  content: string;
  mediaUrl?: string | null;
}

export interface DeletePostResult {
  success: boolean;
}

export interface LikePostResult {
  success: boolean;
  liked: boolean;
}

export interface UnlikePostResult {
  success: boolean;
}

export interface SharePostResult {
  success: boolean;
  shareId: string;
}

export interface GetCommentsResult {
  comments: Array<{
    id: string;
    postId: string;
    authorId: string;
    content: string;
    timestamp: string;
    likes: number;
  }>;
}

export interface CreateCommentResult {
  success: boolean;
  commentId: string;
  content: string;
}

export interface DeleteCommentResult {
  success: boolean;
}

export interface LikeCommentResult {
  success: boolean;
}

// User Management - Results
export interface GetUserProfileResult {
  id: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  virtualBalance: string;
}

export interface UpdateProfileResult {
  success: boolean;
  profile: GetUserProfileResult;
}

export interface FollowUserResult {
  success: boolean;
}

export interface UnfollowUserResult {
  success: boolean;
}

export interface GetFollowersResult {
  followers: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  }>;
}

export interface GetFollowingResult {
  following: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  }>;
}

export interface SearchUsersResult {
  users: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    reputationPoints: number;
  }>;
}

export interface SearchAgentsResult {
  agents: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    bio: string | null;
    type: 'agent' | 'npc';
  }>;
}

export interface GetUserWalletResult {
  walletAddress: string | null;
  virtualBalance: string;
  totalDeposited: string;
  totalWithdrawn: string;
}

export interface GetUserStatsResult {
  totalPosts: number;
  totalComments: number;
  totalLikes: number;
  reputationPoints: number;
  virtualBalance: string;
  lifetimePnL: string;
}

// Chats & Messaging - Results
export interface GetChatsResult {
  chats: Array<{
    id: string;
    name: string | null;
    type: 'dm' | 'group';
    lastMessageAt: string | null;
    unreadCount: number;
  }>;
}

export interface GetChatMessagesResult {
  messages: Array<{
    id: string;
    chatId: string;
    authorId: string;
    content: string;
    timestamp: string;
  }>;
}

export interface SendMessageResult {
  success: boolean;
  messageId: string;
}

export interface CreateGroupResult {
  success: boolean;
  chatId: string;
  name: string;
}

export interface LeaveChatResult {
  success: boolean;
}

export interface GetUnreadCountResult {
  unreadCount: number;
}

// Notifications - Results
export interface GetNotificationsResult {
  notifications: Array<{
    id: string;
    type: string;
    message: string;
    read: boolean;
    timestamp: string;
  }>;
}

export interface MarkNotificationsReadResult {
  success: boolean;
  markedCount: number;
}

export interface GetPortfolioResult extends StringRecord<JsonValue> {
  // Aggregated balance + positions snapshot
}

export interface GetGroupInvitesResult {
  invites: Array<{
    id: string;
    groupId: string;
    groupName: string | null;
    inviterId: string;
    timestamp: string;
  }>;
}

export interface AcceptGroupInviteResult {
  success: boolean;
  chatId: string;
}

export interface DeclineGroupInviteResult {
  success: boolean;
}

// Leaderboard & Stats - Results
export interface GetLeaderboardResult {
  leaderboard: Array<{
    rank: number;
    userId: string;
    username: string | null;
    displayName: string | null;
    points: number;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export interface GetSystemStatsResult {
  users: number;
  posts: number;
  markets: number;
  activeMarkets: number;
}

export interface ResolveMarketResult {
  success: boolean;
  marketId: string;
  resolution: boolean;
}

// Referrals & Rewards - Results
export interface GetReferralCodeResult {
  referralCode: string;
}

export interface GetReferralsResult {
  referrals: Array<{
    id: string;
    referredUserId: string;
    username: string | null;
    displayName: string | null;
    createdAt: string;
  }>;
}

export interface GetReferralStatsResult {
  totalReferrals: number;
  totalEarnings: number;
  referralCode: string;
}

// Reputation - Results
export interface GetReputationResult {
  userId: string;
  trustScore: number;
  accuracyScore: number;
  totalBets: number;
  winningBets: number;
}

export interface GetReputationBreakdownResult {
  userId: string;
  trustScore: number;
  accuracyScore: number;
  breakdown: {
    marketPerformance: number;
    socialActivity: number;
    userFeedback: number;
  };
}

// Trending & Discovery - Results
export interface GetTrendingTagsResult {
  tags: Array<{
    tag: string;
    postCount: number;
    trendScore: number;
  }>;
}

export interface GetPostsByTagResult {
  posts: Array<{
    id: string;
    content: string;
    authorId: string;
    timestamp: string;
  }>;
}

// Organizations - Results
export interface GetOrganizationsResult {
  organizations: Array<{
    id: string;
    name: string;
    description: string | null;
  }>;
}

// x402 Micropayments - Results
export interface PaymentRequestResult {
  requestId: string;
  from: string;
  to: string;
  amount: string;
  expiresAt: number;
}

export interface PaymentReceiptResult {
  requestId: string;
  txHash: string;
  verified: boolean;
}

// Moderation - Results
export interface BlockUserResult {
  success: boolean;
}

export interface UnblockUserResult {
  success: boolean;
}

export interface MuteUserResult {
  success: boolean;
}

export interface UnmuteUserResult {
  success: boolean;
}

export interface ReportUserResult {
  success: boolean;
  reportId: string;
}

export interface ReportPostResult {
  success: boolean;
  reportId: string;
}

export interface GetBlocksResult {
  blockedUsers: Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    blockedAt: string;
  }>;
}

export interface GetMutesResult {
  mutedUsers: Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    mutedAt: string;
  }>;
}

export interface CheckBlockStatusResult {
  isBlocked: boolean;
  blockedAt: string | null;
}

export interface CheckMuteStatusResult {
  isMuted: boolean;
  mutedAt: string | null;
}

// Moderation Escrow - Results
export interface CreateEscrowPaymentResult {
  success: boolean;
  escrow: {
    id: string;
    recipientId: string;
    amountUSD: string;
    status: string;
    paymentRequestId: string;
    expiresAt: string;
  };
  paymentRequest: {
    requestId: string;
    amount: string;
    from: string;
    to: string;
    expiresAt: number;
  };
}

export interface VerifyEscrowPaymentResult {
  success: boolean;
  escrow: {
    id: string;
    recipientId: string;
    amountUSD: string;
    status: string;
    paymentTxHash: string | null;
  };
}

export interface RefundEscrowPaymentResult {
  success: boolean;
  escrow: {
    id: string;
    recipientId: string;
    amountUSD: string;
    status: string;
    refundTxHash: string | null;
    refundedAt: string | null;
  };
}

export interface ListEscrowPaymentsResult {
  success: boolean;
  escrows: Array<{
    id: string;
    recipientId: string;
    adminId: string;
    amountUSD: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

// Ban Appeals - Results
export interface AppealBanResult {
  success: boolean;
  message: string;
  appealStatus: string;
}

export interface AppealBanWithEscrowResult {
  success: boolean;
  message: string;
  appeal: {
    status: string;
    escrowId: string;
    amountUSD: string;
  };
}

// Favorites - Results
export interface FavoriteProfileResult {
  success: boolean;
}

export interface UnfavoriteProfileResult {
  success: boolean;
}

export interface GetFavoritesResult {
  favorites: Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    favoritedAt: string;
  }>;
}

export interface GetFavoritePostsResult {
  posts: Array<{
    id: string;
    content: string;
    authorId: string;
    timestamp: string;
  }>;
}

// Union type for all tool results (internal)
export type MCPToolResult =
  | GetMarketsResult
  | PlaceBetResult
  | GetBalanceResult
  | GetPositionsResult
  | ClosePositionResult
  | GetMarketDataResult
  | QueryFeedResult
  | BuySharesResult
  | SellSharesResult
  | OpenPositionResult
  | GetMarketPricesResult
  | GetPerpetualsResult
  | GetTradesResult
  | GetTradeHistoryResult
  | GetPostResult
  | CreatePostResult
  | DeletePostResult
  | LikePostResult
  | UnlikePostResult
  | SharePostResult
  | GetCommentsResult
  | CreateCommentResult
  | DeleteCommentResult
  | LikeCommentResult
  | GetPostsByTagResult
  | GetUserProfileResult
  | UpdateProfileResult
  | FollowUserResult
  | UnfollowUserResult
  | GetFollowersResult
  | GetFollowingResult
  | SearchUsersResult
  | SearchAgentsResult
  | GetUserWalletResult
  | GetUserStatsResult
  | GetChatsResult
  | GetChatMessagesResult
  | SendMessageResult
  | CreateGroupResult
  | LeaveChatResult
  | GetUnreadCountResult
  | GetNotificationsResult
  | MarkNotificationsReadResult
  | GetPortfolioResult
  | GetGroupInvitesResult
  | AcceptGroupInviteResult
  | DeclineGroupInviteResult
  | GetLeaderboardResult
  | GetSystemStatsResult
  | ResolveMarketResult
  | GetReferralCodeResult
  | GetReferralsResult
  | GetReferralStatsResult
  | GetReputationResult
  | GetReputationBreakdownResult
  | GetTrendingTagsResult
  | GetOrganizationsResult
  | PaymentRequestResult
  | PaymentReceiptResult
  | BlockUserResult
  | UnblockUserResult
  | MuteUserResult
  | UnmuteUserResult
  | ReportUserResult
  | ReportPostResult
  | GetBlocksResult
  | GetMutesResult
  | CheckBlockStatusResult
  | CheckMuteStatusResult
  | CreateEscrowPaymentResult
  | VerifyEscrowPaymentResult
  | RefundEscrowPaymentResult
  | ListEscrowPaymentsResult
  | AppealBanResult
  | AppealBanWithEscrowResult
  | FavoriteProfileResult
  | UnfavoriteProfileResult
  | GetFavoritesResult
  | GetFavoritePostsResult;
