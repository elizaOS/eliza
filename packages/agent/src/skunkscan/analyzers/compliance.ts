import {
  WalletComplianceScreeningSummary,
  WalletExposureSummary,
} from "../types";

export function analyzeWalletCompliance(
  exposure: WalletExposureSummary,
): WalletComplianceScreeningSummary {
  const matches: WalletComplianceScreeningSummary["matches"] = [];

  for (const match of exposure.matches) {
    if (
      match.category === "sanctioned" ||
      match.category === "adverse_media"
    ) {
      matches.push({
        type:
          match.category === "sanctioned"
            ? "sanctions"
            : "adverse_media",
        source: match.source,
        label: match.label,
        confidence: match.confidence,
        notes: [
          `Relationship: ${match.relationship}`,
        ],
      });
    }
  }

  return {
    sanctionsStatus:
      matches.some((m) => m.type === "sanctions")
        ? "possible_match"
        : "no_match_in_connected_sources",

    adverseMediaStatus:
      matches.some((m) => m.type === "adverse_media")
        ? "possible_match"
        : "no_match_in_connected_sources",

    screeningConfidence:
      matches.length > 0 ? "medium" : "high",

    matches,

    limitations: [
      "Current screening is limited to connected screening sources.",
      "Additional sanctions and adverse media providers can be integrated in future releases.",
    ],
  };
}
