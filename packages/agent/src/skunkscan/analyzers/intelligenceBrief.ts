import {
  WalletAssessmentSummary,
  WalletEvidenceRecord,
  WalletIntelligenceBrief,
} from "../types";

export function analyzeWalletIntelligenceBrief(
  assessment: WalletAssessmentSummary,
  evidenceRecords: WalletEvidenceRecord[],
): WalletIntelligenceBrief {
  const overallAssessment =
    mapOverallAssessment(assessment.assessment);

  const supportingEvidenceRecords =
    evidenceRecords.filter((record) =>
      assessment.supportingEvidenceRecordIds.includes(
        record.id,
      ),
    );

  const keyFindings = assessment.factors.map(
    (factor) => factor.description,
  );

  const informationGaps =
    buildInformationGaps(evidenceRecords);

  const sourcesUsed = Array.from(
    new Set(
      evidenceRecords
        .map((record) => record.sourceName)
        .filter(
          (sourceName) =>
            sourceName.trim().length > 0,
        ),
    ),
  );

  const evidenceStrength =
    determineEvidenceStrength(
      evidenceRecords.length,
      supportingEvidenceRecords.length,
      informationGaps.length,
    );

  return {
    generatedAt: new Date().toISOString(),

    briefVersion: "1.0",

    overallAssessment,

    headline:
      buildHeadline(overallAssessment),

    confidence:
      assessment.confidence,

    confidenceAnalysis:
      assessment.confidenceAnalysis,

    evidenceStrength,

    keyFindings,

    informationGaps,

    supportingEvidenceRecordIds:
      assessment.supportingEvidenceRecordIds,

    sourcesUsed,

    notice:
      "SkunkScanAI provides evidence-based blockchain intelligence for informational purposes only. The final decision remains with the user.",
  };
}

function buildInformationGaps(
  evidenceRecords: WalletEvidenceRecord[],
): string[] {
  const gaps: string[] = [];

  for (const record of evidenceRecords) {
    for (const limitation of record.limitations) {
      const normalized =
        limitation.toLowerCase();

      if (
        normalized.includes(
          "funding source could not be confidently identified",
        ) ||
        normalized.includes(
          "no incoming sol funding transfer was detected",
        ) ||
        normalized.includes(
          "funding source type is unknown",
        )
      ) {
        gaps.push(
          "The initial funding source could not be confidently identified.",
        );

        continue;
      }

      if (
        normalized.includes(
          "no token usd prices were available",
        ) ||
        normalized.includes(
          "usd portfolio value is unavailable",
        ) ||
        normalized.includes(
          "total usd portfolio value could not be determined",
        )
      ) {
        gaps.push(
          "Complete USD portfolio valuation was unavailable.",
        );

        continue;
      }

      if (
        normalized.includes(
          "no direct wallet relationships were identified",
        )
      ) {
        gaps.push(
          "No directly attributable wallet relationships were identified.",
        );

        continue;
      }

      if (
        normalized.includes(
          "screening is limited to connected screening sources",
        ) ||
        normalized.includes(
          "additional sanctions and adverse media providers",
        )
      ) {
        gaps.push(
          "Compliance screening coverage is limited to currently connected sources.",
        );

        continue;
      }

      if (
        normalized.includes(
          "not a full transaction-specific screening",
        )
      ) {
        gaps.push(
          "Transaction-risk analysis is wallet-context based and not transaction-specific.",
        );

        continue;
      }

      if (
        normalized.includes(
          "analyzed transaction sample",
        )
      ) {
        gaps.push(
          "Activity and behavior conclusions are based on the analyzed transaction sample.",
        );

        continue;
      }

      if (
        normalized.includes(
          "no known defi protocol interactions",
        )
      ) {
        gaps.push(
          "No recognized DeFi interactions were identified in the analyzed sample.",
        );
      }
    }
  }

  return Array.from(
    new Set(gaps),
  ).slice(0, 6);
}

function mapOverallAssessment(
  assessment: WalletAssessmentSummary["assessment"],
): WalletIntelligenceBrief["overallAssessment"] {
  switch (assessment) {
    case "high_risk":
      return "high_risk_indicators";

    case "investigate":
      return "elevated_risk_indicators";

    case "review":
      return "mixed_risk_indicators";

    case "low_risk":
    default:
      return "low_risk_indicators";
  }
}

function buildHeadline(
  assessment:
    WalletIntelligenceBrief["overallAssessment"],
): string {
  switch (assessment) {
    case "high_risk_indicators":
      return "High-risk indicators identified";

    case "elevated_risk_indicators":
      return "Elevated risk indicators identified";

    case "mixed_risk_indicators":
      return "Mixed risk indicators identified";

    case "low_risk_indicators":
    default:
      return "Low-risk indicators identified";
  }
}

function determineEvidenceStrength(
  evidenceRecordCount: number,
  supportingEvidenceRecordCount: number,
  informationGapCount: number,
): WalletIntelligenceBrief["evidenceStrength"] {
  if (
    evidenceRecordCount >= 10 &&
    supportingEvidenceRecordCount >= 3 &&
    informationGapCount <= 3
  ) {
    return "high";
  }

  if (
    evidenceRecordCount >= 5 &&
    supportingEvidenceRecordCount >= 2
  ) {
    return "medium";
  }

  return "low";
}
