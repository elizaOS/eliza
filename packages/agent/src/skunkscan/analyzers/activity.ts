import { WalletActivitySummary, WalletRecentTransaction } from "../types";

export function analyzeWalletActivity(
  recentTransactions: WalletRecentTransaction[],
): WalletActivitySummary {
  const failedTransactionCount = recentTransactions.filter(
    (tx) => tx.status === "failed",
  ).length;

  const lastActiveAt =
    recentTransactions.length > 0 ? recentTransactions[0].blockTime : null;

  const activityLevel =
    recentTransactions.length === 0
      ? "none"
      : recentTransactions.length <= 3
        ? "low"
        : recentTransactions.length <= 10
          ? "medium"
          : "high";

  return {
    recentTransactionCount: recentTransactions.length,
    failedTransactionCount,
    lastActiveAt,
    activityLevel,
  };
}
