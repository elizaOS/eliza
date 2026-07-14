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

  const informationGaps = Array.from(
    new Set([
      ...assessment.limitations,

      ...evidenceRecords.flatMap(
        (record) => record.limitations,
      ),
    ]),
  ).filter((gap) => gap.trim().length > 0);

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
