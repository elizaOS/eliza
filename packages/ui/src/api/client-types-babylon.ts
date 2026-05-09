/** Babylon terminal API response types. */

export interface BabylonAgentStatus {
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

export type BabylonActivityType =
  | "trade"
  | "post"
  | "comment"
  | "message"
  | "social";

export interface BabylonActivityItem {
  id: string;
  type: BabylonActivityType;
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

export interface BabylonActivityFeed {
  items: BabylonActivityItem[];
  total: number;
}

export interface BabylonLogEntry {
  id?: string;
  timestamp: string;
  type: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface BabylonTeamAgent {
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

export interface BabylonTeamResponse {
  agents: BabylonTeamAgent[];
  externalAgents?: Array<{
    id: string;
    name: string;
    status: string;
  }>;
}

export interface BabylonChatResponse {
  ok: boolean;
  message?: string;
}

export interface BabylonToggleResponse {
  ok: boolean;
  agentId: string;
  autonomous: boolean;
}

export interface BabylonWallet {
  balance: number;
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    timestamp: string;
  }>;
}

export interface BabylonTeamChatInfo {
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

export interface BabylonPredictionMarket {
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

export interface BabylonPredictionMarketsResponse {
  markets: BabylonPredictionMarket[];
  total: number;
  page?: number;
  pageSize?: number;
}

export interface BabylonTradeResult {
  ok: boolean;
  tradeId?: string;
  marketId?: string;
  side?: string;
  amount?: number;
  shares?: number;
  price?: number;
  message?: string;
}

export interface BabylonPerpMarket {
  ticker: string;
  name: string;
  price: number;
  change24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
}

export interface BabylonPerpPosition {
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

export interface BabylonPerpTradeResult {
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

export interface BabylonPost {
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

export interface BabylonPostsResponse {
  posts: BabylonPost[];
  total?: number;
}

export interface BabylonPostResult {
  ok: boolean;
  postId?: string;
  message?: string;
}

export interface BabylonComment {
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

export interface BabylonChat {
  id: string;
  type: string;
  name?: string;
  participants: Array<{ id: string; name: string }>;
  lastMessage?: string;
  lastMessageAt?: string;
}

export interface BabylonChatsResponse {
  chats: BabylonChat[];
}

export interface BabylonChatMessage {
  id: string;
  senderId: string;
  senderName?: string;
  content: string;
  createdAt: string;
}

export interface BabylonChatMessagesResponse {
  messages: BabylonChatMessage[];
}

export interface BabylonSendMessageResult {
  ok: boolean;
  messageId?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Agent management
// ---------------------------------------------------------------------------

export interface BabylonAgentGoal {
  id: string;
  description: string;
  status: string;
  progress?: number;
  createdAt: string;
}

export interface BabylonAgentStats {
  totalTrades: number;
  winRate: number;
  lifetimePnL: number;
  totalPosts: number;
  totalComments: number;
  reputationScore: number;
  balance: number;
}

export interface BabylonAgentSummary {
  id: string;
  name: string;
  summary: string;
  recentActivity: BabylonActivityItem[];
}
