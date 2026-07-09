import {
  WalletFundingSummary,
  WalletRelationshipSummary,
} from "../types";
import {
  buildConfidenceInput,
  confidenceLevelFromScore,
} from "../confidence/framework";

export function analyzeWalletRelationships(
  funding: WalletFundingSummary,
): WalletRelationshipSummary {
  const relationships: WalletRelationshipSummary["relationships"] = [];

  if (funding.fundingWallet) {
    relationships.push({
      address: funding.fundingWallet,
      relationship: "funder",
      label: funding.fundingSourceLabel?.label ?? null,
      confidence: funding.confidence,
    });
  }

  const evidenceConfidenceInput = buildConfidenceInput([
    {
      condition: funding.evidenceConfidence === "high",
      score: 35,
      reason: "Funding evidence confidence is high.",
    },
    {
      condition: funding.evidenceConfidence === "medium",
      score: 20,
      reason: "Funding evidence confidence is medium.",
    },
    {
      condition: relationships.length > 0,
      score: 45,
      reason: "At least one direct relationship was identified.",
    },
  ]);

  const confidence =
    relationships.length === 0
      ? "low"
      : confidenceLevelFromScore(evidenceConfidenceInput.score);

  return {
    relationshipCount: relationships.length,
    relationships,
    evidenceConfidence: confidenceLevelFromScore(
      evidenceConfidenceInput.score,
    ),
    confidence,
    notes:
      relationships.length === 0
        ? ["No direct wallet relationships were identified from the current analysis."]
        : ["Relationships are currently inferred from funding intelligence."],
  };
}
