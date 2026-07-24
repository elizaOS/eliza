import {
  WalletAlphaSummary,
  WalletConvictionSummary,
  WalletDeFiSummary,
  WalletInvestmentStyleSummary,
  WalletPortfolioSummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletWhaleSummary,
} from "../types";

type InvestmentStyleInput = {
  strategy: WalletStrategySummary;
  smartMoney: WalletSmartMoneySummary;
  conviction: WalletConvictionSummary;
  alpha: WalletAlphaSummary;
  portfolio: WalletPortfolioSummary;
  whale: WalletWhaleSummary;
  defi: WalletDeFiSummary;
};

export function analyzeInvestmentStyle(
  input: InvestmentStyleInput,
): WalletInvestmentStyleSummary {

  const supportingSignals: string[] = [];
  const conflictingSignals: string[] = [];
  const limitations: string[] = [];

  let style:
    | "long_term_investor"
    | "active_trader"
    | "swing_trader"
    | "momentum_trader"
    | "accumulator"
    | "defi_investor"
    | "yield_farmer"
    | "meme_coin_trader"
    | "whale_investor"
    | "passive_holder"
    | "diversified_investor"
    | "mixed" = "mixed";

  if (input.whale.isWhale) {
    style = "whale_investor";
    supportingSignals.push("Whale characteristics detected.");
  }

  if (input.strategy.primaryStrategy === "holding") {
    style = "long_term_investor";
    supportingSignals.push("Holding strategy detected.");
  }

  if (input.strategy.primaryStrategy === "accumulating") {
    style = "accumulator";
    supportingSignals.push("Accumulation strategy detected.");
  }

  if (input.defi.protocolCount > 0) {
    style = "defi_investor";
    supportingSignals.push("Recognized DeFi participation.");
  }

  if (input.portfolio.diversityLevel === "high") {
    style = "diversified_investor";
    supportingSignals.push("Highly diversified portfolio.");
  }

  let confidence: "low" | "medium" | "high";

  if (input.alpha.alphaScore >= 75) {
    confidence = "high";
  } else if (input.alpha.alphaScore >= 45) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    style,
    confidence,
    evidenceConfidence: confidence,
    confidenceAnalysis: {
      rawScore:
        input.alpha.alphaScore,
      maxScore: 100,
      displayScore:
        `${(input.alpha.alphaScore / 10).toFixed(1)} / 10`,
      maxDisplayScore: 10,
      level: confidence,
      reasons: supportingSignals,
    },
    investorHeadline:
      `Investment Style: ${style.replaceAll("_", " ")}`,
    investorSummary:
      "Investment Style summarizes how this wallet typically participates in the market using blockchain evidence.",
    investorTakeaway:
      "This classification helps investors understand the wallet's overall investment behavior rather than a single transaction.",
    styleDescription:
      style.replaceAll("_", " "),
    supportingSignals,
    conflictingSignals,
    limitations,
  };
}
