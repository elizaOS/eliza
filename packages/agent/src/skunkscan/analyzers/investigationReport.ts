import {
  SupportedChain,
  WalletCaseSummary,
  WalletExecutiveVerdict,
  WalletInvestigationReport,
} from "../types";

export function analyzeInvestigationReport(
  chain: SupportedChain,
  address: string,
  executiveVerdict: WalletExecutiveVerdict,
  caseSummary: WalletCaseSummary,
): WalletInvestigationReport {
  return {
    generatedAt: new Date().toISOString(),

    reportVersion: "1.0",

    executiveSummary: caseSummary.executiveSummary,

    overallRecommendation: executiveVerdict.recommendation,

    highlights: [
      executiveVerdict.headline,
      ...caseSummary.keyFindings,
    ],

    investigationScope: {
      blockchain: chain,
      investigatedAddress: address,
      investigationType: "wallet_screening",
    },

    disclaimer:
      "This report is based on blockchain data and connected intelligence sources available at the time of screening. Conclusions are evidence-based assessments and should not be interpreted as guarantees or legal advice.",
  };
}
