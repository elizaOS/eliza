import {
  WalletCaseSummary,
  WalletDecisionSummary,
  WalletEvidenceRecord,
  WalletExecutiveVerdict,
  WalletInvestigationNarrative,
  WalletTrustSummary,
} from "../types";

export function analyzeInvestigationNarrative(
  executiveVerdict: WalletExecutiveVerdict,
  caseSummary: WalletCaseSummary,
  trust: WalletTrustSummary,
  decision?: WalletDecisionSummary,
  evidenceRecords?: WalletEvidenceRecord[],
): WalletInvestigationNarrative {
  if (decision && evidenceRecords) {
    const findings = decision.factors
      .slice(0, 5)
      .map((factor) => factor.description);

    const linkedEvidenceCount =
      decision.supportingEvidenceRecordIds.filter((id) =>
        evidenceRecords.some((record) => record.id === id),
      ).length;

    const limitationsStatement =
      decision.limitations.length > 0
        ? decision.limitations.join(" ")
        : "Blockchain activity and connected intelligence sources may change after the time of screening.";

    return {
      summary:
        `Based on the available evidence at the time of screening, this wallet is assessed as ${formatDecision(
          decision.decision,
        )}. The recommended action is ${formatRecommendation(
          decision.recommendation,
        )}.`,

      findings,

      conclusion: executiveVerdict.headline,

      recommendation: executiveVerdict.suggestedAction,

      confidenceStatement:
        `This assessment was produced with ${decision.confidence} confidence and is supported by ${linkedEvidenceCount} linked evidence record(s).`,

      limitationsStatement,
    };
  }

  return {
    summary: caseSummary.executiveSummary,

    findings: [...caseSummary.keyFindings],

    conclusion: executiveVerdict.headline,

    recommendation: executiveVerdict.suggestedAction,

    confidenceStatement:
      `This assessment was produced with ${trust.confidence} confidence based on the available blockchain evidence and connected intelligence sources at the time of screening.`,

    limitationsStatement:
      "Blockchain intelligence changes over time. This assessment reflects only the evidence available at the time the investigation was performed.",
  };
}

function formatDecision(
  decision: WalletDecisionSummary["decision"],
): string {
  switch (decision) {
    case "low_risk":
      return "Low Risk";

    case "review":
      return "Review";

    case "investigate":
      return "Investigate";

    case "high_risk":
      return "High Risk";

    default:
      return "undetermined";
  }
}

function formatRecommendation(
  recommendation: WalletDecisionSummary["recommendation"],
): string {
  switch (recommendation) {
    case "allow":
      return "Allow";

    case "review":
      return "Review";

    case "investigate":
      return "Investigate";

    case "high_risk":
      return "High Risk escalation";

    default:
      return "Review";
  }
}
