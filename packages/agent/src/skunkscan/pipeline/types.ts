import { analyzeWalletActivity } from "../analyzers/activity";
import { analyzeWalletAge } from "../analyzers/walletAge";
import { analyzeWalletAssessment } from "../analyzers/assessment";
import { analyzeWalletBehavior } from "../analyzers/behavior";
import { analyzeWalletCaseSummary } from "../analyzers/caseSummary";
import { analyzeWalletCompliance } from "../analyzers/compliance";
import { analyzeWalletCustodyProfile } from "../analyzers/custody";
import { analyzeWalletDecision } from "../analyzers/decision";
import { analyzeWalletDeFi } from "../analyzers/defi";
import { analyzeWalletDisplayScores } from "../analyzers/display";
import { analyzeWalletEvidence } from "../analyzers/evidence";
import { analyzeWalletEvidenceRecords } from "../analyzers/evidenceRecords";
import { analyzeExecutiveVerdict } from "../analyzers/executiveVerdict";
import { analyzeWalletExposure } from "../analyzers/exposure";
import { analyzeWalletFunding } from "../analyzers/funding";
import { analyzeWalletIntelligenceBrief } from "../analyzers/intelligenceBrief";
import { analyzeInvestigationNarrative } from "../analyzers/investigationNarrative";
import { analyzeInvestigationReplay } from "../analyzers/investigationReplay";
import { analyzeInvestigationReport } from "../analyzers/investigationReport";
import { analyzeWalletPortfolio } from "../analyzers/portfolio";
import { analyzeProtocolIntelligence } from "../analyzers/protocolIntelligence";
import { analyzeWalletProtocols } from "../analyzers/protocols";
import { analyzeWalletRelationships } from "../analyzers/relationships";
import { analyzeWalletRisk } from "../analyzers/risk";
import { analyzeWalletSmartMoney } from "../analyzers/smartMoney";
import { analyzeWalletTransactionRisk } from "../analyzers/transactionRisk";
import { analyzeWalletTrust } from "../analyzers/trust";
import { analyzeWalletWhaleStatus } from "../analyzers/whale";
import { SolanaParsedTransaction } from "../helius";
import { ParsedWalletTransaction } from "../parsers/transaction";
import { TokenPrice } from "../providers/priceProvider";
import { getWalletIntelligenceSources } from "../sources/registry";
import {
  SupportedChain,
  WalletBalance,
  WalletRecentTransaction,
  WalletTokenHolding,
} from "../types";

export interface WalletPipelineInput {
  chain: SupportedChain;
  address: string;
  balance: WalletBalance;
  tokenHoldings: WalletTokenHolding[];
  recentTransactions: WalletRecentTransaction[];
  oldestTransactionId?: string;
  oldestTransactionTimestamp?: number;
  firstParsedTransaction: ParsedWalletTransaction | null;
  // Raw, unnormalized — consumed only by relationships.ts today.
  // Slated to move to normalizedRecentParsedTransactions in a
  // fast-follow once relationships.ts is migrated (see PR description).
  recentParsedTransactions: SolanaParsedTransaction[];
  // Normalized, chain-neutral — consumed by defi.ts/protocols.ts.
  normalizedRecentParsedTransactions: ParsedWalletTransaction[];
  tokenPrices: Record<string, TokenPrice>;
}

export type WalletActivityPipelineResult =
  ReturnType<typeof analyzeWalletActivity>;

export type WalletAgePipelineResult =
  ReturnType<typeof analyzeWalletAge>;

export type WalletFundingPipelineResult =
  ReturnType<typeof analyzeWalletFunding>;

export type WalletPortfolioPipelineResult =
  ReturnType<typeof analyzeWalletPortfolio>;

export type WalletRiskPipelineResult =
  ReturnType<typeof analyzeWalletRisk>;

export type WalletWhalePipelineResult =
  ReturnType<typeof analyzeWalletWhaleStatus>;

export type WalletDeFiPipelineResult =
  ReturnType<typeof analyzeWalletDeFi>;

export type WalletProtocolsPipelineResult =
  ReturnType<typeof analyzeWalletProtocols>;

export type WalletProtocolIntelligencePipelineResult =
  ReturnType<typeof analyzeProtocolIntelligence>;

