import type {
  BroadcastPort,
  CachePort,
  ClockPort,
  FeeConfig,
  FeeProcessor,
  TradingFeeOutboxPort,
  WalletPort,
} from "../shared/common";

export type { WalletPort } from "../shared/common";

export type PerpSide = "long" | "short";

export interface PerpMarketRecord {
  ticker: string;
  organizationId: string;
  /** Display name; prefer Organization.name when joined from DB. */
  name?: string;
  /** Company logo from Organization.imageUrl when available. */
  imageUrl?: string | null;
  /**
   * Canonical public market price for the instrument.
   *
   * Convention:
   * - this is the live public mid/spot price for the market
   * - quote state is derived around it
   * - execution price may differ from it based on side/size
   * - it is not the internal fair value (`latentPrice`)
   * - it is not the liquidation/reference mark price
   */
  currentPrice: number;
  /** Price from 24 hours ago (for accurate change calculation) */
  price24hAgo?: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: {
    ticker: string;
    rate: number;
    nextFundingTime: string;
    predictedRate: number;
  };
  maxLeverage: number;
  minOrderSize: number;
  bidPrice?: number;
  askPrice?: number;
  spreadBps?: number;
  bidDepth?: number;
  askDepth?: number;
  liquidityRegime?: "thin" | "balanced" | "deep";
  quoteUpdatedAt?: Date;
  markPrice?: number;
  indexPrice?: number;
}

export interface PerpPositionRecord {
  id: string;
  userId: string;
  ticker: string;
  organizationId: string;
  side: PerpSide;
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  liquidationPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  fundingPaid: number;
  openedAt: Date;
  lastUpdated: Date;
  closedAt?: Date | null;
  realizedPnL?: number | null;
}

export interface PerpDbPort {
  listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PerpMarketRecord[]>;
  /** Row count for pagination (full snapshot table). */
  countMarkets(): Promise<number>;
  listOpenPositions(): Promise<PerpPositionRecord[]>;
  getPositionById(id: string): Promise<PerpPositionRecord | null>;
  /** Get all open positions for a user */
  getOpenPositionsByUser(userId: string): Promise<PerpPositionRecord[]>;
  /** Get existing open position for user on specific ticker (for consolidation) */
  getOpenPositionByUserAndTicker(
    userId: string,
    ticker: string,
  ): Promise<PerpPositionRecord | null>;
  /**
   * Lock and return an open position row for mutation.
   * Returns null if the position does not exist or is already closed.
   */
  lockOpenPositionById(id: string): Promise<PerpPositionRecord | null>;
  upsertPosition(
    position: Omit<PerpPositionRecord, "id"> & { id?: string },
  ): Promise<PerpPositionRecord>;
  /**
   * Execute operations within a transaction for atomicity.
   * If the callback throws, all changes are rolled back.
   */
  transaction<T>(fn: (tx: PerpDbPort) => Promise<T>): Promise<T>;
  updateOpenPosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | "currentPrice"
        | "unrealizedPnL"
        | "unrealizedPnLPercent"
        | "fundingPaid"
        | "liquidationPrice"
        | "lastUpdated"
        | "size"
        | "entryPrice"
      >
    >,
  ): Promise<void>;
  closePosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | "currentPrice"
        | "closedAt"
        | "realizedPnL"
        | "unrealizedPnL"
        | "unrealizedPnLPercent"
      >
    >,
  ): Promise<void>;
  updateMarketStats(
    ticker: string,
    updates: Partial<
      Pick<
        PerpMarketRecord,
        | "currentPrice"
        | "price24hAgo"
        | "change24h"
        | "changePercent24h"
        | "high24h"
        | "low24h"
        | "volume24h"
        | "openInterest"
        | "fundingRate"
        | "bidPrice"
        | "askPrice"
        | "spreadBps"
        | "bidDepth"
        | "askDepth"
        | "liquidityRegime"
        | "quoteUpdatedAt"
        | "markPrice"
        | "indexPrice"
      >
    >,
  ): Promise<void>;
}

// DTOs
export interface PerpOpenInput {
  userId: string;
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  /** Maximum slippage tolerance (0-1, e.g., 0.01 = 1%). Rejects if price moved beyond this. */
  maxSlippage?: number;
}

