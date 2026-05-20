/**
 * Reputation Module
 *
 * Exports all reputation-related services and utilities.
 */

// PNL Normalization utilities
export {
  calculateAverageROI,
  calculateConfidenceScore,
  calculateSharpeRatio,
  calculateWinRate,
  denormalizePnL,
  getTrustLevel,
  normalizePnL,
} from './pnl-normalizer';

// Reputation Calculation Service
export {
  calculateGameScore,
  calculateReputationScore,
  calculateTradeScore,
  type GameMetrics,
  generateBatchGameFeedback,
  generateGameCompletionFeedback,
  generateTradeCompletionFeedback,
  getReputationBreakdown,
  getReputationLeaderboard,
  type ReputationScoreBreakdown,
  recalculateReputation,
  type TradeMetrics,
  updateFeedbackMetrics,
  updateGameMetrics,
  updateTradingMetrics,
} from './reputation-calculation-service';

// Trade Feedback Calculator
export {
  calculateEntryTimingScore,
  calculateExitTimingScore,
  calculateRiskScore,
  calculateTradeMetrics,
  getTradeFeedbackSummary,
} from './trade-feedback-calculator';
