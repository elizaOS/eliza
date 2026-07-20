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
  firstParsedTransaction: unknown;
  parsedTransactions: unknown[];
  tokenPrices: Record<string, number>;
}

export interface WalletPipelineOutput {
  activity: unknown;
  age: unknown;
  funding: unknown;
  portfolio: unknown;
  risk: unknown;
  whale: unknown;
  defi: unknown;
  behavior: unknown;
  exposure: unknown;
  relationships: unknown;
  custodyProfile: unknown;
  complianceScreening: unknown;
  intelligenceSources: unknown;
  trust: unknown;
  display: unknown;
  caseSummary: unknown;
  transactionRisk: unknown;
  transactionRiskAssessment: unknown;
  smartMoney: unknown;
  investigationReplay: unknown;
  evidenceRecords: unknown;
  decision: unknown;
  assessment: unknown;
  intelligenceBrief: unknown;
  evidence: unknown;
  executiveVerdict: unknown;
  investigationReport: unknown;
  investigationNarrative: unknown;
}
