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

export type WalletTokenHolding = {
  mint: string;
  amount: number;
  decimals: number;
  rawAmount: string;
};

export type WalletPortfolioToken = {
  mint: string;
  amount: number;
  decimals: number;
  rawAmount: string;
  symbol?: string | null;
  name?: string | null;
  estimatedUsdValue?: number | null;
};

export type WalletPortfolioSummary = {
  nativeBalance: WalletBalance;
  tokenCount: number;
  largestHoldingPercentage: number | null;
  diversityScore: number;
  diversityLevel: "none" | "low" | "medium" | "high";
  topTokenHoldings: WalletPortfolioToken[];
  estimatedTotalUsdValue?: number | null;
  concentrationLevel: "none" | "low" | "medium" | "high";
  notes: string[];
};

export type WalletActivitySummary = {
  recentTransactionCount: number;
  failedTransactionCount: number;
  lastActiveAt?: number | null;
  activityLevel: "none" | "low" | "medium" | "high";
};

export type WalletAgeSummary = {
  firstKnownTransaction?: string | null;
  firstKnownTransactionAt?: number | null;
  ageInDays?: number | null;
  ageInMonths?: number | null;
  classification: "unknown" | "new" | "established" | "veteran";
};

export type WalletLabelCategory =
  | "unknown"
  | "personal_wallet"
  | "centralized_exchange"
  | "decentralized_exchange"
  | "bridge"
  | "defi_protocol"
  | "nft_marketplace"
  | "staking"
  | "token_program"
  | "system_program"
  | "suspicious"
  | "scam"
  | "rug_pull";

export type WalletLabel = {
  address: string;
  label: string;
  category: WalletLabelCategory;
  confidence: "low" | "medium" | "high";
  source: "static_registry" | "heuristic" | "unknown";
};

export type WalletFundingSummary = {
  firstFundingTransaction?: string | null;
  firstFundingAt?: number | null;
  fundingWallet?: string | null;
  fundingAmountSol?: number | null;
  fundingSourceType: "unknown" | "wallet" | "exchange" | "bridge" | "program";
  fundingSourceLabel?: WalletLabel | null;
  confidence: "low" | "medium" | "high";
  notes: string[];
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
  tokenHoldings?: WalletTokenHolding[];
  portfolio?: WalletPortfolioSummary;
  recentTransactions?: WalletRecentTransaction[];
  transactionCountSample?: number;
  activity?: WalletActivitySummary;
  age?: WalletAgeSummary;
  funding?: WalletFundingSummary;
  risk?: WalletRiskSummary;
  summary: string;
  warnings: string[];
};
