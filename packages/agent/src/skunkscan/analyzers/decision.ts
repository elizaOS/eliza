import {
  WalletDecisionFactor,
  WalletDecisionSummary,
  WalletEvidenceRecord,
  WalletExposureSummary,
  WalletRiskSummary,
  WalletTransactionRiskSummary,
  WalletTrustSummary,
} from "../types";
import { createConfidenceResponse } from "../confidence/framework";

export function analyzeWalletDecision(
  evidenceRecords: WalletEvidenceRecord[],
  risk: WalletRiskSummary,
  trust: WalletTrustSummary,
  exposure: WalletExposureSummary,
  transactionRisk: WalletTransactionRiskSummary,
): WalletDecisionSummary {
  const factors: WalletDecisionFactor[] = [];
  const limitations: string[] = [];

  const findEvidenceId = (
    id: string,
  ): string[] =>
    evidenceRecords.some((record) => record.id === id)
      ? [id]
      : [];

  factors.push({
    id: "risk-factor",
    category: "risk",
    effect:
      risk.level === "high"
        ? "negative"
        : risk.level === "medium"
          ? "negative"
          : "positive",
    weight:
      risk.level === "high"
        ? 40
        : risk.level === "medium"
          ? 20
          : 10,
    description: `Wallet risk level is ${risk.level}.`,
    evidenceRecordIds: findEvidenceId("risk-assessment"),
  });

  factors.push({
    id: "trust-factor",
    category: "trust",
    effect:
      trust.trustLevel === "high" ||
      trust.trustLevel === "very_high"
        ? "positive"
        : trust.trustLevel === "medium"
          ? "neutral"
          : "negative",
    weight:
      trust.trustLevel === "very_high"
        ? 20
        : trust.trustLevel === "high"
          ? 15
          : trust.trustLevel === "medium"
            ? 5
            : 15,
    description: `Wallet trust level is ${trust.trustLevel}.`,
    evidenceRecordIds: [],
  });

  factors.push({
    id: "exposure-factor",
    category: "exposure",
    effect:
      exposure.exposureLevel === "none"
        ? "positive"
        : "negative",
    weight:
      exposure.exposureLevel === "high"
        ? 40
        : exposure.exposureLevel === "medium"
          ? 25
          : exposure.exposureLevel === "low"
            ? 10
            : 10,
    description: `Wallet exposure level is ${exposure.exposureLevel}.`,
    evidenceRecordIds: findEvidenceId("exposure-summary"),
  });

  factors.push({
    id: "transaction-risk-factor",
    category: "transaction_risk",
    effect:
      transactionRisk.level === "low"
        ? "positive"
        : "negative",
    weight:
      transactionRisk.level === "high"
        ? 35
        : transactionRisk.level === "medium"
          ? 20
          : 10,
    description:
      `Wallet-context transaction risk is ${transactionRisk.level}.`,
    evidenceRecordIds: findEvidenceId(
      "transaction-risk-assessment",
    ),
  });

  let negativeWeight = 0;
  let positiveWeight = 0;

  for (const factor of factors) {
    if (factor.effect === "negative") {
      negativeWeight += factor.weight;
    }

    if (factor.effect === "positive") {
      positiveWeight += factor.weight;
    }
  }

  const decision =
    negativeWeight >= 70
      ? "high_risk"
      : negativeWeight >= 40
        ? "investigate"
        : negativeWeight >= 20
          ? "review"
          : "low_risk";

  const recommendation =
    decision === "high_risk"
      ? "high_risk"
      : decision === "investigate"
        ? "investigate"
        : decision === "review"
          ? "review"
          : "allow";

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition: evidenceRecords.length >= 10,
      score: 30,
      reason:
        "A broad set of structured evidence records was available.",
    },
    {
      condition: evidenceRecords.length >= 5,
      score: 20,
      reason:
        "Multiple structured evidence records were available.",
    },
    {
      condition: exposure.evidenceConfidence === "high",
      score: 20,
      reason: "Exposure evidence confidence is high.",
    },
    {
      condition: trust.confidence === "high",
      score: 15,
      reason: "Trust assessment confidence is high.",
    },
    {
      condition: transactionRisk.level !== "high",
      score: 10,
      reason:
        "No high wallet-context transaction risk was identified.",
    },
    {
      condition: positiveWeight > negativeWeight,
      score: 5,
      reason:
        "Positive decision factors outweigh negative factors.",
    },
  ]);

  if (evidenceRecords.length < 5) {
    limitations.push(
      "The decision was produced from a limited number of structured evidence records.",
    );
  }

  if (trust.confidence === "low") {
    limitations.push(
      "Trust assessment confidence is low.",
    );
  }

  const supportingEvidenceRecordIds = Array.from(
    new Set(
      factors.flatMap(
        (factor) => factor.evidenceRecordIds,
      ),
    ),
  );

  return {
    decision,
    recommendation,
    confidence: confidenceAnalysis.level,
    confidenceAnalysis,
    factors,
    supportingEvidenceRecordIds,
    limitations,
  };
}
