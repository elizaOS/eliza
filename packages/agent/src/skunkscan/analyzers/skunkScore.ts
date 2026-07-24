import {
  WalletExposureSummary,
  WalletProfitabilitySummary,
  WalletReputationSummary,
  WalletRiskSummary,
  WalletSkunkScoreSummary,
  WalletSmartMoneySummary,
  WalletTrustSummary,
} from "../types";

type SkunkScoreInput = {
  reputation: WalletReputationSummary;
  trust: WalletTrustSummary;
  risk: WalletRiskSummary;
  smartMoney: WalletSmartMoneySummary;
  profitability: WalletProfitabilitySummary;
  exposure: WalletExposureSummary;
};

export function analyzeSkunkScore(
  input: SkunkScoreInput,
): WalletSkunkScoreSummary {
  let score = Math.round(
    input.reputation.reputationScore * 0.35 +
      input.trust.trustScore * 0.20 +
      (100 - input.risk.score) * 0.20 +
      input.smartMoney.smartMoneyScore * 0.10 +
      input.profitability.profitabilityScore * 0.10 +
      (100 - input.exposure.exposureScore) * 0.05,
  );

  score = Math.max(0, Math.min(100, score));

  let rating: WalletSkunkScoreSummary["rating"];
  let stars: 1 | 2 | 3 | 4 | 5;
  let recommendation: string;

  if (score >= 85) {
    rating = "excellent";
    stars = 5;
    recommendation = "Highly Recommended";
  } else if (score >= 70) {
    rating = "very_good";
    stars = 4;
    recommendation = "Recommended";
  } else if (score >= 55) {
    rating = "good";
    stars = 3;
    recommendation = "Worth Reviewing";
  } else if (score >= 35) {
    rating = "fair";
    stars = 2;
    recommendation = "Proceed With Caution";
  } else {
    rating = "poor";
    stars = 1;
    recommendation = "High Caution";
  }

  return {
    score,
    displayScore: `${(score / 10).toFixed(1)} / 10`,
    rating,
    stars,
    recommendation,
    summary: `Overall wallet assessment: ${recommendation}.`,
  };
}
