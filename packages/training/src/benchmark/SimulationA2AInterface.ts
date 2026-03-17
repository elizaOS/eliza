/**
 * Simulation A2A Interface
 *
 * Provides A2A-compatible interface for agents to interact with simulation.
 * Wraps SimulationEngine to make it behave like a real game server.
 *
 * Agents can use standard A2A methods like:
 * - a2a.getPredictions
 * - a2a.buyShares
 * - a2a.openPosition
 * - a2a.getFeed
 * etc.
 *
 * @example
 * ```typescript
 * const interface = new SimulationA2AInterface(engine, 'agent-123');
 * const predictions = await interface.sendRequest('a2a.getPredictions');
 * ```
 */

import { logger } from "../utils/logger";
import type { SimulationEngine } from "./SimulationEngine";

/**
 * A2A method parameter types
 */
export type A2AMethodParams =
  | BuySharesParams
  | SellSharesParams
  | OpenPositionParams
  | ClosePositionParams
  | CreatePostParams
  | JoinGroupParams
  | { status?: string; limit?: number; offset?: number }
  | Record<string, string | number | boolean | undefined>;

/**
 * Buy shares result
 */
export interface BuySharesResult {
  shares: number;
  avgPrice: number;
  positionId: string;
}

/**
 * Sell shares result
 */
export interface SellSharesResult {
  proceeds: number;
}

/**
 * Open position result
 */
export interface OpenPositionResult {
  positionId: string;
  entryPrice: number;
}

/**
 * Close position result
 */
export interface ClosePositionResult {
  pnl: number;
  exitPrice: number;
}

/**
 * Create post result
 */
export interface CreatePostResult {
  postId: string;
}

/**
 * Create comment result
 */
export interface CreateCommentResult {
  commentId: string;
}

/**
 * Join group result
 */
export interface JoinGroupResult {
  success: boolean;
}

/**
 * Portfolio position for simulation
 */
export interface PortfolioPosition {
  id: string;
  marketId?: string;
  ticker?: string;
  side: string;
  size: number;
  entryPrice: number;
  currentPrice?: number;
  pnl?: number;
}

/**
 * Portfolio result
 */
export interface PortfolioResult {
  balance: number;
  positions: PortfolioPosition[];
  pnl: number;
}

/**
 * Dashboard result
 */
export interface DashboardResult {
  balance: number;
  reputation: number;
  totalPnl: number;
  activePositions: number;
}

/**
 * Trending tag entry
 */
export interface TrendingTagEntry {
  tag: string;
  count: number;
  trend: string;
}

/**
 * Chat entry with member count
 */
export interface ChatEntry {
  id: string;
  name: string;
  memberCount: number;
  messageCount: number;
  lastActivity: number;
  invited: boolean;
  messages: Array<{
    id: string;
    authorId: string;
    authorName: string;
    content: string;
    timestamp: number;
  }>;
}

/**
 * Union type for all A2A response types
 */
export type A2AResponse =
  | { predictions: Omit<PredictionMarket, "resolved">[] }
  | BuySharesResult
  | SellSharesResult
  | { perpetuals: PerpetualMarket[] }
  | OpenPositionResult
  | ClosePositionResult
  | { posts: FeedPost[] }
  | CreatePostResult
  | CreateCommentResult
  | { chats: ChatEntry[] }
  | JoinGroupResult
  | { balance: number }
  | PortfolioResult
  | {
      predictionPositions: PortfolioPosition[];
      perpPositions: PortfolioPosition[];
    }
  | DashboardResult
  | { tags: TrendingTagEntry[] };

/**
 * Parameters for buying prediction market shares
 */
export interface BuySharesParams {
  /** Market ID to buy shares in */
  marketId: string;
  /** Outcome to buy (YES or NO) */
  outcome: "YES" | "NO";
  /** Amount to invest */
  amount: number;
}

/**
 * Parameters for selling prediction market shares
 */
interface SellSharesParams {
  /** Market ID to sell shares from */
  marketId: string;
  /** Number of shares to sell */
  shares: number;
}

/**
 * Parameters for opening a perpetual position
 */
interface OpenPositionParams {
  /** Ticker symbol */
  ticker: string;
  /** Position side (LONG or SHORT) */
  side: "LONG" | "SHORT";
  /** Position size */
  size: number;
  /** Leverage multiplier */
  leverage: number;
}

/**
 * Parameters for closing a perpetual position
 */
interface ClosePositionParams {
  /** Position ID to close */
  positionId: string;
}

