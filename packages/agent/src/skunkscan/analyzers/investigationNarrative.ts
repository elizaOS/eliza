import {
  WalletCaseSummary,
  WalletExecutiveVerdict,
  WalletInvestigationNarrative,
  WalletTrustSummary,
} from "../types";

export function analyzeInvestigationNarrative(
  executiveVerdict: WalletExecutiveVerdict,
  caseSummary: WalletCaseSummary,
  trust: WalletTrustSummary,
): WalletInvestigationNarrative {
  return {
    summary:
      caseSummary.executiveSummary,

    findings: [
      ...caseSummary.keyFindings,
    ],

    conclusion:
      executiveVerdict.headline,

    recommendation:
      executiveVerdict.suggestedAction,

    confidenceStatement:
      `This assessment was produced with ${trust.confidence} confidence based on the available blockchain evidence and connected intelligence sources at the time of screening.`,

    limitationsStatement:
      "Blockchain intelligence changes over time. This assessment reflects only the evidence available at the time the investigation was performed.",
  };
}
