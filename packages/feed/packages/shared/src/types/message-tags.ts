/**
 * Message Tag Types
 *
 * Tags are attached to messages when actions are executed (e.g., CHECK_PERPS, CHECK_PREDICTIONS).
 * They appear as clickable buttons below the message content and open a sidebar panel with detailed data.
 */

/** Tag types that can appear on messages */
export type MessageTagType =
  | "perps" // Perpetual markets list
  | "predictions" // Prediction markets list
  | "post" // Single post detail
  | "feed" // Feed posts list
  | "agent-pnl" // Agent's P&L (balance, positions, trades)
  | "owner-pnl"; // Owner's P&L (user's portfolio)

/** Lucide icon names used for tags */
export type MessageTagIcon =
  | "TrendingUp" // perps
  | "Target" // predictions
  | "FileText" // post
  | "Newspaper" // feed
  | "Wallet" // agent-pnl
  | "PiggyBank"; // owner-pnl

/** Mapping from tag type to its specific data payload */
interface TagDataMap {
  perps: PerpsTagData;
  predictions: PredictionsTagData;
  post: PostTagData;
  feed: FeedTagData;
  "agent-pnl": PnlTagData;
  "owner-pnl": PnlTagData;
}

/** Base tag structure with common fields */
interface MessageTagBase<T extends MessageTagType> {
  /** Tag type - determines which sidebar panel to render */
  type: T;
  /** Display text shown on the tag button */
  label: string;
  /** Lucide icon name to display */
  icon: MessageTagIcon;
  /** Optional entity ID for deep-linking (e.g., specific market or post ID) */
  entityId?: string;
  /** Data payload for the sidebar panel - typed based on tag type */
  data: TagDataMap[T];
}

/** Tag attached to a message - discriminated union based on type */
export type MessageTag =
  | MessageTagBase<"perps">
  | MessageTagBase<"predictions">
  | MessageTagBase<"post">
  | MessageTagBase<"feed">
  | MessageTagBase<"agent-pnl">
  | MessageTagBase<"owner-pnl">;

/** Action button for system messages */
export interface MessageAction {
  /** URL to navigate to when clicked */
  url: string;
  /** Button label text */
  label: string;
}

/** Message metadata stored in DB */
export interface MessageMetadata {
  /** Action tags from executed actions */
  tags?: MessageTag[];
  /** Optional action button (used by system messages) */
  action?: MessageAction;
}

// =============================================================================
// Tag Data Types - Structured data for each tag type
// =============================================================================

/** Single perp market data */
export interface PerpMarketData {
  ticker: string;
  name: string | null;
  currentPrice: number;
  changePercent24h: number;
  volume24h: number;
  openInterest?: number;
  fundingRate?: number;
}

/** Data for perps tag - supports both list and single market views */
export interface PerpsTagData {
  /** List of markets (for list view) */
  markets?: PerpMarketData[];
  /** Single market details (for specific market view) */
  market?: PerpMarketData;
}

/** Single prediction market data */
export interface PredictionMarketData {
  /**
   * Market ID - accepts both string and number to support legacy API endpoints
   * that return numeric IDs and newer endpoints that return string UUIDs.
   * This dual-type ensures backward compatibility with older API responses.
   */
  id: string | number;
  question: string;
  yesPercent: number;
  noPercent: number;
  resolved: boolean;
  resolution: string | null;
  daysUntil: number | null;
  endDate: string;
  index?: number;
  yesShares?: number;
  noShares?: number;
}

/** Data for predictions tag - supports both list and single market views */
export interface PredictionsTagData {
  /** List of predictions (for list view) */
  predictions?: PredictionMarketData[];
  /** Single prediction details (for specific market view) */
  prediction?: PredictionMarketData;
  /** Status filter used (only for list view) */
  status?: "active" | "resolved" | "all";
}

/** Data for post tag */
export interface PostTagData {
  post: {
    id: string;
    content: string;
    author: string;
    authorId: string;
    authorProfileImageUrl?: string | null;
    /** ISO 8601 date string (serialized as string in JSON) */
    createdAt: string;
  };
  commentCount: number;
  shareCount?: number;
}

/** Data for feed tag */
export interface FeedTagData {
  posts: Array<{
    index: number;
    id: string;
    content: string;
    authorName: string;
    authorId: string;
    authorProfileImageUrl?: string | null;
    timeAgo: string;
    likeCount: number;
    commentCount: number;
    shareCount: number;
  }>;
  count: number;
  hasMore: boolean;
}

/**
 * Data for P&L tags (agent-pnl and owner-pnl).
 *
 * Used by the Agents chat to display portfolio and trading performance.
 * - `agent-pnl`: Shows the agent's own trading balance and positions
 * - `owner-pnl`: Shows the owner's (human user's) portfolio summary
 */
export interface PnlTagData {
  /**
   * Display name of the portfolio owner.
   * Only populated for `owner-pnl` tags; undefined for `agent-pnl`.
   */
  ownerName?: string;

  /**
   * Display name of the agent.
   * Only populated for `agent-pnl` tags; undefined for `owner-pnl`.
   */
  agentName?: string;

  /** Current available balance (trading points) */
  balance: number;

  /** Cumulative realized P&L across all closed trades (legacy, may be inaccurate) */
  lifetimePnL: number;

  /** True total P&L from portfolio breakdown (totalAssets - originalAmount) */
  totalPnL?: number;

  /** Total assets value (wallet + agents + positions) */
  totalAssets?: number;

  /** Value of open positions (AMM-accurate) */
  positionsValue?: number;

  /** Available balance (wallet + agents, cash not in positions) */
  available?: number;

  /** Open prediction market positions */
  predictionPositions: Array<{
    id: string;
    marketId: string | null;
    side: string;
    shares: number;
    /**
     * Average entry price per share.
     * May be undefined if position was opened before price tracking was added.
     */
    avgPrice?: number;
    /** Market question text for display */
    question?: string;
  }>;

  /** Open perpetual/stock positions */
  perpPositions: Array<{
    id: string;
    ticker: string;
    side: string;
    size: number;
    /**
     * Entry price for the position.
     * May be undefined for legacy positions or if unavailable from the API.
     */
    entryPrice?: number;
    /**
     * Leverage multiplier for the position (e.g., 2 = 2x leverage).
     * Only applicable to leveraged perp markets; undefined for spot-like positions.
     */
    leverage?: number;
  }>;

  /**
   * Recent closed trades for this portfolio.
   * Only populated when the caller requests trade history.
   * Omitted or empty array when no recent trades exist.
   */
  recentTrades?: Array<{
    /** Trade action: 'open' or 'close' */
    action: string;
    /** Market type: 'prediction' or 'perpetual' */
    marketType: "prediction" | "perpetual";
    /** Market ID for linking (prediction market ID or perp ticker) */
    marketId: string;
    /** Human-readable display name (market question or perp ticker) */
    displayName: string;
    /** Trade amount */
    amount: number;
    /**
     * Realized P&L for this trade.
     * Null for opening trades or when P&L is not yet calculated.
     */
    pnl: number | null;
  }>;
}