/**
 * Parameters for creating a post
 */
interface CreatePostParams {
  /** Post content */
  content: string;
  /** Optional market ID to associate with post */
  marketId?: string;
}

/**
 * Parameters for joining a group chat
 */
interface JoinGroupParams {
  /** Group chat ID */
  groupId: string;
}

/**
 * Prediction market data structure
 */
interface PredictionMarket {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  yesPrice: number;
  noPrice: number;
  liquidity: number;
  totalVolume: number;
  createdAt: number;
  resolveAt: number;
  resolved: boolean;
}

/**
 * Perpetual market data structure
 */
interface PerpetualMarket {
  ticker: string;
  price: number;
  priceChange24h?: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime?: number;
}

/**
 * Feed post data structure
 */
interface FeedPost {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  likes: number;
  comments: number;
  marketId?: string;
}

/**
 * Group chat data structure
 */
interface GroupChat {
  id: string;
  name: string;
  memberIds: string[];
  messageCount: number;
  lastActivity: number;
  invitedAgent?: boolean;
  messages?: Array<{
    id: string;
    authorId: string;
    authorName: string;
    content: string;
    timestamp: number;
  }>;
}

export class SimulationA2AInterface {
  private engine: SimulationEngine;
  private agentId: string;

  /**
   * Create a new SimulationA2AInterface instance
   *
   * @param engine - Simulation engine to wrap
   * @param agentId - Agent identifier for this interface instance
   */
  constructor(engine: SimulationEngine, agentId: string) {
    this.engine = engine;
    this.agentId = agentId;
  }

  /**
   * Send A2A request (JSON-RPC style)
   *
   * Routes requests to appropriate handler methods based on method name.
   * All methods are logged and timed.
   *
   * @param method - A2A method name (e.g., 'a2a.getPredictions')
   * @param params - Optional parameters for the method
   * @returns Method-specific result (type depends on method)
   * @throws Error if method is unknown or handler fails
   *
   * @example
   * ```typescript
   * const result = await interface.sendRequest('a2a.getPredictions');
   * const buyResult = await interface.sendRequest('a2a.buyShares', {
   *   marketId: 'market-1',
   *   outcome: 'YES',
   *   amount: 100
   * });
   * ```
   */
  async sendRequest(
    method: string,
    params?: A2AMethodParams,
  ): Promise<A2AResponse> {
    logger.debug("Simulation A2A request", { method, params });

    const actionStart = Date.now();

    try {
      let result: A2AResponse;

      // Route to appropriate handler
      switch (method) {
        case "a2a.getPredictions":
          result = this.handleGetPredictions(params);
          break;

        case "a2a.buyShares":
          result = await this.handleBuyShares(params);
          break;

        case "a2a.sellShares":
          result = await this.handleSellShares(params);
          break;

        case "a2a.getPerpetuals":
          result = this.handleGetPerpetuals(params);
          break;

        case "a2a.openPosition":
          result = await this.handleOpenPosition(params);
          break;

        case "a2a.closePosition":
          result = await this.handleClosePosition(params);
          break;

        case "a2a.getFeed":
          result = this.handleGetFeed(params);
          break;

        case "a2a.createPost":
          result = await this.handleCreatePost(params);
          break;

        case "a2a.getChats":
          result = this.handleGetChats(params);
          break;

        case "a2a.joinGroup":
          result = await this.handleJoinGroup(params);
          break;

        case "a2a.getBalance":
          result = this.handleGetBalance(params);
          break;

        case "a2a.getPortfolio":
          result = this.handleGetPortfolio(params);
          break;

        case "a2a.getPositions":
          result = this.handleGetPositions(params);
          break;

        case "a2a.getDashboard":
          result = this.handleGetDashboard(params);
          break;

        case "a2a.getTrendingTags":
          result = this.handleGetTrendingTags(params);
          break;

        default:
          throw new Error(`Unknown A2A method: ${method}`);
      }

      // This allows the agent to make multiple A2A calls within a single tick

      const duration = Date.now() - actionStart;
      logger.debug("Simulation A2A response", { method, duration });

      return result;
    } catch (error) {
      logger.error("Simulation A2A error", { method, error });
      throw error;
    }
  }

