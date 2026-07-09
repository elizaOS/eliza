import {
  WalletCaseSummary,
  WalletComplianceScreeningSummary,
  WalletExposureSummary,
  WalletRiskSummary,
  WalletTransactionRiskSummary,
  WalletTrustSummary,
} from "../types";

export function analyzeWalletTransactionRisk(
  risk: WalletRiskSummary,
  trust: WalletTrustSummary,
  exposure: WalletExposureSummary,
  complianceScreening: WalletComplianceScreeningSummary,
  caseSummary: WalletCaseSummary,
): WalletTransactionRiskSummary {
  const reasons: string[] = [];
  const limitations: string[] = [];

  let score = risk.score;

  reasons.push(`Wallet risk level is ${risk.level}.`);

  if (trust.trustLevel === "very_low" || trust.trustLevel === "low") {
    score += 15;
    reasons.push("Wallet trust level is low.");
  }

  if (exposure.exposureLevel !== "none") {
    score += exposure.exposureScore;
    reasons.push(`Wallet exposure level is ${exposure.exposureLevel}.`);
  }

  if (
    complianceScreening.sanctionsStatus === "possible_match" ||
    complianceScreening.sanctionsStatus === "confirmed_match"
  ) {
    score += 40;
    reasons.push("Sanctions screening produced a potential or confirmed match.");
  }

  if (
    complianceScreening.adverseMediaStatus === "possible_match" ||
    complianceScreening.adverseMediaStatus === "confirmed_match"
  ) {
    score += 20;
    reasons.push("Adverse media screening produced a potential or confirmed match.");
  }

  if (trust.confidence === "low") {
    limitations.push("Trust confidence is low due to limited available evidence.");
  }

  limitations.push(
    "This is a wallet-context transaction risk assessment, not a full transaction-specific screening.",
  );

  score = Math.max(0, Math.min(100, score));

  const level =
    score >= 70 ? "high" : score >= 35 ? "medium" : "low";

  const recommendation =
    level === "high"
      ? "high_risk"
      : level === "medium"
        ? "investigate"
        : caseSummary.recommendation;

  return {
    assessmentType: "wallet_context",
    rawScore: score,
    maxScore: 100,
    level,
    displayScore: `${(score / 10).toFixed(1)} / 10`,
    maxDisplayScore: 10,
    recommendation,
    reasons,
    limitations,
  };
}
