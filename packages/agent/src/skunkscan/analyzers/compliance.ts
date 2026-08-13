import {
  WalletComplianceScreeningSummary,
  WalletExposureSummary,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

export function analyzeWalletCompliance(
  exposure: WalletExposureSummary,
): WalletComplianceScreeningSummary {
  const matches: WalletComplianceScreeningSummary["matches"] = [];

  // Was previously filtered to sanctioned/adverse_media only, silently
  // dropping scam/rug_pull/suspicious hits even though the
  // "SkunkScan Internal Registry" source below already claimed connected
  // coverage for exactly those 3 categories - a real compliance-
  // completeness gap, not a display duplication (see the investigation
  // behind this fix). Now forwards all 5 categories exposure.matches can
  // produce, mapping category directly to type with no new detection
  // logic - the underlying registry hit is the same data, just no longer
  // discarded here.
  const complianceMatchType: Record<
    (typeof exposure.matches)[number]["category"],
    WalletComplianceScreeningSummary["matches"][number]["type"]
  > = {
    sanctioned: "sanctions",
    adverse_media: "adverse_media",
    scam: "scam",
    rug_pull: "rug_pull",
    suspicious: "suspicious",
  };

  for (const match of exposure.matches) {
    matches.push({
      type: complianceMatchType[match.category],
      source: match.source,
      label: match.label,
      confidence: match.confidence,
      notes: [`Relationship: ${match.relationship}`],
    });
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

  const confidenceAnalysis = createConfidenceResponse([
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
      matches.some((match) => match.type === "sanctions")
        ? "possible_match"
        : "no_match_in_connected_sources",

    adverseMediaStatus:
      matches.some((match) => match.type === "adverse_media")
        ? "possible_match"
        : "no_match_in_connected_sources",

    // Sourced directly from exposure's own booleans, not re-derived via
    // matches.some(...) like sanctions/adverse_media above - exposure.ts
    // already computes these at no extra cost, and reusing them keeps this
    // file from re-implementing logic exposure.ts owns.
    scamStatus: exposure.hasKnownScamExposure
      ? "possible_match"
      : "no_match_in_connected_sources",

    rugPullStatus: exposure.hasKnownRugPullExposure
      ? "possible_match"
      : "no_match_in_connected_sources",

    suspiciousStatus: exposure.hasKnownSuspiciousExposure
      ? "possible_match"
      : "no_match_in_connected_sources",

    evidenceConfidence: confidenceAnalysis.level,

    confidenceAnalysis,

    screeningConfidence:
      matches.length > 0
        ? confidenceAnalysis.level
        : "medium",

    matches,

    limitations: [
      "Current screening is limited to connected screening sources.",
      "Additional sanctions and adverse media providers can be integrated in future releases.",
    ],
  };
}
