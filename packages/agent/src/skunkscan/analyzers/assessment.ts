import {
  WalletAssessmentFactor,
  WalletAssessmentSummary,
  WalletEvidenceRecord,
  WalletExposureSummary,
  WalletRiskSummary,
  WalletTransactionRiskSummary,
  WalletTrustSummary,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

export function analyzeWalletAssessment(
  risk: WalletRiskSummary,
  trust: WalletTrustSummary,
  exposure: WalletExposureSummary,
  transactionRisk: WalletTransactionRiskSummary,
  evidenceRecords: WalletEvidenceRecord[],
): WalletAssessmentSummary {
  const factors: WalletAssessmentFactor[] = [];

  factors.push({
    id: "risk-factor",
    category: "risk",
    effect:
      risk.level === "high"
        ? "negative"
        : risk.level === "medium"
          ? "neutral"
          : "positive",
    weight:
      risk.level === "high"
        ? 30
        : risk.level === "medium"
          ? 15
          : 10,
    description:
      `Wallet risk level is ${risk.level}.`,
    evidenceRecordIds: ["risk-assessment"],
  });

  factors.push({
    id: "trust-factor",
    category: "trust",
    effect:
      trust.trustLevel === "very_low" ||
      trust.trustLevel === "low"
        ? "negative"
        : trust.trustLevel === "medium"
          ? "neutral"
          : "positive",
    weight:
      trust.trustLevel === "very_low" ||
      trust.trustLevel === "low"
        ? 20
        : trust.trustLevel === "medium"
          ? 5
          : 10,
    description:
      `Wallet trust level is ${trust.trustLevel}.`,
    evidenceRecordIds: [],
  });

  factors.push({
    id: "exposure-factor",
    category: "exposure",
    effect:
      exposure.exposureLevel === "high"
        ? "negative"
        : exposure.exposureLevel === "medium"
          ? "neutral"
          : "positive",
    weight:
      exposure.exposureLevel === "high"
        ? 30
        : exposure.exposureLevel === "medium"
          ? 15
          : 10,
    description:
      `Wallet exposure level is ${exposure.exposureLevel}.`,
    evidenceRecordIds: ["exposure-summary"],
  });

  factors.push({
    id: "transaction-risk-factor",
    category: "transaction_risk",
    effect:
      transactionRisk.level === "high"
        ? "negative"
        : transactionRisk.level === "medium"
          ? "neutral"
          : "positive",
    weight:
      transactionRisk.level === "high"
        ? 30
        : transactionRisk.level === "medium"
          ? 15
          : 10,
    description:
      `Wallet-context transaction risk is ${transactionRisk.level}.`,
    evidenceRecordIds: ["transaction-risk-assessment"],
  });

  const negativeWeight = factors
    .filter((factor) => factor.effect === "negative")
    .reduce((total, factor) => total + factor.weight, 0);

  const neutralWeight = factors
    .filter((factor) => factor.effect === "neutral")
    .reduce((total, factor) => total + factor.weight, 0);

  const assessment =
    negativeWeight >= 60
      ? "high_risk"
      : negativeWeight >= 30
        ? "investigate"
        : neutralWeight >= 30
          ? "review"
          : "low_risk";

  const supportingEvidenceRecordIds = Array.from(
    new Set(
      factors.flatMap(
        (factor) => factor.evidenceRecordIds,
      ),
    ),
  ).filter((id) =>
    evidenceRecords.some(
      (record) => record.id === id,
    ),
  );

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition: evidenceRecords.length >= 10,
      score: 25,
      reason:
        "A broad set of structured evidence records was available.",
    },
    {
      condition: evidenceRecords.length >= 5,
      score: 15,
      reason:
        "Multiple structured evidence records were available.",
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
        exposure.evidenceConfidence === "high",
      score: 20,
      reason:
        "Exposure evidence confidence is high.",
    },
    {
      condition:
        transactionRisk.evidenceConfidence === "high",
      score: 20,
      reason:
        "Transaction-risk evidence confidence is high.",
    },
  ]);

  const limitations: string[] = [];

  if (supportingEvidenceRecordIds.length < 3) {
    limitations.push(
      "The assessment is supported by a limited number of directly linked evidence records.",
    );
  }

  return {
    assessment,

    confidence:
      confidenceAnalysis.level,

    confidenceAnalysis,

    factors,

    supportingEvidenceRecordIds,

    limitations,

    userDecisionNotice:
      "SkunkScanAI provides evidence-based analysis only. The final decision remains with the user.",
  };
}
