import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletBehaviorSummary,
  WalletDeFiSummary,
  WalletPortfolioSummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletWhaleSummary,
} from "../types";

type StrategyInput = {
  activity: WalletActivitySummary;
  age: WalletAgeSummary;
  portfolio: WalletPortfolioSummary;
  behavior: WalletBehaviorSummary;
  defi: WalletDeFiSummary;
  whale: WalletWhaleSummary;
  smartMoney: WalletSmartMoneySummary;
};

export function analyzeWalletStrategy(
  input: StrategyInput,
): WalletStrategySummary {
  let score = 0;

  const supportingSignals: string[] = [];
  const conflictingSignals: string[] = [];
  const limitations: string[] = [];

  let strategy: WalletStrategySummary["primaryStrategy"] =
    "unknown";

  if (input.smartMoney.level === "high") {
    score += 25;
    supportingSignals.push(
      "Wallet exhibits strong smart money characteristics.",
    );
  }

  if (input.whale.isWhale) {
    score += 15;
    supportingSignals.push(
      "Large portfolio indicates strategic positioning.",
    );
  }

  if (
    input.behavior.primaryProfile ===
    "long_term_investor"
  ) {
    score += 25;
    strategy = "holding";
  }

  if (
    input.behavior.primaryProfile ===
    "active_trader"
  ) {
    score += 25;
    strategy = "active_trading";
  }

  if (
    input.defi.profile === "power_user"
  ) {
    score += 10;
    supportingSignals.push(
      "Uses multiple DeFi protocols.",
    );
  }

  if (
    input.activity.activityLevel === "none"
  ) {
    strategy = "dormant";
    conflictingSignals.push(
      "Little recent on-chain activity.",
    );
  }

  if (
    strategy === "unknown" &&
    input.portfolio.diversityLevel === "high"
  ) {
    strategy = "accumulating";
  }

  if (score > 100) {
    score = 100;
  }

  const confidence =
    score >= 70
      ? "high"
      : score >= 40
      ? "medium"
      : "low";

  return {
    primaryStrategy: strategy,
    strategyScore: score,
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
    investorHeadline: strategy
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    investorSummary:
      "Current strategy is inferred from observable on-chain behaviour.",
    investorTakeaway:
      "Use this together with Smart Money and Conviction when evaluating whether to follow this wallet.",
    supportingSignals,
    conflictingSignals,
    limitations,
  };
}
