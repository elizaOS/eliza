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
sourcesChecked: [
  {
    name: "SkunkScan Internal Registry",
    category: "internal_registry",
    status: "connected",
    coverage: [
      "Known scam wallets",
      "Known rug pulls",
      "Known suspicious wallets",
    ],
    lastUpdatedAt: null,
    notes: [
      "Maintained by SkunkScan.",
    ],
  },
  {
    name: "Sanctions Provider",
    category: "sanctions",
    status: "planned",
    coverage: [
      "OFAC",
      "EU",
      "UK",
      "UN",
    ],
    lastUpdatedAt: null,
    notes: [
      "External provider integration planned.",
    ],
  },
  {
    name: "Adverse Media Provider",
    category: "adverse_media",
    status: "planned",
    coverage: [
      "News",
      "Law enforcement",
      "Regulatory actions",
    ],
    lastUpdatedAt: null,
    notes: [
      "External provider integration planned.",
    ],
  },
],
    
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
