import {
  WalletComplianceScreeningSummary,
  WalletExposureSummary,
} from "../types";
import {
  buildConfidenceInput,
  confidenceLevelFromScore,
} from "../confidence/framework";

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
        notes: [`Relationship: ${match.relationship}`],
      });
    }
  }

  const sourcesChecked: WalletComplianceScreeningSummary["sourcesChecked"] = [
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
      notes: ["Maintained by SkunkScan."],
    },
    {
      name: "Sanctions Provider",
      category: "sanctions",
      status: "planned",
      coverage: ["OFAC", "EU", "UK", "UN"],
      lastUpdatedAt: null,
      notes: ["External provider integration planned."],
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
      notes: ["External provider integration planned."],
    },
  ];

  const evidenceConfidenceInput = buildConfidenceInput([
    {
      condition: exposure.evidenceConfidence === "high",
      score: 35,
      reason: "Exposure evidence confidence is high.",
    },
    {
      condition: exposure.evidenceConfidence === "medium",
      score: 25,
      reason: "Exposure evidence confidence is medium.",
    },
    {
      condition: sourcesChecked.some(
        (source) => source.status === "connected",
      ),
      score: 30,
      reason: "At least one screening source is connected.",
    },
    {
      condition: sourcesChecked.length > 0,
      score: 20,
      reason: "Screening source metadata is available.",
    },
    {
      condition: matches.length > 0,
      score: 15,
      reason: "Compliance-related match was identified.",
    },
  ]);

  return {
    sourcesChecked,

    sanctionsStatus:
      matches.some((m) => m.type === "sanctions")
        ? "possible_match"
        : "no_match_in_connected_sources",

    adverseMediaStatus:
      matches.some((m) => m.type === "adverse_media")
        ? "possible_match"
        : "no_match_in_connected_sources",

    evidenceConfidence: confidenceLevelFromScore(
      evidenceConfidenceInput.score,
    ),

    screeningConfidence:
      matches.length > 0
        ? confidenceLevelFromScore(evidenceConfidenceInput.score)
        : "medium",

    matches,

    limitations: [
      "Current screening is limited to connected screening sources.",
      "Additional sanctions and adverse media providers can be integrated in future releases.",
    ],
  };
}
