import {
  WalletAlphaSummary,
  WalletConvictionSummary,
  WalletPortfolioSummary,
  WalletProfitabilitySummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletTrustSummary,
} from "../types";

type ProfitabilityInput = {
  alpha: WalletAlphaSummary;
  conviction: WalletConvictionSummary;
  strategy: WalletStrategySummary;
  trust: WalletTrustSummary;
  smartMoney: WalletSmartMoneySummary;
  portfolio: WalletPortfolioSummary;
};

export function analyzeWalletProfitability(
  input: ProfitabilityInput,
): WalletProfitabilitySummary {

  let profitabilityScore = 0;

  const positiveIndicators: string[] = [];
  const negativeIndicators: string[] = [];
  const limitations: string[] = [];

  profitabilityScore += Math.round(input.alpha.alphaScore * 0.35);
  profitabilityScore += Math.round(input.smartMoney.smartMoneyScore * 0.25);
  profitabilityScore += Math.round(input.trust.trustScore * 0.20);
  profitabilityScore += Math.round(input.conviction.convictionScore * 0.20);

  profitabilityScore = Math.min(100, profitabilityScore);

  if (input.strategy.primaryStrategy === "holding") {
    profitabilityScore += 5;
    positiveIndicators.push("Long-term holding behavior detected.");
  }

  if (input.strategy.primaryStrategy === "accumulating") {
    profitabilityScore += 5;
    positiveIndicators.push("Accumulation behavior detected.");
  }

  if (input.portfolio.diversityLevel === "high") {
    profitabilityScore += 5;
    positiveIndicators.push("High portfolio diversification.");
  }

  profitabilityScore = Math.min(100, profitabilityScore);

  let profitabilityLevel:
    | "unknown"
    | "weak"
    | "limited"
    | "moderate"
    | "strong"
    | "very_strong";

  if (profitabilityScore >= 90) {
    profitabilityLevel = "very_strong";
  } else if (profitabilityScore >= 75) {
    profitabilityLevel = "strong";
  } else if (profitabilityScore >= 55) {
    profitabilityLevel = "moderate";
  } else if (profitabilityScore >= 35) {
    profitabilityLevel = "limited";
  } else if (profitabilityScore > 0) {
    profitabilityLevel = "weak";
  } else {
    profitabilityLevel = "unknown";
  }

  let estimatedProfitability:
    | "unknown"
    | "unlikely"
    | "possible"
    | "likely";

  if (profitabilityScore >= 75) {
    estimatedProfitability = "likely";
  } else if (profitabilityScore >= 45) {
    estimatedProfitability = "possible";
  } else if (profitabilityScore > 0) {
    estimatedProfitability = "unlikely";
  } else {
    estimatedProfitability = "unknown";
  }

  const confidence =
    profitabilityScore >= 70
      ? "high"
      : profitabilityScore >= 40
      ? "medium"
      : "low";

  limitations.push(
    "This assessment estimates profitability characteristics using observable blockchain evidence and should not be interpreted as realized profit or investment returns.",
  );

  return {
    profitabilityScore,
    displayScore: `${(profitabilityScore / 10).toFixed(1)} / 10`,
    profitabilityLevel,
    estimatedProfitability,
    confidence,
    evidenceConfidence: confidence,
    confidenceAnalysis: {
      rawScore: profitabilityScore,
      maxScore: 100,
      displayScore: `${(profitabilityScore / 10).toFixed(1)} / 10`,
      maxDisplayScore: 10,
      level: confidence,
      reasons: positiveIndicators,
    },
    investorHeadline: "Profitability Indicators",
    investorSummary:
      "This score estimates whether the wallet demonstrates characteristics commonly associated with profitable long-term investors.",
    investorTakeaway:
      "The score is evidence-based and does not represent realized profit or financial advice.",
    positiveIndicators,
    negativeIndicators,
    limitations,
  };
}
