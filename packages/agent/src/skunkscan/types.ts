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

export type WalletRelationship = {
  address: string;
  relationship:
    | "funder"
    | "receiver"
    | "exchange"
    | "bridge"
    | "known_wallet";

  label?: string | null;

  confidence: "low" | "medium" | "high";
};

export type WalletRelationshipSummary = {
  relationshipCount: number;
  relationships: WalletRelationship[];
  evidenceConfidence: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
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

export type WalletTrustSummary = {
  trustScore: number;
  trustLevel: "very_low" | "low" | "medium" | "high" | "very_high";
  confidence: "low" | "medium" | "high";
  positiveSignals: string[];
  limitations: string[];
};

export type WalletInvestigationReplayStep = {
  step: number;
  stage:
    | "validation"
    | "balance"
    | "transactions"
    | "activity"
    | "age"
    | "funding"
    | "portfolio"
    | "defi"
    | "exposure"
    | "relationships"
    | "risk"
    | "whale"
    | "behavior"
    | "trust"
    | "case_summary";
  status: "completed" | "limited" | "skipped";
  title: string;
  description: string;
};

export type WalletDisplayScore = {
  rawScore: number;
  displayScore: string;
  label: string;
  maxScore: 10;
};

export type WalletDisplaySummary = {
  risk: WalletDisplayScore;
  trust: WalletDisplayScore;
  exposure: WalletDisplayScore;
  whale: WalletDisplayScore;
};

export type WalletExecutiveVerdict = {
  verdict: "low_risk" | "review" | "investigate" | "high_risk";
  headline: string;
  riskDisplay: string;
  trustDisplay: string;
  exposureDisplay: string;
  profile: string;
  recommendation: WalletCaseSummary["recommendation"];
  confidence: "low" | "medium" | "high";
  why: string[];
  suggestedAction: string;
};

export type WalletCustodyProfile = {
  custodyType:
    | "unknown"
    | "likely_hosted"
    | "likely_unhosted";

  temperatureProfile:
    | "unknown"
    | "likely_hot"
    | "likely_cold"
    | "likely_warm";

  confidence: "low" | "medium" | "high";
  reasons: string[];
  limitations: string[];
};

export type WalletComplianceScreeningSource = {
  name: string;
  category:
    | "sanctions"
    | "adverse_media"
    | "internal_registry"
    | "external_provider";
  status: "connected" | "planned" | "unavailable";
  coverage: string[];
  lastUpdatedAt?: string | null;
  notes: string[];
};

export type WalletIntelligenceSource = {
  id: string;
  name: string;
  category:
    | "blockchain_provider"
    | "price_provider"
    | "metadata_provider"
    | "label_registry"
    | "protocol_registry"
    | "exposure_registry"
    | "compliance_provider";
  status: "connected" | "planned" | "unavailable";
  coverage: string[];
  lastUpdatedAt?: string | null;
  notes: string[];
};

export type WalletComplianceScreeningSummary = {
  sanctionsStatus:
    | "not_screened"
    | "no_match_in_connected_sources"
    | "possible_match"
    | "confirmed_match";

  adverseMediaStatus:
    | "not_screened"
    | "no_match_in_connected_sources"
    | "possible_match"
    | "confirmed_match";

  screeningConfidence: "low" | "medium" | "high";
  
  sourcesChecked: WalletComplianceScreeningSource[];
  
  matches: {
    type: "sanctions" | "adverse_media";
    source: string;
    label: string;
    confidence: "low" | "medium" | "high";
    notes: string[];
  }[];

  limitations: string[];
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
  evidenceConfidence: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  notes: string[];
};

export type WalletRiskSummary = {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
};

export type WalletTransactionRiskSummary = {
  assessmentType: "wallet_context";
  rawScore: number;
  maxScore: 100;
  level: "low" | "medium" | "high";
  displayScore: string;
  maxDisplayScore: 10;
  recommendation:
    | "allow"
    | "review"
    | "investigate"
    | "high_risk";
  reasons: string[];
  limitations: string[];
};

export type WalletSmartMoneySummary = {
  isSmartMoneyCandidate: boolean;
  smartMoneyScore: number;
  displayScore: string;
  level: "none" | "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  profile:
    | "unknown"
    | "professional_trader"
    | "active_defi_participant"
    | "long_term_investor"
    | "liquidity_provider"
    | "whale_participant";
  positiveSignals: string[];
  limitations: string[];
};

export type WalletInvestigationReport = {
  generatedAt: string;

  reportVersion: string;

  executiveSummary: string;

  overallRecommendation:
    | "allow"
    | "review"
    | "investigate"
    | "high_risk";

  highlights: string[];

  investigationScope: {
    blockchain: SupportedChain;
    investigatedAddress: string;
    investigationType: "wallet_screening";
  };

  disclaimer: string;
};

export type WalletInvestigationNarrative = {
  summary: string;
  findings: string[];
  conclusion: string;
  recommendation: string;
  confidenceStatement: string;
  limitationsStatement: string;
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
  display?: WalletDisplaySummary;
  executiveVerdict?: WalletExecutiveVerdict;
  custodyProfile?: WalletCustodyProfile;
  complianceScreening?: WalletComplianceScreeningSummary;
  intelligenceSources?: WalletIntelligenceSource[];
  trust?: WalletTrustSummary;
  investigationReplay?: WalletInvestigationReplayStep[];
  exposure?: WalletExposureSummary;
  relationships?: WalletRelationshipSummary;
  evidence?: WalletEvidenceItem[];
  recentTransactions?: WalletRecentTransaction[];
  transactionCountSample?: number;
  activity?: WalletActivitySummary;
  age?: WalletAgeSummary;
  funding?: WalletFundingSummary;
  risk?: WalletRiskSummary;
  transactionRisk?: WalletTransactionRiskSummary;
  smartMoney?: WalletSmartMoneySummary;
  investigationReport?: WalletInvestigationReport;
  investigationNarrative?: WalletInvestigationNarrative;
  summary: string;
  warnings: string[];
};
