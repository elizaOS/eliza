import {
  WalletFundingSummary,
  WalletRelationshipSummary,
} from "../types";

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

  return {
    relationshipCount: relationships.length,
    relationships,
    notes:
      relationships.length === 0
        ? ["No direct wallet relationships were identified from the current analysis."]
        : ["Relationships are currently inferred from funding intelligence."],
  };
}
