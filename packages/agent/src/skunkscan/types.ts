export type SupportedChain = "solana" | "ethereum" | "base" | "bnb";

export type WalletInvestigationStatus =
  | "supported"
  | "unsupported_chain"
  | "invalid_address"
  | "error";

export type WalletBalance = {
  nativeAmount: number;
  nativeSymbol: string;
  rawAmount?: number;
};

export type WalletRecentTransaction = {
  signature: string;
  slot?: number;
  blockTime?: number | null;
  status: "success" | "failed" | "unknown";
};

export type WalletActivitySummary = {
  recentTransactionCount: number;
  failedTransactionCount: number;
  lastActiveAt?: number | null;
  activityLevel: "none" | "low" | "medium" | "high";
};

export type WalletRiskSummary = {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
};

export type WalletInvestigationResult = {
  chain: SupportedChain;
  address: string;
  status: WalletInvestigationStatus;
  balance?: WalletBalance;
recentTransactions?: WalletRecentTransaction[];
transactionCountSample?: number;
activity?: WalletActivitySummary;
risk?: WalletRiskSummary;
summary: string;
warnings: string[];
};
