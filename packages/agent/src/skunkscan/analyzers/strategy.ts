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

  // -----------------------------
  // Dormant
  // -----------------------------

  if (input.activity.activityLevel === "none") {
    strategy = "dormant";
    score = 15;

    conflictingSignals.push(
      "No recent on-chain activity was detected.",
    );
  }

  // -----------------------------
  // Long-term holder
  // -----------------------------

  else if (
    input.age.classification === "established" &&
    input.activity.activityLevel === "low"
  ) {
    strategy = "holding";
    score += 70;

    supportingSignals.push(
      "Established wallet with limited recent trading activity.",
    );
  }

  // -----------------------------
  // Active trader
  // -----------------------------

  else if (
    input.activity.activityLevel === "high"
  ) {
    strategy = "active_trading";
    score += 70;

    supportingSignals.push(
      "High recent transaction activity suggests active trading.",
    );
  }

  // -----------------------------
  // Accumulating
  // -----------------------------

  else if (
    input.age.classification === "established" &&
    input.portfolio.diversityLevel !== "low"
  ) {
    strategy = "accumulating";
    score += 60;

    supportingSignals.push(
      "Established wallet with diversified holdings.",
    );
  }

  // -----------------------------
  // Supporting evidence
  // -----------------------------

  if (input.smartMoney.level === "high") {
    score += 15;

    supportingSignals.push(
      "Strong Smart Money profile detected.",
    );
  }

  if (input.whale.isWhale) {
    score += 10;

    supportingSignals.push(
      "Whale characteristics strengthen the strategy assessment.",
    );
  }

  if (
    input.defi.profile === "power_user"
  ) {
    score += 10;

    supportingSignals.push(
      "Regular DeFi usage supports strategic participation.",
    );
  }

  if (
    input.behavior.primaryProfile ===
    "long_term_investor"
  ) {
    score += 10;
  }

  if (
    input.behavior.primaryProfile ===
    "active_trader"
  ) {
    score += 10;
  }

  if (score > 100) {
    score = 100;
  }

  const confidence =
    score >= 75
      ? "high"
      : score >= 45
      ? "medium"
      : "low";

  if (strategy === "unknown") {
    limitations.push(
      "Available evidence was insufficient to confidently identify a dominant investment strategy.",
    );
  }

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
      "The strategy classification is inferred from wallet age, activity, portfolio composition, Smart Money indicators, DeFi participation, and behavioral evidence.",
    investorTakeaway:
      "Treat this as an evidence-based view of how the wallet appears to invest, not as a prediction of future performance.",
    supportingSignals,
    conflictingSignals,
    limitations,
  };
}