export type WalletBehaviorPipelineResult =
  ReturnType<typeof analyzeWalletBehavior>;

export type WalletExposurePipelineResult =
  ReturnType<typeof analyzeWalletExposure>;

export type WalletRelationshipsPipelineResult =
  ReturnType<typeof analyzeWalletRelationships>;

export type WalletCustodyPipelineResult =
  ReturnType<typeof analyzeWalletCustodyProfile>;

export type WalletCompliancePipelineResult =
  ReturnType<typeof analyzeWalletCompliance>;

export type WalletIntelligenceSourcesPipelineResult =
  ReturnType<typeof getWalletIntelligenceSources>;

export type WalletTrustPipelineResult =
  ReturnType<typeof analyzeWalletTrust>;

export type WalletDisplayPipelineResult =
  ReturnType<typeof analyzeWalletDisplayScores>;

export type WalletCaseSummaryPipelineResult =
  ReturnType<typeof analyzeWalletCaseSummary>;

export type WalletTransactionRiskPipelineResult =
  ReturnType<typeof analyzeWalletTransactionRisk>;

export type WalletTransactionRiskAssessmentPipelineResult =
  Omit<
    WalletTransactionRiskPipelineResult,
    "recommendation"
  >;

export type WalletSmartMoneyPipelineResult =
  ReturnType<typeof analyzeWalletSmartMoney>;

export type WalletInvestigationReplayPipelineResult =
  ReturnType<typeof analyzeInvestigationReplay>;

export type WalletEvidenceRecordsPipelineResult =
  ReturnType<typeof analyzeWalletEvidenceRecords>;

export type WalletDecisionPipelineResult =
  ReturnType<typeof analyzeWalletDecision>;

export type WalletAssessmentPipelineResult =
  ReturnType<typeof analyzeWalletAssessment>;

export type WalletIntelligenceBriefPipelineResult =
  ReturnType<typeof analyzeWalletIntelligenceBrief>;

export type WalletEvidencePipelineResult =
  ReturnType<typeof analyzeWalletEvidence>;

export type WalletExecutiveVerdictPipelineResult =
  ReturnType<typeof analyzeExecutiveVerdict>;

export type WalletInvestigationReportPipelineResult =
  ReturnType<typeof analyzeInvestigationReport>;

export type WalletInvestigationNarrativePipelineResult =
  ReturnType<typeof analyzeInvestigationNarrative>;

export interface WalletPipelineOutput {
  activity: WalletActivityPipelineResult;
  age: WalletAgePipelineResult;
  funding: WalletFundingPipelineResult;
  portfolio: WalletPortfolioPipelineResult;
  risk: WalletRiskPipelineResult;
  whale: WalletWhalePipelineResult;
  defi: WalletDeFiPipelineResult;
  protocols: WalletProtocolsPipelineResult;
  protocolIntelligence:
    WalletProtocolIntelligencePipelineResult;
  behavior: WalletBehaviorPipelineResult;
  exposure: WalletExposurePipelineResult;
  relationships: WalletRelationshipsPipelineResult;
  custodyProfile: WalletCustodyPipelineResult;
  complianceScreening: WalletCompliancePipelineResult;
  intelligenceSources: WalletIntelligenceSourcesPipelineResult;
  trust: WalletTrustPipelineResult;
  display: WalletDisplayPipelineResult;
  caseSummary: WalletCaseSummaryPipelineResult;
  transactionRisk: WalletTransactionRiskPipelineResult;
  transactionRiskAssessment:
    WalletTransactionRiskAssessmentPipelineResult;
  smartMoney: WalletSmartMoneyPipelineResult;
  investigationReplay:
    WalletInvestigationReplayPipelineResult;
  evidenceRecords: WalletEvidenceRecordsPipelineResult;
  decision: WalletDecisionPipelineResult;
  assessment: WalletAssessmentPipelineResult;
  intelligenceBrief: WalletIntelligenceBriefPipelineResult;
  evidence: WalletEvidencePipelineResult;
  executiveVerdict: WalletExecutiveVerdictPipelineResult;
  investigationReport:
    WalletInvestigationReportPipelineResult;
  investigationNarrative:
    WalletInvestigationNarrativePipelineResult;
}
