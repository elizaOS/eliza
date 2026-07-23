import {
  WalletAlphaSummary,
  WalletConvictionSummary,
  WalletDeFiSummary,
  WalletPortfolioSummary,
  WalletProtocolIntelligenceSummary,
  WalletRiskSummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletTrustSummary,
  WalletWhaleSummary,
} from "../types";

type AlphaInput = {
  risk: WalletRiskSummary;
  trust: WalletTrustSummary;
  portfolio: WalletPortfolioSummary;
  whale: WalletWhaleSummary;
  smartMoney: WalletSmartMoneySummary;
  strategy: WalletStrategySummary;
  conviction: WalletConvictionSummary;
  defi: WalletDeFiSummary;
  protocolIntelligence: WalletProtocolIntelligenceSummary;
};

export function analyzeWalletAlpha(
  input: AlphaInput,
): WalletAlphaSummary {

  let score = 0;

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const limitations: string[] = [];

  score += input.smartMoney.smartMoneyScore * 0.25;
  score += input.conviction.convictionScore * 0.20;
  score += input.trust.trustScore * 0.20;
  score += input.whale.whaleScore * 0.15;
  score += input.portfolio.diversityScore * 0.10;

  if (input.strategy.primaryStrategy === "accumulating") {
    score += 5;
    strengths.push("Accumulation strategy detected.");
  }

  if (input.strategy.primaryStrategy === "holding") {
    score += 8;
    strengths.push("Long-term holding strategy detected.");
  }

  if (input.risk.level === "low") {
    score += 8;
    strengths.push("Low wallet risk.");
  }

  if (input.defi.protocolCount > 0) {
    score += 4;
    strengths.push("Recognized DeFi participation.");
  }

  if (input.protocolIntelligence.activeProtocols > 0) {
    score += 4;
    strengths.push("Recognized protocol usage.");
  }

  if (input.risk.level === "high") {
    score -= 20;
    weaknesses.push("High calculated wallet risk.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let alphaLevel:
    | "very_low"
    | "low"
    | "medium"
    | "high"
    | "elite";

  if (score >= 90) {
    alphaLevel = "elite";
  } else if (score >= 75) {
    alphaLevel = "high";
  } else if (score >= 55) {
    alphaLevel = "medium";
  } else if (score >= 30) {
    alphaLevel = "low";
  } else {
    alphaLevel = "very_low";
  }

  const confidence =
    score >= 70
      ? "high"
      : score >= 40
      ? "medium"
      : "low";

  return {
    alphaScore: score,
    displayScore: (score / 10).toFixed(1),
    alphaLevel,
    confidence,
    evidenceConfidence: confidence,
    confidenceAnalysis: {
      rawScore: score,
      maxScore: 100,
      displayScore: (score / 10).toFixed(1),
      maxDisplayScore: 10,
      level: confidence,
      reasons: [
        ...strengths,
        ...weaknesses,
      ],
    },
    investorHeadline: `Alpha ${alphaLevel}`,
    investorSummary:
      "Alpha Score combines Smart Money, Conviction, Trust, Whale characteristics, Portfolio quality, Strategy, Risk, and protocol participation into a single investor-oriented score.",
    investorTakeaway:
      "Higher Alpha Scores indicate wallets that exhibit stronger overall investment characteristics based on the available blockchain evidence.",
    strengths,
    weaknesses,
    limitations,
  };
}
