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

export type WalletInvestigationResult = {
  chain: SupportedChain;
  address: string;
  status: WalletInvestigationStatus;
  balance?: WalletBalance;
recentTransactions?: WalletRecentTransaction[];
transactionCountSample?: number;
summary: string;
warnings: string[];
};
