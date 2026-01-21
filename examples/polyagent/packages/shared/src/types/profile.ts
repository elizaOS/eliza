/**
 * Profile-related TypeScript types
 * Types for user profile widgets and data displays
 */

/**
 * Raw API response from /api/users/[userId]/balance
 * The API returns all numeric values as strings.
 */
export interface UserBalanceDataAPI {
  balance: string;
  totalDeposited: string;
  totalWithdrawn: string;
  lifetimePnL: string;
}

/**
 * Parsed user balance data with numeric values.
 * Use this type after converting the raw API response.
 */
export interface UserBalanceData {
  balance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  lifetimePnL: number;
}

/**
 * Converts raw API balance response to parsed numeric values.
 */
export function parseUserBalanceData(api: UserBalanceDataAPI): UserBalanceData {
  return {
    balance: Number(api.balance) || 0,
    totalDeposited: Number(api.totalDeposited) || 0,
    totalWithdrawn: Number(api.totalWithdrawn) || 0,
    lifetimePnL: Number(api.lifetimePnL) || 0,
  };
}

/**
 * Base prediction market position from /api/markets/positions/[userId]
 */
export interface PredictionPosition {
  id: string;
  marketId: string;
  question: string;
  side: "YES" | "NO";
  shares: number;
  avgPrice: number;
  currentPrice: number;
  /** Current probability (derived from market shares) */
  currentProbability: number;
  /** Current market value of the position */
  currentValue: number;
  /** Original cost of the position (shares × avgPrice) */
  costBasis: number;
  /** Unrealized profit/loss (currentValue - costBasis) */
  unrealizedPnL: number;
  resolved: boolean;
  resolution?: boolean | null;
}

/**
 * Extended prediction position with PnL calculations for user portfolio views.
 * This type is now identical to PredictionPosition since the base type
 * includes all computed fields from the API.
 * @deprecated Use PredictionPosition directly - all fields are now included
 */
export interface UserPredictionPosition extends PredictionPosition {}

/**
 * User profile statistics
 */
export interface UserProfileStats {
  following: number;
  followers: number;
  totalActivity: number;
  positions?: number;
  comments?: number;
  reactions?: number;
}

/**
 * Perp position from API response (/api/markets/positions/[userId])
 * This matches the actual API response structure
 */
export interface PerpPositionFromAPI {
  id: string;
  ticker: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  liquidationPrice: number;
  fundingPaid: number;
  openedAt: string;
}
