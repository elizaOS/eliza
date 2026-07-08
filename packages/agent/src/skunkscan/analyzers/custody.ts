import {
  WalletActivitySummary,
  WalletCustodyProfile,
  WalletFundingSummary,
  WalletRelationshipSummary,
} from "../types";

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

  // Hosted wallet indicators
  if (
    funding.fundingSourceType === "exchange" ||
    relationships.relationships.some(
      (r) => r.relationship === "exchange",
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

  // Temperature indicators
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

  if (
    funding.fundingSourceType === "unknown"
  ) {
    confidence = "low";
    limitations.push(
      "Funding source could not be confidently identified.",
    );
  }

  return {
    custodyType,
    temperatureProfile,
    confidence,
    reasons,
    limitations,
  };
}
