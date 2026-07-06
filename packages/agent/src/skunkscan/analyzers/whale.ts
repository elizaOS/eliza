import { WalletPortfolioSummary, WalletWhaleSummary } from "../types";

export function analyzeWalletWhaleStatus(
  portfolio: WalletPortfolioSummary,
): WalletWhaleSummary {
  const estimatedPortfolioUsdValue =
    typeof portfolio.estimatedTotalUsdValue === "number"
      ? portfolio.estimatedTotalUsdValue
      : null;

  const reasons: string[] = [];
  let whaleScore = 0;

  if (estimatedPortfolioUsdValue === null) {
    reasons.push("Wallet whale status could not be fully evaluated because USD valuation is unavailable.");
  } else if (estimatedPortfolioUsdValue >= 1_000_000) {
    whaleScore += 100;
    reasons.push("Estimated portfolio value is at least $1,000,000.");
  } else if (estimatedPortfolioUsdValue >= 250_000) {
    whaleScore += 70;
    reasons.push("Estimated portfolio value is at least $250,000.");
  } else if (estimatedPortfolioUsdValue >= 50_000) {
    whaleScore += 40;
    reasons.push("Estimated portfolio value is at least $50,000.");
  } else {
    reasons.push("Estimated portfolio value is below whale thresholds.");
  }

  if (portfolio.concentrationLevel === "high") {
    whaleScore += 10;
    reasons.push("Portfolio is highly concentrated in its largest holding.");
  }

  const whaleLevel =
    whaleScore >= 90
      ? "large"
      : whaleScore >= 60
        ? "medium"
        : whaleScore >= 30
          ? "small"
          : "none";

  return {
    isWhale: whaleLevel !== "none",
    whaleScore,
    whaleLevel,
    estimatedPortfolioUsdValue,
    reasons,
  };
}
