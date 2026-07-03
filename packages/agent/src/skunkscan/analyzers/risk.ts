import {
  WalletActivitySummary,
  WalletRiskSummary,
} from "../types";

export function analyzeWalletRisk(
  solBalance: number,
  activity: WalletActivitySummary,
): WalletRiskSummary {
  const reasons: string[] = [];
  let score = 0;

  if (solBalance === 0) {
    score += 5;
    reasons.push("Wallet currently has zero SOL balance.");
  }

  if (activity.failedTransactionCount > 0) {
    score += Math.min(activity.failedTransactionCount * 10, 30);

    reasons.push(
      `${activity.failedTransactionCount} failed transaction(s) found in the recent sample.`,
    );
  }

  if (activity.recentTransactionCount === 0) {
    score += 10;
    reasons.push("No recent transaction activity found.");
  } else {
    reasons.push("Wallet has recent transaction activity.");
  }

  if (reasons.length === 0) {
    reasons.push("No obvious risk signals found in the current sample.");
  }

  const level =
    score >= 60
      ? "high"
      : score >= 25
        ? "medium"
        : "low";

  return {
    score,
    level,
    reasons,
  };
}
