/**
 * Perpetual Futures Trading Types
 *
 * Defines all types for perps markets:
 * - Positions (long/short with leverage)
 * - Funding rates
 * - Liquidation mechanics
 * - PnL calculations
 */

export interface PerpPosition {
  id: string;
  userId: string;
  ticker: string; // Company ticker (e.g., "FACEHOOK")
  organizationId: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number; // Position size in USD
  leverage: number; // 1x to 100x
  liquidationPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  fundingPaid: number; // Cumulative funding paid/received
  openedAt: string; // ISO timestamp
  lastUpdated: string;
  closedAt?: string | null; // ISO timestamp when position was closed, null if open
  // Agent position metadata (optional)
  isAgentPosition?: boolean; // True if this position belongs to an agent
  agentId?: string; // Agent's user ID (only set if isAgentPosition=true)
  agentName?: string; // Agent's display name (only set if isAgentPosition=true)
}

export interface FundingRate {
  ticker: string;
  rate: number; // APR as decimal (e.g., 0.01 = 1%)
  nextFundingTime: string; // ISO timestamp
  predictedRate: number; // Next period's estimated rate
}

export interface PerpMarket {
  ticker: string;
  organizationId: string;
  name: string;
  /**
   * Canonical public market price for the instrument.
   *
   * Convention:
   * - this is the live public mid/spot price
   * - bid/ask/spread/depth are derived around it
   * - execution price can differ from it based on side/size
   * - it is not the internal fair value and not the liquidation mark price
   */
  currentPrice: number;
  change24h: number; // Dollar change
  changePercent24h: number; // Percentage change
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: number; // Total USD value of open positions
  fundingRate: FundingRate;
  maxLeverage: number;
  minOrderSize: number;
  bidPrice?: number;
  askPrice?: number;
  spreadBps?: number;
  bidDepth?: number;
  askDepth?: number;
  liquidityRegime?: 'thin' | 'balanced' | 'deep';
  maxPositionSize: number; // Maximum single position size (based on liquidity)
  markPrice: number; // Fair price for liquidations
  indexPrice: number; // Spot price reference
}

export interface OrderRequest {
  ticker: string;
  side: 'long' | 'short';
  size: number; // USD size
  leverage: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
}

export interface PositionUpdate {
  positionId: string;
  action: 'increase' | 'decrease' | 'close';
  amount?: number; // USD amount to add/remove
  newLeverage?: number;
}

export interface Liquidation {
  positionId: string;
  ticker: string;
  side: 'long' | 'short';
  liquidationPrice: number;
  actualPrice: number;
  loss: number;
  timestamp: string;
}

export interface DailyPriceSnapshot {
  date: string; // YYYY-MM-DD
  ticker: string;
  organizationId: string;
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  timestamp: string; // EOD timestamp
}

export interface TradingStats {
  totalVolume: number;
  totalTrades: number;
  totalPnL: number;
  winRate: number; // Percentage
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  totalFundingPaid: number;
  totalLiquidations: number;
}

/**
 * Calculate liquidation price for a position
 */
export function calculateLiquidationPrice(
  entryPrice: number,
  side: 'long' | 'short',
  leverage: number
): number {
  // Liquidation happens when loss reaches full margin (1/leverage).
  // Matches Hyperliquid-style mechanics: initial margin = 1/leverage.
  const liquidationThreshold = 1 / leverage;

  if (side === 'long') {
    return entryPrice * (1 - liquidationThreshold);
  }
  return entryPrice * (1 + liquidationThreshold);
}

/**
 * Calculate unrealized PnL for a position
 */
export function calculateUnrealizedPnL(
  entryPrice: number,
  currentPrice: number,
  side: 'long' | 'short',
  size: number
): { pnl: number; pnlPercent: number } {
  let pnl: number;

  if (side === 'long') {
    pnl = ((currentPrice - entryPrice) / entryPrice) * size;
  } else {
    pnl = ((entryPrice - currentPrice) / entryPrice) * size;
  }

  const pnlPercent = (pnl / size) * 100;

  return { pnl, pnlPercent };
}

/**
 * Calculate funding payment for a single 8-hour period
 * Funding is paid every 8 hours based on the funding rate
 *
 * @param positionSize - Position size in USD
 * @param fundingRate - Annual funding rate (e.g., 0.01 = 1% per year)
 * @returns Funding payment for one 8-hour period
 */
export function calculateFundingPayment(
  positionSize: number,
  fundingRate: number
): number {
  // Funding rate is annual, convert to single 8-hour period
  // Annual → 8-hour: rate / (365.25 * 24 / 8) = rate / 1095.75
  const fundingPerPeriod = fundingRate / 1095.75;

  return positionSize * fundingPerPeriod;
}

/**
 * Check if position should be liquidated
 */
export function shouldLiquidate(
  currentPrice: number,
  liquidationPrice: number,
  side: 'long' | 'short'
): boolean {
  if (side === 'long') {
    return currentPrice <= liquidationPrice;
  }
  return currentPrice >= liquidationPrice;
}

/**
 * Calculate mark price (fair value for liquidations)
 * Uses weighted average of index price and last price
 */
export function calculateMarkPrice(
  indexPrice: number,
  lastPrice: number,
  fundingRate: number
): number {
  // Simple mark price: 70% index, 30% last, adjusted by funding
  const baseMarkPrice = indexPrice * 0.7 + lastPrice * 0.3;

  // Adjust slightly based on funding rate (indicates market bias)
  const fundingAdjustment = fundingRate * 0.01;

  return baseMarkPrice * (1 + fundingAdjustment);
}
