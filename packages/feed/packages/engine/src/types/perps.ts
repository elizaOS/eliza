/**
 * Perpetual Futures Trading Types
 *
 * Defines all types for perps markets:
 * - Positions (long/short with leverage)
 * - Funding rates
 * - Liquidation mechanics
 * - PnL calculations
 */

import { MARKET_CONFIG } from '../config/fees';

export interface PerpPosition {
  id: string;
  userId: string;
  ticker: string;
  organizationId: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  liquidationPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  fundingPaid: number;
  openedAt: string;
  lastUpdated: string;
}

export interface FundingRate {
  ticker: string;
  rate: number;
  nextFundingTime: string;
  predictedRate: number;
}

export interface PerpMarket {
  ticker: string;
  organizationId: string;
  name: string;
  currentPrice: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: FundingRate;
  maxLeverage: number;
  minOrderSize: number;
  maxPositionSize: number; // Maximum single position size (based on liquidity)
  markPrice: number;
  indexPrice: number;
}

export interface OrderRequest {
  ticker: string;
  side: 'long' | 'short';
  size: number;
  leverage: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
}

export interface PositionUpdate {
  positionId: string;
  action: 'increase' | 'decrease' | 'close';
  amount?: number;
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
  date: string;
  ticker: string;
  organizationId: string;
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  timestamp: string;
}

export interface TradingStats {
  totalVolume: number;
  totalTrades: number;
  totalPnL: number;
  winRate: number;
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
  // Liquidation at full margin loss (1/leverage). Matches Hyperliquid-style mechanics.
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
 */
export function calculateFundingPayment(
  positionSize: number,
  fundingRate: number
): number {
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
 */
export function calculateMarkPrice(
  indexPrice: number,
  lastPrice: number,
  fundingRate: number
): number {
  const baseMarkPrice = indexPrice * 0.7 + lastPrice * 0.3;
  const fundingAdjustment = fundingRate * 0.01;
  return baseMarkPrice * (1 + fundingAdjustment);
}

/**
 * Calculate the maximum allowed position size for a market
 * Based on configured ratio of open interest with a minimum floor
 */
export function calculateMaxPositionSize(openInterest: number): number {
  const openInterestLimit =
    openInterest * MARKET_CONFIG.OPEN_INTEREST_LIMIT_RATIO;
  return Math.max(openInterestLimit, MARKET_CONFIG.MIN_MAX_POSITION_SIZE);
}
