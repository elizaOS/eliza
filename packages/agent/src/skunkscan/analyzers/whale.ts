import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletFundingSummary,
  WalletPortfolioSummary,
  WalletRiskSummary,
  WalletWhaleSummary,
} from "../types";

export function analyzeWalletWhaleStatus(
  portfolio: WalletPortfolioSummary,
  age: WalletAgeSummary,
  activity: WalletActivitySummary,
  funding: WalletFundingSummary,
  risk: WalletRiskSummary,
): WalletWhaleSummary {
  const estimatedPortfolioUsdValue =
    typeof portfolio.estimatedTotalUsdValue === "number"
      ? portfolio.estimatedTotalUsdValue
      : null;

  const reasons: string[] = [];
  let whaleScore = 0;

  if (estimatedPortfolioUsdValue === null) {
    reasons.push("USD portfolio value is unavailable, so wallet size confidence is limited.");
  } else if (estimatedPortfolioUsdValue >= 1_000_000) {
    whaleScore += 40;
    reasons.push("Estimated portfolio value is at least $1,000,000.");
  } else if (estimatedPortfolioUsdValue >= 250_000) {
    whaleScore += 30;
    reasons.push("Estimated portfolio value is at least $250,000.");
  } else if (estimatedPortfolioUsdValue >= 50_000) {
    whaleScore += 20;
    reasons.push("Estimated portfolio value is at least $50,000.");
  } else {
    reasons.push("Estimated portfolio value is below whale thresholds.");
  }

  if (age.classification === "veteran") {
    whaleScore += 20;
    reasons.push("Wallet has veteran age classification.");
  } else if (age.classification === "established") {
    whaleScore += 12;
    reasons.push("Wallet has established age classification.");
  } else if (age.classification === "new") {
    whaleScore += 3;
    reasons.push("Wallet is newly created or recently first observed.");
  } else {
    reasons.push("Wallet age is unknown.");
  }

  if (activity.activityLevel === "high") {
    whaleScore += 15;
    reasons.push("Wallet has high recent activity.");
  } else if (activity.activityLevel === "medium") {
    whaleScore += 10;
    reasons.push("Wallet has medium recent activity.");
  } else if (activity.activityLevel === "low") {
    whaleScore += 5;
    reasons.push("Wallet has low recent activity.");
  } else {
    reasons.push("Wallet has no recent activity in the current sample.");
  }

  if (portfolio.diversityLevel === "high") {
    whaleScore += 10;
    reasons.push("Wallet portfolio has high token diversity.");
  } else if (portfolio.diversityLevel === "medium") {
    whaleScore += 6;
    reasons.push("Wallet portfolio has medium token diversity.");
  } else if (portfolio.diversityLevel === "low") {
    whaleScore += 2;
    reasons.push("Wallet portfolio has low token diversity.");
  } else {
    reasons.push("Wallet has no detected token portfolio diversity.");
  }

  if (funding.fundingSourceType === "exchange") {
    whaleScore += 10;
    reasons.push("Wallet appears to have been funded by a centralized exchange.");
  } else if (funding.fundingSourceType === "bridge") {
    whaleScore += 8;
    reasons.push("Wallet appears to have been funded by a bridge.");
  } else if (funding.fundingSourceType === "wallet") {
    whaleScore += 5;
    reasons.push("Wallet appears to have been funded by another wallet.");
  } else {
    reasons.push("Funding source type is unknown.");
  }

  if (risk.level === "low") {
    whaleScore += 5;
    reasons.push("Current risk level is low.");
  } else if (risk.level === "medium") {
    whaleScore += 2;
    reasons.push("Current risk level is medium.");
  } else {
    reasons.push("Current risk level is high, reducing whale confidence.");
  }

  whaleScore = Math.min(100, whaleScore);

  const whaleLevel =
    whaleScore >= 80
      ? "large"
      : whaleScore >= 55
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