  /**
   * Get prediction markets
   *
   * Returns all unresolved prediction markets from the simulation state.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object containing array of prediction markets
   */
  private handleGetPredictions(_params: A2AMethodParams | undefined): {
    predictions: Omit<PredictionMarket, "resolved">[];
  } {
    const state = this.engine.getGameState();

    const predictions = state.predictionMarkets
      .filter((m: PredictionMarket) => !m.resolved)
      .map((m: PredictionMarket) => ({
        id: m.id,
        question: m.question,
        yesShares: m.yesShares,
        noShares: m.noShares,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        liquidity: m.liquidity,
        totalVolume: m.totalVolume,
        createdAt: m.createdAt,
        resolveAt: m.resolveAt,
      }));

    return { predictions };
  }

  /**
   * Type guard for BuySharesParams
   */
  private isBuySharesParams(
    params: A2AMethodParams,
  ): params is BuySharesParams {
    return (
      typeof params === "object" &&
      params !== null &&
      "marketId" in params &&
      "outcome" in params &&
      "amount" in params &&
      typeof params.marketId === "string" &&
      (params.outcome === "YES" || params.outcome === "NO") &&
      typeof params.amount === "number" &&
      params.amount > 0
    );
  }

  /**
   * Buy prediction market shares
   *
   * Executes a buy action through the simulation engine and returns the result.
   *
   * @param params - Buy shares parameters
   * @returns Object with shares purchased, average price, and position ID
   * @throws Error if buy action fails
   */
  private async handleBuyShares(
    params: A2AMethodParams | undefined,
  ): Promise<{ shares: number; avgPrice: number; positionId: string }> {
    if (!params || !this.isBuySharesParams(params)) {
      throw new Error(
        'Invalid params: must be an object with marketId (string), outcome ("YES" | "NO"), and amount (positive number)',
      );
    }

    const { marketId, outcome, amount } = params;

    const result = await this.engine.performAction("buy_prediction", {
      marketId,
      outcome,
      amount,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to buy shares");
    }

    const { positionId, shares } = result.result as {
      positionId: string;
      shares: number;
    };

    const state = this.engine.getGameState();
    const market = state.predictionMarkets.find(
      (m: { id: string }) => m.id === marketId,
    );
    const avgPrice = market
      ? outcome === "YES"
        ? market.yesPrice
        : market.noPrice
      : 0.5;

    return { shares, avgPrice, positionId };
  }

  /**
   * Type guard for SellSharesParams
   */
  private isSellSharesParams(
    params: A2AMethodParams,
  ): params is SellSharesParams {
    return (
      typeof params === "object" &&
      params !== null &&
      "marketId" in params &&
      "shares" in params &&
      typeof params.marketId === "string" &&
      typeof params.shares === "number" &&
      params.shares > 0
    );
  }

  /**
   * Sell prediction market shares
   *
   * Calculates proceeds from selling shares based on current market prices.
   *
   * @param params - Sell shares parameters
   * @returns Object with proceeds from sale
   * @throws Error if market not found
   */
  private async handleSellShares(
    params: A2AMethodParams | undefined,
  ): Promise<{ proceeds: number }> {
    if (!params || !this.isSellSharesParams(params)) {
      throw new Error(
        "Invalid params: must be an object with marketId (string) and shares (positive number)",
      );
    }

    const { marketId, shares } = params;

    // Simplified: calculate proceeds based on current market price
    const state = this.engine.getGameState();
    const market = state.predictionMarkets.find(
      (m: { id: string }) => m.id === marketId,
    );

    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }

    // Use average of yes and no prices as sell price
    const avgPrice = (market.yesPrice + market.noPrice) / 2;
    const proceeds = shares * avgPrice;

    return { proceeds };
  }

  /**
   * Get perpetual markets
   *
   * Returns all perpetual markets from the simulation state.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object containing array of perpetual markets
   */
  private handleGetPerpetuals(_params: A2AMethodParams | undefined): {
    perpetuals: PerpetualMarket[];
  } {
    const state = this.engine.getGameState();

    const perpetuals = state.perpetualMarkets.map((m: PerpetualMarket) => ({
      ticker: m.ticker,
      price: m.price,
      priceChange24h: m.priceChange24h,
      volume24h: m.volume24h,
      openInterest: m.openInterest,
      fundingRate: m.fundingRate,
      nextFundingTime: m.nextFundingTime,
    }));

    return { perpetuals };
  }

  /**
   * Type guard for OpenPositionParams
   */
  private isOpenPositionParams(
    params: A2AMethodParams,
  ): params is OpenPositionParams {
    return (
      typeof params === "object" &&
      params !== null &&
      "ticker" in params &&
      "side" in params &&
      "size" in params &&
      "leverage" in params &&
      typeof params.ticker === "string" &&
      (params.side === "LONG" || params.side === "SHORT") &&
      typeof params.size === "number" &&
      params.size > 0 &&
      typeof params.leverage === "number" &&
      params.leverage >= 1
    );
  }

