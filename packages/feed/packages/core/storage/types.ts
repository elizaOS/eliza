/**
 * Core storage types for the Feed platform.
 * These types are database-agnostic and can be used with any storage backend.
 */

// ============================================================================
// Base Types
// ============================================================================

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Timestamped {
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Actor Types
// ============================================================================

export interface ActorRecord {
  id: string;
  name: string;
  tier?: 'central' | 'major' | 'supporting' | 'minor';
  personality?: string;
  domain?: string[];
  description?: string;
  tradingBalance: number;
  reputationPoints: number;
  hasPool?: boolean;
}

export interface ActorStateRecord {
  id: string;
  tradingBalance: string;
  reputationPoints: number;
  hasPool: boolean;
  updatedAt: Date;
}

// ============================================================================
// Organization Types
// ============================================================================

export interface OrganizationRecord {
  id: string;
  name: string;
  type: 'company' | 'media' | 'government';
  ticker?: string;
  description?: string;
  initialPrice?: number;
  currentPrice?: number;
}

export interface OrganizationStateRecord {
  id: string;
  currentPrice: number | null;
  updatedAt: Date;
}

// ============================================================================
// User Types
// ============================================================================

export interface UserRecord {
  id: string;
  username: string;
  displayName?: string;
  bio?: string;
  profileImageUrl?: string;
  coverImageUrl?: string;
  isAgent: boolean;
  managedBy?: string;
  virtualBalance: string;
  totalDeposited: string;
  reputationPoints: number;
  lifetimePnL: string;
  walletAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentConfigRecord {
  id: string;
  userId: string;
  systemPrompt?: string;
  personality?: string;
  tradingStrategy?: string;
  messageExamples?: JsonValue;
  autonomousTrading: boolean;
  autonomousPosting: boolean;
  autonomousCommenting: boolean;
  autonomousDMs: boolean;
  autonomousGroupChats: boolean;
  a2aEnabled: boolean;
  modelTier: 'free' | 'pro';
  updatedAt: Date;
}

// ============================================================================
// Post Types
// ============================================================================

export interface PostRecord {
  id: string;
  type: 'post' | 'article' | 'reply' | 'comment' | 'repost';
  content: string;
  fullContent?: string;
  articleTitle?: string;
  byline?: string;
  biasScore?: number;
  sentiment?: string;
  slant?: string;
  category?: string;
  authorId: string;
  gameId?: string;
  dayNumber?: number;
  timestamp: Date;
  commentOnPostId?: string;
  parentCommentId?: string;
  originalPostId?: string;
  deletedAt?: Date;
  likeCount: number;
  commentCount: number;
  repostCount: number;
}

// ============================================================================
// Question Types
// ============================================================================

export interface QuestionRecord {
  id: string;
  questionNumber: number;
  text: string;
  scenarioId: number;
  outcome: boolean;
  rank: number;
  status: 'active' | 'resolved' | 'cancelled';
  resolutionDate: Date;
  resolvedOutcome?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Market Types
// ============================================================================

export interface PredictionMarketRecord {
  id: string;
  questionId?: string;
  title: string;
  description?: string;
  category?: string;
  yesShares: string;
  noShares: string;
  liquidity: string;
  resolved: boolean;
  outcome?: boolean;
  endDate: Date;
  createdAt: Date;
}

export interface MarketSnapshotRecord {
  id: string;
  marketId: string;
  yesPrice: number;
  noPrice: number;
  yesShares: number;
  noShares: number;
  liquidity: number;
  eventType: string;
  source?: string;
  timestamp: Date;
}

// ============================================================================
// Position Types
// ============================================================================

export interface PoolPositionRecord {
  id: string;
  poolId: string;
  marketType: 'perp' | 'prediction';
  ticker?: string;
  marketId?: string;
  side: string;
  entryPrice: number;
  currentPrice: number;
  size: number;
  shares?: number;
  leverage?: number;
  liquidationPrice?: number;
  unrealizedPnL: number;
  realizedPnL?: number;
  openedAt?: Date;
  closedAt?: Date;
  updatedAt: Date;
}

// ============================================================================
// Trade Types
// ============================================================================

export interface NpcTradeRecord {
  id: string;
  npcActorId: string;
  poolId?: string;
  marketType: 'perp' | 'prediction';
  ticker?: string;
  marketId?: string;
  action: string;
  side: string;
  amount: number;
  price: number;
  sentiment: number;
  reason?: string;
  createdAt: Date;
}

export interface AgentTradeRecord {
  id: string;
  agentUserId: string;
  marketType: 'perp' | 'prediction';
  ticker?: string;
  marketId?: string;
  action: string;
  side: string;
  amount: number;
  pnl?: number;
  createdAt: Date;
}

// ============================================================================
// Pool Types
// ============================================================================

export interface PoolRecord {
  id: string;
  npcActorId?: string;
  name: string;
  description?: string;
  isActive: boolean;
  totalValue: string;
  totalDeposits: string;
  availableBalance: string;
  lifetimePnL: string;
  performanceFeeRate: number;
  totalFeesCollected: string;
  status: string;
  openedAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Event Types
// ============================================================================

export interface WorldEventRecord {
  id: string;
  eventType: string;
  description: string;
  actors: string[];
  relatedQuestion?: number;
  pointsToward?: string;
  visibility: string;
  gameId?: string;
  dayNumber?: number;
  timestamp: Date;
}

// ============================================================================
// Game Types
// ============================================================================

export interface GameRecord {
  id: string;
  isContinuous: boolean;
  isRunning: boolean;
  currentDay?: number;
  currentDate?: Date;
  speed?: number;
  lastTickAt?: Date;
  lastSnapshotAt?: Date;
  activeQuestions?: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Stock Price Types
// ============================================================================

export interface StockPriceRecord {
  id: string;
  organizationId: string;
  price: number;
  change: number;
  changePercent: number;
  isSnapshot: boolean;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  volume?: number;
  timestamp: Date;
}

// ============================================================================
// Messaging Types
// ============================================================================

export interface ChatRecord {
  id: string;
  type: 'dm' | 'group';
  name?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  senderId: string;
  content: string;
  type: 'text' | 'system' | 'trade';
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
}

// ============================================================================
// Pagination Types
// ============================================================================

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total?: number;
  nextCursor?: string;
  hasMore: boolean;
}
