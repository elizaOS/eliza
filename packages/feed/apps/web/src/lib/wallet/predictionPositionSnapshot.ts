import {
  calculatePredictionPositionSnapshot as calculateCorePredictionPositionSnapshot,
  type PredictionPositionSnapshot,
} from "@feed/core/markets/prediction";

export type { PredictionPositionSnapshot };

export function calculatePredictionPositionSnapshot(params: {
  shares: number;
  avgPrice: number;
  sideKey: "yes" | "no";
  yesShares: number;
  noShares: number;
  feeRate: number;
  resolved?: boolean;
  resolution?: boolean | null;
  onSellPreviewError?: "fallback" | "throw";
  logContext?: string;
}): PredictionPositionSnapshot {
  return calculateCorePredictionPositionSnapshot({
    shares: params.shares,
    avgPrice: params.avgPrice,
    side: params.sideKey,
    yesShares: params.yesShares,
    noShares: params.noShares,
    feeRate: params.feeRate,
    resolved: params.resolved,
    resolution: params.resolution,
  });
}