  /**
   * Open perpetual position
   *
   * Executes an open position action through the simulation engine.
   *
   * @param params - Open position parameters
   * @returns Object with position ID and entry price
   * @throws Error if open action fails
   */
  private async handleOpenPosition(
    params: A2AMethodParams | undefined,
  ): Promise<{ positionId: string; entryPrice: number }> {
    if (!params || !this.isOpenPositionParams(params)) {
      throw new Error(
        'Invalid params: must be an object with ticker (string), side ("LONG" | "SHORT"), size (positive number), and leverage (>= 1)',
      );
    }

    const { ticker, side, size, leverage } = params;

    const result = await this.engine.performAction("open_perp", {
      ticker,
      side,
      size,
      leverage,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to open position");
    }

    const { positionId } = result.result as { positionId: string };

    const state = this.engine.getGameState();
    const market = state.perpetualMarkets.find(
      (m: { ticker: string }) => m.ticker === ticker,
    );

    return {
      positionId,
      entryPrice: market?.price || 0,
    };
  }

  /**
   * Type guard for ClosePositionParams
   */
  private isClosePositionParams(
    params: A2AMethodParams,
  ): params is ClosePositionParams {
    return (
      typeof params === "object" &&
      params !== null &&
      "positionId" in params &&
      typeof params.positionId === "string" &&
      params.positionId.length > 0
    );
  }

  /**
   * Close perpetual position
   *
   * Executes a close position action through the simulation engine.
   *
   * @param params - Close position parameters
   * @returns Object with P&L and exit price
   * @throws Error if close action fails
   */
  private async handleClosePosition(
    params: A2AMethodParams | undefined,
  ): Promise<{ pnl: number; exitPrice: number }> {
    if (!params || !this.isClosePositionParams(params)) {
      throw new Error(
        "Invalid params: must be an object with positionId (non-empty string)",
      );
    }

    const { positionId } = params;

    const result = await this.engine.performAction("close_perp", {
      positionId,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to close position");
    }

    const { pnl } = result.result as { pnl: number };

    return {
      pnl,
      exitPrice: 0, // Simplified
    };
  }

  /**
   * Get social feed
   *
   * Returns the last 20 posts from the simulation state.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object containing array of feed posts
   */
  private handleGetFeed(_params: A2AMethodParams | undefined): {
    posts: FeedPost[];
  } {
    const state = this.engine.getGameState();

    const posts = (state.posts || [])
      .slice(-20) // Last 20 posts
      .map((p: FeedPost) => ({
        id: p.id,
        authorId: p.authorId,
        authorName: p.authorName,
        content: p.content,
        createdAt: p.createdAt,
        likes: p.likes,
        comments: p.comments,
        marketId: p.marketId,
      }));

    return { posts };
  }

  /**
   * Type guard for CreatePostParams
   */
  private isCreatePostParams(
    params: A2AMethodParams,
  ): params is CreatePostParams {
    return (
      typeof params === "object" &&
      params !== null &&
      "content" in params &&
      typeof params.content === "string" &&
      params.content.trim().length > 0 &&
      ("marketId" in params
        ? typeof params.marketId === "string" &&
          params.marketId.trim().length > 0
        : true)
    );
  }

  /**
   * Create post
   *
   * Executes a create post action through the simulation engine.
   *
   * @param params - Create post parameters
   * @returns Object with created post ID
   * @throws Error if create action fails
   */
  private async handleCreatePost(
    params: A2AMethodParams | undefined,
  ): Promise<{ postId: string }> {
    if (!params || !this.isCreatePostParams(params)) {
      throw new Error(
        "Invalid params: must be an object with content (non-empty string) and optional marketId (non-empty string)",
      );
    }

    const { content, marketId } = params;

    const result = await this.engine.performAction("create_post", {
      content,
      marketId: marketId ?? null,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to create post");
    }

    const { postId } = result.result as { postId: string };

    return { postId };
  }

  /**
   * Get group chats
   *
   * Returns all group chats from the simulation state.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object containing array of group chats
   */
  private handleGetChats(_params: A2AMethodParams | undefined): {
    chats: ChatEntry[];
  } {
    const state = this.engine.getGameState();

    const chats: ChatEntry[] = (state.groupChats || []).map(
      (g: GroupChat): ChatEntry => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberIds.length,
        messageCount: g.messageCount,
        lastActivity: g.lastActivity,
        invited: g.invitedAgent ?? false,
        messages: g.messages ?? [],
      }),
    );

    return { chats };
  }

  /**
   * Type guard for JoinGroupParams
   */
  private isJoinGroupParams(
    params: A2AMethodParams,
  ): params is JoinGroupParams {
    return (
      typeof params === "object" &&
      params !== null &&
      "groupId" in params &&
      typeof params.groupId === "string" &&
      params.groupId.length > 0
    );
  }

  /**
   * Join group chat
   *
   * Executes a join group action through the simulation engine.
   *
   * @param params - Join group parameters
   * @returns Object indicating success status
   */
  private async handleJoinGroup(
    params: A2AMethodParams | undefined,
  ): Promise<{ success: boolean }> {
    if (!params || !this.isJoinGroupParams(params)) {
      throw new Error(
        "Invalid params: must be an object with groupId (non-empty string)",
      );
    }

    const { groupId } = params;

    const result = await this.engine.performAction("join_group", {
      groupId,
    });

    return { success: result.success };
  }

  /**
   * Get agent balance
   *
   * Returns the agent's current balance.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object with balance amount
   *
   * @remarks
   * Currently returns a fixed balance. Can be enhanced to track actual balance.
   */
  private handleGetBalance(_params: A2AMethodParams | undefined): {
    balance: number;
  } {
    // Simplified: return fixed balance
    return { balance: 10000 };
  }

  /**
   * Get portfolio (balance, positions, P&L)
   *
   * Returns comprehensive portfolio information including balance, positions, and P&L.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object with balance, positions array, and total P&L
   */
  private handleGetPortfolio(
    _params: A2AMethodParams | undefined,
  ): PortfolioResult {
    const state = this.engine.getGameState();
    const agent = state.agents.find(
      (a: { id: string }) => a.id === this.agentId,
    );

    // Calculate positions from agent's state
    const positions: PortfolioPosition[] = [];

    // Calculate P&L from agent's totalPnl
    const pnl = (agent as { totalPnl?: number } | undefined)?.totalPnl || 0;
    const balance = 10000 + pnl; // Starting balance + P&L

    return {
      balance,
      positions,
      pnl,
    };
  }

  /**
   * Get positions (prediction market + perp positions)
   *
   * Returns all active positions for the agent.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object with prediction and perpetual position arrays
   *
   * @remarks
   * Currently returns empty arrays. Can be enhanced to track actual positions.
   */
  private handleGetPositions(_params: A2AMethodParams | undefined): {
    predictionPositions: PortfolioPosition[];
    perpPositions: PortfolioPosition[];
  } {
    // Return empty arrays for simulation
    // In a real benchmark, we'd track actual positions made by the agent
    return {
      predictionPositions: [],
      perpPositions: [],
    };
  }

  /**
   * Get dashboard data (balance, recent activity, etc)
   *
   * Returns comprehensive dashboard information for the agent.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object with balance, reputation, total P&L, and active positions count
   */
  private handleGetDashboard(
    _params: A2AMethodParams | undefined,
  ): DashboardResult {
    const state = this.engine.getGameState();
    const agent = state.agents.find(
      (a: { id: string }) => a.id === this.agentId,
    );

    const pnl = (agent as { totalPnl?: number } | undefined)?.totalPnl || 0;
    const balance = 10000 + pnl;

    return {
      balance,
      reputation: 1000,
      totalPnl: pnl,
      activePositions: 0,
    };
  }

  /**
   * Get trending tags
   *
   * Returns trending topic tags with counts and trend directions.
   *
   * @param _params - Unused (kept for interface consistency)
   * @returns Object with array of trending tags
   *
   * @remarks
   * Currently returns dummy data. Can be enhanced to track actual trends.
   */
  private handleGetTrendingTags(_params: A2AMethodParams | undefined): {
    tags: TrendingTagEntry[];
  } {
    // Return some dummy trending tags for simulation
    return {
      tags: [
        { tag: "crypto", count: 150, trend: "up" },
        { tag: "ai", count: 120, trend: "up" },
        { tag: "markets", count: 90, trend: "stable" },
      ],
    };
  }

  /**
   * Check if connected (always true for simulation)
   *
   * @returns Always true for simulation interface
   */
  isConnected(): boolean {
    return true;
  }

  // ===== Wrapper methods for A2A client parity =====

  /**
   * Buy shares in prediction market
   *
   * Convenience wrapper for buyShares A2A method.
   *
   * @param marketId - Market ID to buy shares in
   * @param outcome - Outcome to buy (YES or NO)
   * @param amount - Amount to invest
   * @returns Result object with shares, avgPrice, and positionId
   */
  async buyShares(
    marketId: string,
    outcome: "YES" | "NO",
    amount: number,
  ): Promise<BuySharesResult> {
    return (await this.sendRequest("a2a.buyShares", {
      marketId,
      outcome,
      amount,
    })) as BuySharesResult;
  }

  /**
   * Sell shares from prediction market
   *
   * Convenience wrapper for sellShares A2A method.
   *
   * @param marketId - Market ID to sell shares from
   * @param shares - Number of shares to sell
   * @returns Result object with proceeds
   */
  async sellShares(
    marketId: string,
    shares: number,
  ): Promise<SellSharesResult> {
    return (await this.sendRequest("a2a.sellShares", {
      marketId,
      shares,
    })) as SellSharesResult;
  }

  /**
   * Open perp position
   *
   * Convenience wrapper for openPosition A2A method.
   *
   * @param ticker - Ticker symbol
   * @param side - Position side (long or short)
   * @param size - Position size
   * @param leverage - Leverage multiplier
   * @returns Result object with positionId and entryPrice
   */
  async openPosition(
    ticker: string,
    side: "long" | "short",
    size: number,
    leverage: number,
  ): Promise<OpenPositionResult> {
    return (await this.sendRequest("a2a.openPosition", {
      ticker,
      side: side.toUpperCase() as "LONG" | "SHORT",
      size,
      leverage,
    })) as OpenPositionResult;
  }

  /**
   * Close perp position
   *
   * Convenience wrapper for closePosition A2A method.
   *
   * @param positionId - Position ID to close
   * @returns Result object with pnl and exitPrice
   */
  async closePosition(positionId: string): Promise<ClosePositionResult> {
    return (await this.sendRequest("a2a.closePosition", {
      positionId,
    })) as ClosePositionResult;
  }

  /**
   * Create post
   *
   * Convenience wrapper for createPost A2A method.
   *
   * @param content - Post content
   * @param type - Post type (defaults to 'post')
   * @returns Result object with postId
   */
  async createPost(
    content: string,
    type: string = "post",
  ): Promise<CreatePostResult> {
    return (await this.sendRequest("a2a.createPost", {
      content,
      marketId: type === "market" ? undefined : undefined,
    })) as CreatePostResult;
  }

  /**
   * Create comment
   *
   * Convenience wrapper for createComment A2A method.
   *
   * @param postId - Post ID to comment on
   * @param content - Comment content
   * @returns Result object with commentId
   */
  async createComment(
    postId: string,
    content: string,
  ): Promise<CreateCommentResult> {
    return (await this.sendRequest("a2a.createComment", {
      content,
      marketId: postId,
    })) as CreateCommentResult;
  }

  /**
   * Get portfolio (balance, positions, P&L)
   *
   * Convenience wrapper for getPortfolio A2A method.
   *
   * @returns Portfolio object with balance, positions, and P&L
   */
  async getPortfolio(): Promise<PortfolioResult> {
    return (await this.sendRequest("a2a.getPortfolio")) as PortfolioResult;
  }

  /**
   * Get markets
   *
   * Returns both prediction markets and perpetual markets.
   *
   * @returns Object with predictions and perps arrays
   */
  async getMarkets(): Promise<{
    predictions: Omit<PredictionMarket, "resolved">[];
    perps: PerpetualMarket[];
  }> {
    const predictions = (await this.sendRequest("a2a.getPredictions", {
      status: "active",
    })) as { predictions: Omit<PredictionMarket, "resolved">[] };
    const perpetuals = (await this.sendRequest("a2a.getPerpetuals", {})) as {
      perpetuals: PerpetualMarket[];
    };
    return {
      predictions: predictions.predictions || [],
      perps: perpetuals.perpetuals || [],
    };
  }

  /**
   * Get feed
   *
   * Convenience wrapper for getFeed A2A method.
   *
   * @param limit - Maximum number of posts to return (default: 20)
   * @returns Object with posts array
   */
  async getFeed(limit = 20): Promise<{ posts: FeedPost[] }> {
    return (await this.sendRequest("a2a.getFeed", { limit, offset: 0 })) as {
      posts: FeedPost[];
    };
  }
}
