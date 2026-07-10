import {
  SupportedChain,
  WalletCaseSummary,
  WalletDecisionSummary,
  WalletEvidenceRecord,
  WalletExecutiveVerdict,
  WalletInvestigationReport,
} from "../types";

export function analyzeInvestigationReport(
  chain: SupportedChain,
  address: string,
  executiveVerdict: WalletExecutiveVerdict,
  caseSummary: WalletCaseSummary,
  decision?: WalletDecisionSummary,
  evidenceRecords?: WalletEvidenceRecord[],
): WalletInvestigationReport {
  const highlights =
    decision && evidenceRecords
      ? [
          executiveVerdict.headline,
          ...decision.factors
            .slice(0, 4)
            .map((factor) => factor.description),
        ]
      : [
          executiveVerdict.headline,
          ...caseSummary.keyFindings,
        ];

  return {
    generatedAt: new Date().toISOString(),

    reportVersion: "1.0",

    executiveSummary: caseSummary.executiveSummary,

    overallRecommendation:
      decision?.recommendation ??
      executiveVerdict.recommendation,

    highlights,

    investigationScope: {
      blockchain: chain,
      investigatedAddress: address,
      investigationType: "wallet_screening",
    },

    disclaimer:
      "This report is based on blockchain data and connected intelligence sources available at the time of screening. Conclusions are evidence-based assessments and should not be interpreted as guarantees or legal advice.",
  };
}
