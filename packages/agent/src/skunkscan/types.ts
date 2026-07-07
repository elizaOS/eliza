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

export type WalletWhaleSummary = {
  isWhale: boolean;
  whaleScore: number;
  whaleLevel: "none" | "small" | "medium" | "large";
  estimatedPortfolioUsdValue?: number | null;
  reasons: string[];
};

export type WalletEvidenceItem = {
  id: string;
  category:
    | "identity"
    | "activity"
    | "age"
    | "funding"
    | "portfolio"
    | "defi"
    | "risk"
    | "whale"
    | "behavior"
    | "exposure";
  severity: "info" | "low" | "medium" | "high";
  title: string;
  description: string;
};

export type WalletExposureSummary = {
  exposureScore: number;
  exposureLevel: "none" | "low" | "medium" | "high";
  hasKnownScamExposure: boolean;
  hasKnownRugPullExposure: boolean;
  hasKnownSuspiciousExposure: boolean;
  matches: {
    address: string;
    label: string;
    category: "scam" | "rug_pull" | "suspicious" | "sanctioned" | "adverse_media";
    confidence: "low" | "medium" | "high";
    source: "static_registry" | "external_provider" | "manual_review";
    relationship: "self" | "funder" | "counterparty";
  }[];
  notes: string[];
};

export type WalletDeFiProtocol = {
  programId: string;
  protocol: string;
  category:
    | "dex"
    | "dex_aggregator"
    | "lending"
    | "staking"
    | "liquidity"
    | "bridge"
    | "nft"
    | "other";
  interactionCount: number;
};

export type WalletDeFiSummary = {
  protocolCount: number;
  protocols: WalletDeFiProtocol[];
  profile:
    | "none"
    | "casual_user"
    | "active_defi_user"
    | "power_user";
  notes: string[];
};

export type WalletBehaviorSummary = {
  primaryProfile:
    | "unknown"
    | "new_wallet"
    | "holder"
    | "active_trader"
    | "defi_user"
    | "liquidity_provider"
    | "whale"
    | "high_risk_wallet";

  confidence: "low" | "medium" | "high";

  traits: string[];

  explanation: string;
};

export type WalletCaseSummary = {
  headline: string;
  executiveSummary: string;
  keyFindings: string[];
  recommendation:
    | "allow"
    | "review"
    | "investigate"
    | "high_risk";
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
  whale?: WalletWhaleSummary;
  defi?: WalletDeFiSummary;
  behavior?: WalletBehaviorSummary;
  caseSummary?: WalletCaseSummary;
  exposure?: WalletExposureSummary;
  evidence?: WalletEvidenceItem[];
  recentTransactions?: WalletRecentTransaction[];
  transactionCountSample?: number;
  activity?: WalletActivitySummary;
  age?: WalletAgeSummary;
  funding?: WalletFundingSummary;
  risk?: WalletRiskSummary;
  summary: string;
  warnings: string[];
};
