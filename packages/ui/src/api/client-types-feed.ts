/** Feed terminal API response types. */

export interface FeedAgentStatus {
  id: string;
  name: string;
  displayName?: string;
  avatar?: string;
  balance: number;
  lifetimePnL: number;
  winRate: number;
  reputationScore: number;
  totalTrades: number;
  autonomous: boolean;
  autonomousTrading?: boolean;
  autonomousPosting?: boolean;
  autonomousCommenting?: boolean;
  autonomousDMs?: boolean;
  lastTickAt?: string;
  lastChatAt?: string;
  agentStatus?: string;
  errorMessage?: string;
}

export type FeedActivityType =
  | "trade"
  | "post"
  | "comment"
  | "message"
  | "social";

export interface FeedActivityItem {
  id: string;
  type: FeedActivityType;
  timestamp: string;
  agent?: { id: string; name: string };
  /** One-line summary of the action. */
  summary?: string;
  /** Trade-specific fields. */
  marketType?: string;
  marketId?: string;
  ticker?: string;
  action?: string;
  side?: string;
  amount?: number;
  price?: number;
  pnl?: number;
  reasoning?: string;
  /** Post/comment-specific fields. */
  contentPreview?: string;
  postId?: string;
  parentCommentId?: string;
}

export interface FeedActivityFeed {
  items: FeedActivityItem[];
  total: number;
}

export interface FeedLogEntry {
  id?: string;
  timestamp: string;
  type: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface FeedTeamAgent {
  id: string;
  name: string;
  displayName?: string;
  balance: number;
  lifetimePnL: number;
  winRate: number;
  reputationScore: number;
  totalTrades: number;
  autonomous: boolean;
  agentStatus?: string;
  lastTickAt?: string;
  recentLogsCount?: number;
  recentErrorsCount?: number;
}

export interface FeedTeamResponse {
  agents: FeedTeamAgent[];
  externalAgents?: Array<{
    id: string;
    name: string;
    status: string;
  }>;
}

export interface FeedChatResponse {
  ok: boolean;
  message?: string;
}

export interface FeedToggleResponse {
  ok: boolean;
  agentId: string;
  autonomous: boolean;
}

export interface FeedWallet {
  balance: number;
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    timestamp: string;
  }>;
}

export interface FeedTeamChatInfo {
  success: boolean;
  teamChat?: {
    id: string;
    chatId: string;
    groupId: string;
    agents: Array<{ id: string; name: string }>;
    agentCount: number;
  };
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export interface FeedPredictionMarket {
  id: string;
  title: string;
  description?: string;
  category?: string;
  status: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  endDate?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface FeedPredictionMarketsResponse {
  markets: FeedPredictionMarket[];
  total: number;
  page?: number;
  pageSize?: number;
}

export interface FeedTradeResult {
  ok: boolean;
  tradeId?: string;
  marketId?: string;
  side?: string;
  amount?: number;
  shares?: number;
  price?: number;
  message?: string;
}

export interface FeedPerpMarket {
  ticker: string;
  name: string;
  price: number;
  change24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
}

export interface FeedPerpPosition {
  id: string;
  ticker: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  margin: number;
  leverage: number;
}

export interface FeedPerpTradeResult {
  ok: boolean;
  positionId?: string;
  ticker?: string;
  side?: string;
  size?: number;
  entryPrice?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------

export interface FeedPost {
  id: string;
  authorId: string;
  authorName?: string;
  content: string;
  marketId?: string;
  likes: number;
  comments: number;
  shares: number;
  createdAt: string;
}

export interface FeedPostsResponse {
  posts: FeedPost[];
  total?: number;
}

export interface FeedPostResult {
  ok: boolean;
  postId?: string;
  message?: string;
}

export interface FeedComment {
  id: string;
  authorId: string;
  authorName?: string;
  content: string;
  postId: string;
  likes: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export interface FeedChat {
  id: string;
  type: string;
  name?: string;
  participants: Array<{ id: string; name: string }>;
  lastMessage?: string;
  lastMessageAt?: string;
}

export interface FeedChatsResponse {
  chats: FeedChat[];
}

export interface FeedChatMessage {
  id: string;
  senderId: string;
  senderName?: string;
  content: string;
  createdAt: string;
}

export interface FeedChatMessagesResponse {
  messages: FeedChatMessage[];
}

export interface FeedSendMessageResult {
  ok: boolean;
  messageId?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Agent management
// ---------------------------------------------------------------------------

export interface FeedAgentGoal {
  id: string;
  description: string;
  status: string;
  progress?: number;
  createdAt: string;
}

export interface FeedAgentStats {
  totalTrades: number;
  winRate: number;
  lifetimePnL: number;
  totalPosts: number;
  totalComments: number;
  reputationScore: number;
  balance: number;
}

/**
 * @deprecated Does NOT describe the Feed `/agent/summary` response. That endpoint
 * proxies an upstream `{agent,portfolio,positions}` envelope which `plugin-feed`'s
 * `extractAgentSummary` parses into a `FeedAgentSummaryEnvelope`.
 * `getFeedAgentSummary()` returns the raw `unknown` body; do not type Feed summary
 * data with this shape. Retained only for backward compat of the published
 * `@elizaos/ui` surface.
 */
export interface FeedAgentSummary {
  id: string;
  name: string;
  summary: string;
  recentActivity: FeedActivityItem[];
}
