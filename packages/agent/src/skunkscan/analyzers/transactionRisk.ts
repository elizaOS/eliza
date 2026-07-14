import {
  WalletCaseSummary,
  WalletComplianceScreeningSummary,
  WalletExposureSummary,
  WalletRiskSummary,
  WalletTransactionRiskSummary,
  WalletTrustSummary,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

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

  if (
    trust.trustLevel === "very_low" ||
    trust.trustLevel === "low"
  ) {
    score += 15;
    reasons.push("Wallet trust level is low.");
  }

  if (exposure.exposureLevel !== "none") {
    score += exposure.exposureScore;
    reasons.push(
      `Wallet exposure level is ${exposure.exposureLevel}.`,
    );
  }

  if (
    complianceScreening.sanctionsStatus ===
      "possible_match" ||
    complianceScreening.sanctionsStatus ===
      "confirmed_match"
  ) {
    score += 40;
    reasons.push(
      "Sanctions screening produced a potential or confirmed match.",
    );
  }

  if (
    complianceScreening.adverseMediaStatus ===
      "possible_match" ||
    complianceScreening.adverseMediaStatus ===
      "confirmed_match"
  ) {
    score += 20;
    reasons.push(
      "Adverse media screening produced a potential or confirmed match.",
    );
  }

  if (trust.confidence === "low") {
    limitations.push(
      "Trust confidence is low due to limited available evidence.",
    );
  }

  limitations.push(
    "This is a wallet-context transaction risk assessment, not a full transaction-specific screening.",
  );

  score = Math.max(0, Math.min(100, score));

  const level =
    score >= 70
      ? "high"
      : score >= 35
        ? "medium"
        : "low";

  const recommendation =
    level === "high"
      ? "high_risk"
      : level === "medium"
        ? "investigate"
        : caseSummary.recommendation;

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition: Boolean(risk.level),
      score: 20,
      reason:
        "A wallet risk assessment was available.",
    },
    {
      condition:
        trust.evidenceConfidence === "high",
      score: 20,
      reason:
        "Trust evidence confidence is high.",
    },
    {
      condition:
        trust.evidenceConfidence === "medium",
      score: 10,
      reason:
        "Trust evidence confidence is medium.",
    },
    {
      condition:
        exposure.evidenceConfidence === "high",
      score: 20,
      reason:
        "Exposure evidence confidence is high.",
    },
    {
      condition:
        exposure.evidenceConfidence === "medium",
      score: 10,
      reason:
        "Exposure evidence confidence is medium.",
    },
    {
      condition:
        complianceScreening.evidenceConfidence ===
        "high",
      score: 20,
      reason:
        "Compliance screening evidence confidence is high.",
    },
    {
      condition:
        complianceScreening.evidenceConfidence ===
        "medium",
      score: 10,
      reason:
        "Compliance screening evidence confidence is medium.",
    },
    {
      condition:
        Boolean(caseSummary.recommendation),
      score: 10,
      reason:
        "A case-level recommendation was available.",
    },
    {
      condition:
        complianceScreening.sourcesChecked.some(
          (source) => source.status === "connected",
        ),
      score: 10,
      reason:
        "At least one compliance screening source was connected.",
    },
  ]);

  const confidence =
    confidenceAnalysis.level === "high" &&
    trust.confidence !== "low"
      ? "high"
      : confidenceAnalysis.level === "low" ||
          trust.confidence === "low"
        ? "low"
        : "medium";

  return {
    assessmentType: "wallet_context",
    rawScore: score,
    maxScore: 100,
    level,
    displayScore:
      `${(score / 10).toFixed(1)} / 10`,
    maxDisplayScore: 10,
    evidenceConfidence:
      confidenceAnalysis.level,
    confidenceAnalysis,
    confidence,
    recommendation,
    reasons,
    limitations,
  };
}
