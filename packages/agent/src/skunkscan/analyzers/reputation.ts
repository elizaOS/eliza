import {
  WalletAlphaSummary,
  WalletProfitabilitySummary,
  WalletReputationSummary,
  WalletRiskSummary,
  WalletSmartMoneySummary,
  WalletTrustSummary,
} from "../types";

type ReputationInput = {
  trust: WalletTrustSummary;
  risk: WalletRiskSummary;
  smartMoney: WalletSmartMoneySummary;
  alpha: WalletAlphaSummary;
  profitability: WalletProfitabilitySummary;
};

export function analyzeWalletReputation(
  input: ReputationInput
): WalletReputationSummary {
  let score =
    Math.round(
      input.trust.trustScore * 0.35 +
      input.alpha.alphaScore * 0.25 +
      input.smartMoney.smartMoneyScore * 0.20 +
      input.profitability.profitabilityScore * 0.20
    );

  score -= input.risk.score;

  score = Math.max(0, Math.min(100, score));

  let reputationLevel: WalletReputationSummary["reputationLevel"];

  if (score >= 85) reputationLevel = "excellent";
  else if (score >= 70) reputationLevel = "good";
  else if (score >= 55) reputationLevel = "moderate";
  else if (score >= 35) reputationLevel = "limited";
  else reputationLevel = "poor";

  const strengths: string[] = [];
  const concerns: string[] = [];

  if (input.trust.trustScore >= 70)
    strengths.push("Strong trust indicators.");

  // alpha is reputation's second-largest weight (25%, after trust's 35%),
  // but previously had no strength condition at all - a wallet with a
  // strong alpha reading contributed real, positive weight to the score
  // with zero visible explanation. Threshold matches smartMoney/
  // profitability's existing 60 for consistency, rather than introducing
  // a third distinct value.
  if (input.alpha.alphaScore >= 60)
    strengths.push("Strong Alpha Score indicators.");

  if (input.smartMoney.smartMoneyScore >= 60)
    strengths.push("Shows smart-money characteristics.");

  if (input.profitability.profitabilityScore >= 60)
    strengths.push("Positive profitability indicators.");

  if (input.risk.level !== "low")
    concerns.push("Risk indicators reduce reputation.");

  return {
    reputationScore: score,

    displayScore: `${(score / 10).toFixed(1)} / 10`,

    reputationLevel,

    confidence: "medium",

    evidenceConfidence: "medium",

    confidenceAnalysis: {
      rawScore: score,
      maxScore: 100,
      displayScore: `${(score / 10).toFixed(1)} / 10`,
      maxDisplayScore: 10,
      level: "medium",
      reasons: [
        "Trust analysis contributed.",
        "Alpha analysis contributed.",
        "Profitability indicators contributed.",
      ],
    },

    investorHeadline: `Wallet Reputation: ${reputationLevel}`,

    investorSummary:
      "The Reputation Score summarizes the wallet's overall credibility using trust, risk, alpha, profitability and smart-money indicators.",

    investorTakeaway:
      "Higher reputation scores suggest stronger overall blockchain characteristics, but they do not guarantee future performance or safety.",

    strengths,

    concerns,

    limitations: [
      "Reputation is evidence-based and not proof of legitimacy or ownership.",
    ],
  };
}