export interface PerpCloseInput {
  userId: string;
  positionId: string;
  /** Close only a portion of the position (0-1, e.g., 0.5 = 50%). Defaults to 1 (full close). */
  percentage?: number;
  /** Override exit price for liquidations or testing. */
  exitPriceOverride?: number;
  /** Maximum slippage tolerance (0-1). Rejects if price moved beyond this. */
  maxSlippage?: number;
}

export interface PerpTradeResult {
  positionId: string;
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  entryPrice: number;
  /** Exit price (present on close operations) */
  exitPrice?: number;
  liquidationPrice: number;
  marginPaid?: number;
  /** Realized P&L from the trade (present on close operations) */
  realizedPnL?: number;
  feePaid: number;
  balance?: number;
  /** If partial close, the remaining position size (present on close operations) */
  remainingSize?: number;
  /** True if position was fully closed (present on close operations) */
  fullyClosed?: boolean;
  /** True if this trade modified an existing position (rebalance) */
  isRebalance?: boolean;
  /** Type of rebalance operation performed */
  rebalanceType?: "add" | "reduce" | "close" | "flip";
  /** Previous position size before modification */
  previousSize?: number;
  /** Previous entry price before modification */
  previousEntryPrice?: number;
}

export interface PerpOpenExecutionPreview {
  previewType?: "open" | "add" | "reduce" | "close" | "flip";
  isRebalance?: boolean;
  rebalanceType?: "add" | "reduce" | "close" | "flip";
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  /**
   * Canonical public market price.
   * See PerpMarketRecord.currentPrice for the contract of this field.
   */
  currentPrice: number;
  markPrice?: number;
  indexPrice?: number;
  quotedPrice: number;
  executionPrice: number;
  quoteImpactPrice: number;
  quoteImpactBps: number;
  totalSlippageBps: number;
  bidPrice: number;
  askPrice: number;
  spreadBps: number;
  bidDepth: number;
  askDepth: number;
  liquidityRegime: "thin" | "balanced" | "deep";
  marginRequired: number;
  estimatedFee: number;
  totalRequired: number;
  resultingSize?: number;
  resultingSide?: PerpSide | null;
  estimatedClosePrice?: number;
  estimatedCloseSettlement?: number;
  liquidationPrice: number;
  liquidationDistancePercent: number;
}

/**
 * Port for applying post-trade price impact and retrieving the resulting price.
 *
 * When provided, the service will:
 * 1. Apply price impact after opening/adding/flipping a position
 * 2. Update the position's entry price to the post-impact price
 *
 * This prevents the "self-impact profit exploit" where a user profits from
 * the price movement caused by their own trade.
 */
export interface PriceImpactPort {
  /**
   * Apply price impact for a ticker and return the new market price.
   * Returns undefined if no impact was applied or the price didn't change.
   */
  applyAndGetPrice(ticker: string): Promise<number | undefined>;

  /**
   * Get the base/initial price for a ticker.
   *
   * Used for **symmetric** slippage clamping so that the max impact is
   * identical on both the open and close legs of a trade.  Without this,
   * percentage-based clamping (10% of currentPrice) is asymmetric and
   * creates a small arbitrage on round-trips.
   */
  getBasePrice?(ticker: string): Promise<number | undefined>;
}

/** Lightweight observability port for domain-level counters (Datadog, Grafana, etc.) */
export interface MetricsPort {
  increment(name: string, value: number, tags?: Record<string, string>): void;
}

// Service deps bundle (optional helper)
export interface PerpServiceDeps {
  db: PerpDbPort;
  wallet: WalletPort;
  broadcast?: BroadcastPort;
  cache?: CachePort;
  clock?: ClockPort;
  fees: FeeConfig;
  feeProcessor?: FeeProcessor;
  /** When set, failed fee processing (after retries) is persisted for cron/worker drain */
  tradingFeeOutbox?: TradingFeeOutboxPort;
  /** Optional price impact port to prevent self-impact exploits */
  priceImpact?: PriceImpactPort;
  /** Optional metrics port for operational counters */
  metrics?: MetricsPort;
}
