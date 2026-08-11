import { analyzeWalletActivity } from "../analyzers/activity";
import { analyzeWalletAge } from "../analyzers/walletAge";
import { analyzeWalletAlpha } from "../analyzers/alpha";
import { analyzeWalletAssessment } from "../analyzers/assessment";
import { analyzeWalletBehavior } from "../analyzers/behavior";
import { analyzeWalletCaseSummary } from "../analyzers/caseSummary";
import { analyzeWalletCompliance } from "../analyzers/compliance";
import { analyzeWalletConviction } from "../analyzers/conviction";
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
import { analyzeInvestmentStyle } from "../analyzers/investmentStyle";
import { analyzeWalletPortfolio } from "../analyzers/portfolio";
import { analyzeProtocolIntelligence } from "../analyzers/protocolIntelligence";
import { analyzeWalletProfitability } from "../analyzers/profitability";
import { analyzeWalletProtocols } from "../analyzers/protocols";
import { analyzeWalletRelationships } from "../analyzers/relationships";
import { analyzeWalletReputation } from "../analyzers/reputation";
import { analyzeWalletRisk } from "../analyzers/risk";
import { analyzeSkunkScore } from "../analyzers/skunkScore";
import { analyzeWalletSmartMoney } from "../analyzers/smartMoney";
import { analyzeWalletStrategy } from "../analyzers/strategy";
import { analyzeWalletTransactionRisk } from "../analyzers/transactionRisk";
import { analyzeWalletTrust } from "../analyzers/trust";
import { analyzeWalletWhaleStatus } from "../analyzers/whale";
import { ParsedWalletTransaction } from "../parsers/transaction";
import { TokenPrice } from "../providers/pricing/types";
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
  // Only set for multi-address wallets (currently: Bitcoin xpub input) -
  // the full derived-address set. When present, this is what funding/
  // relationships/exposure match transfers against instead of `address`
  // alone (all three accept string | readonly string[] - see
  // analyzers/exposure.ts, funding.ts, relationships.ts), so a transfer
  // landing on any derived address is correctly attributed to this
  // wallet, not just the one primary address string. Every other
  // consumer inside runWalletPipeline (display/evidence-record text, etc.)
  // keeps using `address` alone - undefined here means single-address,
  // not "unknown", same convention as WalletActivitySummary's
  // addressesInSample.
  addressSet?: readonly string[];
  balance: WalletBalance;
  tokenHoldings: WalletTokenHolding[];
  recentTransactions: WalletRecentTransaction[];
  oldestTransactionId?: string;
  oldestTransactionTimestamp?: number;
  firstParsedTransaction: ParsedWalletTransaction | null;
  // Normalized and chain-neutral — the single transaction shape every
  // analyzer downstream consumes.
  normalizedRecentParsedTransactions: ParsedWalletTransaction[];
  tokenPrices: Record<string, TokenPrice>;
  // True when tokenHoldings above is a truncated/timed-out partial list,
  // not the wallet's real full holdings - Solana's SOLANA_TOKEN_HOLDINGS_
  // TRUNCATED or EVM's *_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT.
  // Threaded into WalletPortfolioSummary.dataCompleteness. Defaults to
  // false (every other chain/case) when omitted.
  tokenHoldingsIncomplete?: boolean;
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

export type WalletStrategyPipelineResult =
  ReturnType<typeof analyzeWalletStrategy>;

export type WalletConvictionPipelineResult =
  ReturnType<typeof analyzeWalletConviction>;

export type WalletAlphaPipelineResult =
  ReturnType<typeof analyzeWalletAlpha>;

export type WalletInvestmentStylePipelineResult =
  ReturnType<typeof analyzeInvestmentStyle>;

export type WalletProfitabilityPipelineResult =
  ReturnType<typeof analyzeWalletProfitability>;

export type WalletReputationPipelineResult =
  ReturnType<typeof analyzeWalletReputation>;

export type WalletSkunkScorePipelineResult =
  ReturnType<typeof analyzeSkunkScore>;

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
  strategy: WalletStrategyPipelineResult;
  conviction: WalletConvictionPipelineResult;
  alpha: WalletAlphaPipelineResult;
  investmentStyle: WalletInvestmentStylePipelineResult;
  profitability: WalletProfitabilityPipelineResult;
  reputation: WalletReputationPipelineResult;
  skunkScore: WalletSkunkScorePipelineResult;
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
