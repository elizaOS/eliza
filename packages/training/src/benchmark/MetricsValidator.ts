/**
 * Metrics Validator
 *
 * Validates that benchmark metrics are calculated correctly against ground truth.
 */

import type { ValidationResult } from "../training/ConfigValidator";
import { logger } from "../utils/logger";
import type { GroundTruth } from "./BenchmarkDataGenerator";
import type { AgentAction, SimulationMetrics } from "./simulation-types";

function validatePredictionMetrics(
  _predictionMetrics: SimulationMetrics["predictionMetrics"],
  actions: AgentAction[],
  groundTruth: GroundTruth,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Get all prediction actions
  const predictionActions = actions.filter(
    (a) => a.type === "buy_prediction",
  );

  // Validate each action against ground truth
  for (const action of predictionActions) {
    const data = action.data as { marketId: string; outcome: string };
    const marketId = data.marketId;

    // Check if we have ground truth for this market
    if (!(marketId in groundTruth.marketOutcomes)) {
      warnings.push(`No ground truth for market ${marketId}`);
    }

    // Verify the outcome exists in ground truth
    // (actual verification of correctness happens in SimulationEngine)
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate metrics against ground truth
 */
export function validateMetrics(
  metrics: SimulationMetrics,
  actions: AgentAction[],
  groundTruth: GroundTruth,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Validate prediction accuracy calculation
  const predictionValidation = validatePredictionMetrics(
    metrics.predictionMetrics,
    actions,
    groundTruth,
  );
  errors.push(...predictionValidation.errors);
  warnings.push(...predictionValidation.warnings);

  // 2. Validate optimality score is in valid range
  if (metrics.optimalityScore < 0 || metrics.optimalityScore > 100) {
    errors.push(`Optimality score out of range: ${metrics.optimalityScore}`);
  }

  // 3. Validate timing metrics are reasonable
  if (metrics.timing.avgResponseTime < 0) {
    errors.push(
      `Invalid average response time: ${metrics.timing.avgResponseTime}`,
    );
  }

  if (metrics.timing.maxResponseTime < metrics.timing.avgResponseTime) {
    errors.push(
      `Max response time less than average: ${metrics.timing.maxResponseTime} < ${metrics.timing.avgResponseTime}`,
    );
  }

  // 4. Validate action counts match
  const predictionActions = actions.filter(
    (a) => a.type === "buy_prediction",
  );
  if (predictionActions.length !== metrics.predictionMetrics.totalPositions) {
    warnings.push(
      `Prediction action count mismatch: ${predictionActions.length} actions vs ${metrics.predictionMetrics.totalPositions} positions`,
    );
  }

  // 5. Validate accuracy calculation
  const { correctPredictions, incorrectPredictions, totalPositions } =
    metrics.predictionMetrics;
  const calculatedAccuracy =
    totalPositions > 0 ? correctPredictions / totalPositions : 0;
  const accuracyDiff = Math.abs(
    calculatedAccuracy - metrics.predictionMetrics.accuracy,
  );

  if (accuracyDiff > 0.01) {
    // Allow 1% tolerance for floating point
    errors.push(
      `Accuracy calculation mismatch: reported ${metrics.predictionMetrics.accuracy}, calculated ${calculatedAccuracy}`,
    );
  }

  // 6. Validate correct + incorrect = total
  if (correctPredictions + incorrectPredictions !== totalPositions) {
    errors.push(
      `Prediction count mismatch: ${correctPredictions} + ${incorrectPredictions} != ${totalPositions}`,
    );
  }

  // 7. Validate perp win rate calculation
  if (metrics.perpMetrics.totalTrades > 0) {
    const calculatedWinRate =
      metrics.perpMetrics.profitableTrades / metrics.perpMetrics.totalTrades;
    const winRateDiff = Math.abs(
      calculatedWinRate - metrics.perpMetrics.winRate,
    );

    if (winRateDiff > 0.01) {
      errors.push(
        `Win rate calculation mismatch: reported ${metrics.perpMetrics.winRate}, calculated ${calculatedWinRate}`,
      );
    }
  }

  logger.info("Metrics validation complete", {
    valid: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Quick sanity check for metrics
 */
export function metricsSanityCheck(metrics: SimulationMetrics): boolean {
  // Basic sanity checks
  if (metrics.optimalityScore < 0 || metrics.optimalityScore > 100)
    return false;
  if (
    metrics.predictionMetrics.accuracy < 0 ||
    metrics.predictionMetrics.accuracy > 1
  )
    return false;
  if (metrics.perpMetrics.winRate < 0 || metrics.perpMetrics.winRate > 1)
    return false;
  if (metrics.timing.avgResponseTime < 0) return false;
  if (metrics.timing.maxResponseTime < 0) return false;

  return true;
}

/** @deprecated Use validateMetrics and metricsSanityCheck instead */
export const MetricsValidator = {
  validate: validateMetrics,
  sanityCheck: metricsSanityCheck,
};
