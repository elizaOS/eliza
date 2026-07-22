import {
  WalletActivitySummary,
  WalletBehaviorSummary,
  WalletConvictionSummary,
  WalletPortfolioSummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletWhaleSummary,
} from "../types";

type ConvictionInput = {
  activity: WalletActivitySummary;
  portfolio: WalletPortfolioSummary;
  behavior: WalletBehaviorSummary;
  strategy: WalletStrategySummary;
  whale: WalletWhaleSummary;
  smartMoney: WalletSmartMoneySummary;
};

export function analyzeWalletConviction(
  input: ConvictionInput,
): WalletConvictionSummary {

  let score = 0;

  const supportingSignals: string[] = [];
  const conflictingSignals: string[] = [];
  const limitations: string[] = [];

  if (
    input.strategy.primaryStrategy === "holding"
  ) {
    score += 30;

    supportingSignals.push(
      "Long-term holding behaviour increases conviction.",
    );
  }

  if (
    input.strategy.primaryStrategy === "accumulating"
  ) {
    score += 25;

    supportingSignals.push(
      "Accumulation behaviour indicates growing conviction.",
    );
  }

  if (
    input.portfolio.diversityLevel === "medium"
  ) {
    score += 15;

    supportingSignals.push(
      "Portfolio shows balanced diversification.",
    );
  }

  if (
    input.portfolio.diversityLevel === "high"
  ) {
    score += 20;

    supportingSignals.push(
      "Broad portfolio suggests sustained market participation.",
    );
  }

  if (input.smartMoney.level === "high") {
    score += 15;

    supportingSignals.push(
      "Strong Smart Money characteristics support conviction.",
    );
  }

  if (input.whale.isWhale) {
    score += 10;

    supportingSignals.push(
      "Whale characteristics reinforce conviction.",
    );
  }

  if (
    input.activity.activityLevel === "none"
  ) {
    score -= 20;

    conflictingSignals.push(
      "No recent activity reduces confidence in current conviction.",
    );
  }

  score = Math.max(0, Math.min(score, 100));

  let convictionLevel:
    | "very_low"
    | "low"
    | "medium"
    | "high"
    | "very_high";

  if (score >= 85) {
    convictionLevel = "very_high";
  } else if (score >= 65) {
    convictionLevel = "high";
  } else if (score >= 45) {
    convictionLevel = "medium";
  } else if (score >= 20) {
    convictionLevel = "low";
  } else {
    convictionLevel = "very_low";
  }

  const confidence =
    score >= 70
      ? "high"
      : score >= 40
      ? "medium"
      : "low";

  return {
    convictionLevel,
    convictionScore: score,
    displayScore: (score / 10).toFixed(1),
    confidence,
    evidenceConfidence: confidence,
    confidenceAnalysis: {
      rawScore: score,
      maxScore: 100,
      displayScore: (score / 10).toFixed(1),
      maxDisplayScore: 10,
      level: confidence,
      reasons: [
        ...supportingSignals,
        ...conflictingSignals,
      ],
    },
    investorHeadline: `Conviction ${convictionLevel.replace("_", " ")}`,
    investorSummary:
      "Conviction is inferred from portfolio behaviour, strategy, Smart Money indicators, whale characteristics, and wallet activity.",
    investorTakeaway:
      "Higher conviction suggests the wallet appears more committed to its current investment approach, but does not guarantee future performance.",
    supportingSignals,
    conflictingSignals,
    limitations,
  };
}
