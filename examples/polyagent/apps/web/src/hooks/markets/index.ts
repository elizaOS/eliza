/**
 * Markets hooks index
 *
 * Centralized exports for all market-related hooks.
 * This makes imports cleaner and provides a single entry point.
 *
 * @example
 * ```tsx
 * import {
 *   useMarketPrices,
 *   usePerpMarketStream,
 *   usePerpTrade,
 * } from '@/hooks/markets';
 * ```
 */

// Wallet balance (from centralized store)
export {
  invalidateWalletBalance,
  refreshWalletBalance,
  useWalletBalance,
  useWalletBalancePolling,
} from "../../stores/walletBalanceStore";
// Price feeds & SSE
export { type LivePrice, useMarketPrices } from "../useMarketPrices";
export { usePerpHistory } from "../usePerpHistory";
// Perp markets
export {
  type PerpTradeSSE,
  usePerpMarketStream,
  usePerpMarketsSubscription,
} from "../usePerpMarketStream";
export { type TradeSide, usePerpTrade } from "../usePerpTrade";
export { usePortfolioPnL } from "../usePortfolioPnL";
export { usePredictionHistory } from "../usePredictionHistory";
// Prediction markets
export {
  type PredictionResolutionSSE,
  type PredictionTradeSSE,
  usePredictionMarketStream,
} from "../usePredictionMarketStream";
export { useSSEChannel, useSSEStatus } from "../useSSE";
// User data
export { useUserPositions } from "../useUserPositions";
