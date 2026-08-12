import {
  WalletActivitySummary,
  WalletCustodyProfile,
  WalletFundingSummary,
  WalletRelationshipSummary,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

export function analyzeWalletCustodyProfile(
  activity: WalletActivitySummary,
  funding: WalletFundingSummary,
  relationships: WalletRelationshipSummary,
): WalletCustodyProfile {
  const reasons: string[] = [];
  const limitations: string[] = [];

  let custodyType: WalletCustodyProfile["custodyType"] =
    "likely_unhosted";

  let temperatureProfile: WalletCustodyProfile["temperatureProfile"] =
    "likely_hot";

  let confidence: WalletCustodyProfile["confidence"] =
    "medium";

  // Two distinct signals, both real: was this wallet's ORIGINAL funding
  // traced to a known exchange (funding.fundingSourceType), or does it
  // have an ONGOING relationship (not just its first funder) with one
  // (relationship.isKnownExchange, from analyzers/relationships.ts's
  // infrastructure detection - deliberately narrower than
  // isKnownInfrastructure, since DEX/bridge/staking interaction says
  // nothing about hosted-vs-unhosted custody the way exchange interaction
  // does). Previously this second check compared
  // relationship.relationship === "exchange", a value
  // analyzeWalletRelationships never actually assigns - always false,
  // silently doing nothing. Found and left as a flagged TODO during the
  // relationship-infrastructure-exclusion work; fixed here by wiring to
  // the real field that work introduced, rather than deleted as dead code.
  if (
    funding.fundingSourceType === "exchange" ||
    relationships.relationships.some(
      (relationship) => relationship.isKnownExchange,
    )
  ) {
    custodyType = "likely_hosted";

    reasons.push(
      "Exchange-related funding or relationship detected.",
    );
  } else {
    reasons.push(
      "No exchange custody indicators detected.",
    );
  }

  if (
    activity.activityLevel === "none" ||
    activity.activityLevel === "low"
  ) {
    temperatureProfile = "likely_cold";

    reasons.push(
      "Very limited recent activity detected.",
    );
  } else if (activity.activityLevel === "medium") {
    temperatureProfile = "likely_warm";

    reasons.push(
      "Moderate recent activity detected.",
    );
  } else {
    temperatureProfile = "likely_hot";

    reasons.push(
      "Frequent recent activity detected.",
    );
  }

  if (funding.fundingSourceType === "unknown") {
    confidence = "low";

    limitations.push(
      "Funding source could not be confidently identified.",
    );
  }

  if (relationships.relationshipCount === 0) {
    limitations.push(
      "No direct wallet relationships were identified to support the custody classification.",
    );
  }

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition:
        typeof activity.recentTransactionCount === "number",
      score: 30,
      reason:
        "Wallet activity metrics were available.",
    },
    {
      condition:
        funding.evidenceConfidence === "high",
      score: 30,
      reason:
        "Funding evidence confidence is high.",
    },
    {
      condition:
        funding.evidenceConfidence === "medium",
      score: 20,
      reason:
        "Funding evidence confidence is medium.",
    },
    {
      condition:
        relationships.evidenceConfidence === "high",
      score: 25,
      reason:
        "Relationship evidence confidence is high.",
    },
    {
      condition:
        relationships.evidenceConfidence === "medium",
      score: 15,
      reason:
        "Relationship evidence confidence is medium.",
    },
    {
      condition:
        relationships.relationshipCount > 0,
      score: 15,
      reason:
        "At least one direct wallet relationship was identified.",
    },
  ]);

  if (confidenceAnalysis.level === "low") {
    confidence = "low";
  } else if (
    funding.fundingSourceType !== "unknown" &&
    confidenceAnalysis.level === "high"
  ) {
    confidence = "high";
  } else if (confidence !== "low") {
    confidence = "medium";
  }

  return {
    custodyType,

    temperatureProfile,

    evidenceConfidence:
      confidenceAnalysis.level,

    confidenceAnalysis,

    confidence,

    reasons,

    limitations,
  };
}
