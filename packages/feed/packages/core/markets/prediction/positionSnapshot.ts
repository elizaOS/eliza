/**
 * Derives the live valuation of a prediction-market position — cost basis, current
 * probability and unit price, mark-to-market value, and unrealized PnL — from its shares
 * and the current CPMM pool. For resolved markets the outcome fixes the unit price; for
 * open markets value is a fee-aware sell preview, with a caller-selectable fallback when
 * that preview cannot be computed.
 */
import { PredictionPricing } from "./pricing";

export interface PredictionPositionSnapshot {
  costBasis: number;
  currentProbability: number;
  currentUnitPrice: number;
  currentValue: number;
  unrealizedPnL: number;
}

export function calculatePredictionPositionSnapshot(params: {
  shares: number;
  avgPrice: number;
  side: "yes" | "no";
  yesShares: number;
  noShares: number;
  feeRate: number;
  resolved?: boolean;
  resolution?: boolean | null;
  onSellPreviewError?: "fallback" | "throw";
}): PredictionPositionSnapshot {
  const {
    shares,
    avgPrice,
    side,
    yesShares,
    noShares,
    feeRate,
    resolved = false,
    resolution = null,
    onSellPreviewError = "fallback",
  } = params;

  const costBasisNet = shares * avgPrice;
  const costBasis =
    feeRate > 0 && feeRate < 1 ? costBasisNet / (1 - feeRate) : costBasisNet;

  const currentProbability =
    yesShares + noShares > 0
      ? PredictionPricing.getCurrentPrice(yesShares, noShares, side)
      : 0.5;

  if (resolved && resolution !== null) {
    const isWinningSide =
      (side === "yes" && resolution) || (side === "no" && !resolution);
    const currentValue = isWinningSide ? shares : 0;

    return {
      costBasis,
      currentProbability: isWinningSide ? 1 : 0,
      currentUnitPrice: isWinningSide && shares > 0 ? 1 : 0,
      currentValue,
      unrealizedPnL: currentValue - costBasis,
    };
  }

  if (shares <= 0 || yesShares <= 0 || noShares <= 0) {
    return {
      costBasis,
      currentProbability,
      currentUnitPrice: shares > 0 ? costBasis / shares : 0,
      currentValue: costBasis,
      unrealizedPnL: 0,
    };
  }

  let currentValue = costBasis;

  try {
    const sellPreview = PredictionPricing.calculateSellWithFees(
      yesShares,
      noShares,
      side,
      shares,
      feeRate,
    );
    currentValue = sellPreview.netProceeds ?? sellPreview.totalCost;
  } catch (error) {
    if (onSellPreviewError === "throw") {
      throw error;
    }
  }

  return {
    costBasis,
    currentProbability,
    currentUnitPrice: shares > 0 ? currentValue / shares : 0,
    currentValue,
    unrealizedPnL: currentValue - costBasis,
  };
}
