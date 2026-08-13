import { InvestorExplanation } from "./explainability/types";
import { InvestorEvidenceCollection } from "./explainability/evidenceCollection";

// Single source of truth for "what chains does investigateWallet accept" -
// SupportedChain (the type) is derived FROM this array, not hand-written
// separately, specifically so nothing else in the codebase can define its
// own separate hardcoded chain list that silently drifts out of sync (real
// bug, not hypothetical: the /api/skunkscan/wallet route handler had its
// own hardcoded ["solana", "ethereum", "base", "bnb"] validation array,
// written before Bitcoin existed, that nobody updated when Bitcoin was
// wired into investigateWallet - live-confirmed the deployed API rejected
// every real "bitcoin" request with a 400 "Unsupported chain" while
// investigateWallet("bitcoin", ...) itself worked correctly). Add a new
// chain here once, in this one place, and every consumer (isSupportedChain
// below, the route handler, anything else that validates against this
// list) picks it up automatically - no second array to remember to update.
export const SUPPORTED_CHAINS = [
  "solana",
  "ethereum",
  "base",
  "bnb",
  "bitcoin",
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain);
}

// Every EVM-family chain uses the same checksummed-hex addressing (no
// alternate valid casing to normalize, unlike Solana's case-sensitive
// base58) - registry lookups across exposure/labels/reverse-index all
// need to lowercase-normalize EVM addresses before comparing against their
// (lowercase-stored) keys. This was fixed twice already scoped to the
// literal "ethereum" only (missing BSC would have been a third repeat of
// the same bug) - centralizing the "is this chain EVM" question here means
// the next EVM chain (e.g. Base, already a SupportedChain member) needs no
// further casing fix at all.
export function isEvmChain(chain: SupportedChain): boolean {
  return chain === "ethereum" || chain === "bnb" || chain === "base";
}

/**
 * Universal blockchain architecture.
 *
 * SupportedChain remains in use by the current API for backward
 * compatibility. New chain integrations should use ChainIdentifier
 * and BlockchainNetworkDefinition.
 */

export type ChainIdentifier = string;

export type BlockchainFamily =
  | "evm"
  | "utxo"
  | "solana"
  | "cosmos"
  | "move"
  | "xrp_ledger"
  | "stellar"
  | "cardano"
  | "substrate"
  | "tron"
  | "ton"
  | "algorand"
  | "near"
  | "other";

export type BlockchainNetworkType =
  | "mainnet"
  | "testnet"
  | "devnet"
  | "other";

export type BlockchainAddressModel =
  | "account"
  | "utxo"
  | "account_and_utxo"
  | "other";

export type BlockchainFinalityType =
  | "probabilistic"
  | "deterministic"
  | "hybrid"
  | "unknown";

export type BlockchainCapabilities = {
  supportsNativeAsset: boolean;
  supportsFungibleTokens: boolean;
  supportsNfts: boolean;
  supportsSmartContracts: boolean;
  supportsDefi: boolean;
  supportsStaking: boolean;
  supportsMemoOrTag: boolean;
  supportsInternalTransactions: boolean;
  supportsTransactionLogs: boolean;
  supportsTokenApprovals: boolean;
};

export type BlockchainNetworkDefinition = {
  id: ChainIdentifier;

  name: string;

  family: BlockchainFamily;

  networkType: BlockchainNetworkType;

  addressModel: BlockchainAddressModel;

  nativeAssetSymbol: string;

  nativeAssetDecimals: number;

  finalityType: BlockchainFinalityType;

  capabilities: BlockchainCapabilities;

  explorerUrl?: string | null;

  chainReference?: string | number | null;

  isEnabled: boolean;
};

export type UniversalAddressType =
  | "wallet"
  | "contract"
  | "program"
  | "validator"
  | "token_contract"
  | "multisig"
  | "exchange"
  | "bridge"
  | "protocol"
  | "unknown";

export type UniversalBlockchainAddress = {
  chainId: ChainIdentifier;

  address: string;

  normalizedAddress: string;

  addressType: UniversalAddressType;

  isValid: boolean;

  memoOrTag?: string | null;

  label?: string | null;

  metadata?: Record<string, unknown>;
};

export type UniversalAssetType =
  | "native"
  | "fungible_token"
  | "nft"
  | "semi_fungible_token"
  | "liquidity_position"
  | "other";

export type UniversalAssetIdentifier = {
  chainId: ChainIdentifier;

  assetType: UniversalAssetType;

  assetId: string;

  symbol?: string | null;

  name?: string | null;

  decimals?: number | null;

  contractAddress?: string | null;

  tokenId?: string | null;

  metadata?: Record<string, unknown>;
};

// A single NFT holding, chain-neutral. `asset.tokenId` carries the
// per-chain identifier (a Solana NFT's mint address; an EVM NFT's numeric
// token ID within `asset.contractAddress`) - the same split
// UniversalAssetIdentifier already uses for fungible tokens.
export type UniversalNftHolding = {
  asset: UniversalAssetIdentifier;
  name: string | null;
  collection: string | null;
  imageUrl: string | null;
};

export type UniversalAmount = {
  rawAmount: string;

  decimalAmount?: string | null;

  estimatedUsdValue?: number | null;
};

export type UniversalTransferDirection =
  | "incoming"
  | "outgoing"
  | "self"
  | "internal"
  | "unknown";

export type UniversalTransferType =
  | "native_transfer"
  | "token_transfer"
  | "nft_transfer"
  | "mint"
  | "burn"
  | "fee"
  | "reward"
  | "refund"
  | "internal_transfer"
  | "unknown";

export type UniversalTransfer = {
  id: string;

  chainId: ChainIdentifier;

  transactionId: string;

  transferIndex: number;

  transferType: UniversalTransferType;

  direction: UniversalTransferDirection;

  asset: UniversalAssetIdentifier;

  amount: UniversalAmount;

  from?: UniversalBlockchainAddress | null;

  to?: UniversalBlockchainAddress | null;

  success: boolean;

  metadata?: Record<string, unknown>;
};

export type UniversalTransactionStatus =
  | "pending"
  | "confirmed"
  | "finalized"
  | "failed"
  | "dropped"
  | "unknown";

export type UniversalTransactionClassification =
  | "transfer"
  | "swap"
  | "bridge"
  | "deposit"
  | "withdrawal"
  | "staking"
  | "unstaking"
  | "delegation"
  | "lending"
  | "borrowing"
  | "repayment"
  | "liquidation"
  | "liquidity_add"
  | "liquidity_remove"
  | "nft_trade"
  | "token_approval"
  | "contract_deployment"
  | "contract_interaction"
  | "governance"
  | "mining_reward"
  | "validator_reward"
  | "coinbase"
  | "consolidation"
  | "data_transaction"
  | "unknown";

export type UniversalTransaction = {
  chainId: ChainIdentifier;

  transactionId: string;

  blockIdentifier?: string | null;

  blockHeight?: number | null;

  transactionIndex?: number | null;

  timestamp?: number | null;

  status: UniversalTransactionStatus;

  classifications: UniversalTransactionClassification[];

  initiator?: UniversalBlockchainAddress | null;

  signers: UniversalBlockchainAddress[];

  counterparties: UniversalBlockchainAddress[];

  transfers: UniversalTransfer[];

  fee?: {
    asset: UniversalAssetIdentifier;
    amount: UniversalAmount;
    payer?: UniversalBlockchainAddress | null;
  } | null;

  programOrContractIds: string[];

  memo?: string | null;

  rawDataAvailable: boolean;

  metadata?: Record<string, unknown>;
};

export type ChainAdapterSupportLevel =
  | "full"
  | "partial"
  | "experimental"
  | "planned"
  | "unsupported";

export type ChainAdapterCapabilities = {
  addressValidation: boolean;

  balanceRetrieval: boolean;

  transactionRetrieval: boolean;

  transactionParsing: boolean;

  tokenRetrieval: boolean;

  nftRetrieval: boolean;

  protocolDetection: boolean;

  internalTransferDetection: boolean;

  historicalTransactionRetrieval: boolean;
};

export type ChainAdapterDescriptor = {
  chainId: ChainIdentifier;

  family: BlockchainFamily;

  supportLevel: ChainAdapterSupportLevel;

  capabilities: ChainAdapterCapabilities;

  providerNames: string[];

  limitations: string[];
};

export type WalletInvestigationStatus =
  | "supported"
  | "unsupported_chain"
  | "invalid_address"
  | "error";

export type WalletBalance = {
  nativeAmount: number;
  nativeSymbol: string;
  rawAmount?: number;
  estimatedUsdValue?: number | null;
};

export type WalletRecentTransaction = {
  transactionId: string;
  blockHeight?: number;
  blockTime?: number | null;
  status: "success" | "failed" | "unknown";
  // Optional: only computed on EVM chains today (Ethereum/BSC/Base) via
  // Moralis's possible_spam flag + the null-address-mint pattern - Solana
  // has no equivalent yet (deferred, separate follow-up). Undefined means
  // "not classified," not "confirmed clean" - never treat it as a
  // negative signal.
  likelySpam?: boolean;
};

export type WalletTokenHolding = {
  tokenId: string;
  amount: number;
  decimals: number;
  rawAmount: string;
};

export type WalletPortfolioToken = {
  tokenId: string;
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
  // "incomplete" when the underlying token-holdings fetch was truncated or
  // timed out (Solana's SOLANA_TOKEN_HOLDINGS_TRUNCATED, EVM's
  // *_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT) - every field above is
  // still computed from whatever holdings WERE retrieved, but tokenCount/
  // diversityLevel/estimatedTotalUsdValue reflect a partial wallet, not the
  // true total. Downstream analyzers that read this summary (whale.ts,
  // smartMoney.ts, alpha.ts, conviction.ts, profitability.ts) must not
  // treat "low diversity"/"low value" at face value when this is
  // "incomplete" - it may just mean the data wasn't fully retrievable, not
  // that the wallet is actually small. NFT-holdings truncation does NOT
  // affect this - nothing in WalletPortfolioSummary or its consumers reads
  // nftHoldings, confirmed by grep before wiring this in.
  dataCompleteness: "complete" | "incomplete";
  notes: string[];
};

export type WalletWhaleSummary = {
  isWhale: boolean;

  whaleScore: number;

  whaleLevel:
    | "none"
    | "small"
    | "medium"
    | "large";

  estimatedPortfolioUsdValue?: number | null;

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  confidence: "low" | "medium" | "high";

  reasons: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
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

export type WalletConfidenceAnalysis = {
  rawScore: number;
  maxScore: 100;
  displayScore: string;
  maxDisplayScore: 10;
  level: "low" | "medium" | "high";
  reasons: string[];
};

export type WalletDecisionFactor = {
  id: string;

  category:
    | "risk"
    | "trust"
    | "exposure"
    | "compliance"
    | "funding"
    | "relationships"
    | "custody"
    | "behavior"
    | "whale"
    | "smart_money"
    | "transaction_risk";

  effect: "positive" | "negative" | "neutral";

  weight: number;

  description: string;

  evidenceRecordIds: string[];
};

export type WalletAssessmentFactor = {
  id: string;

  category:
    | "risk"
    | "trust"
    | "exposure"
    | "transaction_risk";

  effect:
    | "positive"
    | "neutral"
    | "negative";

  weight: number;

  description: string;

  evidenceRecordIds: string[];
};

export type WalletDecisionSummary = {
  decision:
    | "low_risk"
    | "review"
    | "investigate"
    | "high_risk";

  recommendation:
    | "allow"
    | "review"
    | "investigate"
    | "high_risk";

  confidence: "low" | "medium" | "high";

  confidenceAnalysis: WalletConfidenceAnalysis;

  factors: WalletDecisionFactor[];

  supportingEvidenceRecordIds: string[];

  limitations: string[];
};

export type WalletAssessmentSummary = {
  assessment:
    | "low_risk"
    | "review"
    | "investigate"
    | "high_risk";

  confidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  factors: WalletAssessmentFactor[];

  supportingEvidenceRecordIds: string[];

  limitations: string[];

  userDecisionNotice: string;
};

export type WalletAssessmentContext = {
  overallAssessment: string;

  confidence: "low" | "medium" | "high";

  evidenceStrength:
    | "low"
    | "medium"
    | "high";

  keyFindings: string[];

  informationGaps: string[];

  supportingEvidenceRecordIds: string[];

  generatedAt: string;

  notice: string;
};

export type WalletIntelligenceBrief = {
  generatedAt: string;

  briefVersion: string;

  overallAssessment:
    | "low_risk_indicators"
    | "mixed_risk_indicators"
    | "elevated_risk_indicators"
    | "high_risk_indicators";

  headline: string;

  confidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  evidenceStrength:
    | "low"
    | "medium"
    | "high";

  keyFindings: string[];

  informationGaps: string[];

  supportingEvidenceRecordIds: string[];

  sourcesUsed: string[];

  notice: string;
};

export type WalletEvidenceRecord = {
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
    | "exposure"
    | "relationships"
    | "compliance"
    | "custody"
    | "smart_money"
    | "transaction_risk";

  fact: string;

  evidenceType:
    | "on_chain_fact"
    | "registry_match"
    | "provider_result"
    | "calculated_metric"
    | "analytical_inference";

  sourceId: string;
  sourceName: string;

  confidence: "low" | "medium" | "high";

  observedAt?: string | null;

  relatedAddresses: string[];

  limitations: string[];
};

export type WalletExposureSummary = {
  exposureScore: number;
  exposureLevel: "none" | "low" | "medium" | "high";
  evidenceConfidence: "low" | "medium" | "high";
  confidenceAnalysis?: WalletConfidenceAnalysis;
  confidence: "low" | "medium" | "high";
  hasKnownScamExposure: boolean;
  hasKnownRugPullExposure: boolean;
  hasKnownSuspiciousExposure: boolean;
  matches: {
    address: string;
    label: string;
    category: "scam" | "rug_pull" | "suspicious" | "sanctioned" | "adverse_media";
    confidence: "low" | "medium" | "high";
    source: "static_registry" | "external_provider" | "manual_review" | "reverse_index";
    relationship: "self" | "funder" | "counterparty";
    // Whether this match counts toward exposureScore/exposureLevel/the
    // hasKnown* booleans below. self and funder matches always contribute;
    // a counterparty match only contributes when direction is "outgoing" or
    // "bidirectional" - an incoming-only transfer from a flagged address
    // (e.g. an unsolicited spam-token airdrop) is a materially different
    // signal than the wallet itself sending funds to one, and is shown in
    // `matches` for visibility without moving the score.
    contributesToScore: boolean;
    // Populated for counterparty matches (the funder/self checks don't carry
    // a meaningful transfer direction the same way); omitted otherwise.
    direction?: WalletRelationshipDirection;
    transactionSignatures?: string[];
  }[];
  notes: string[];
};

export type WalletRelationshipDirection =
  | "incoming"
  | "outgoing"
  | "bidirectional"
  | "unknown";

export type WalletRelationship = {
  address: string;

  relationship:
    | "funder"
    | "sender"
    | "receiver"
    | "counterparty"
    | "exchange"
    | "bridge"
    | "known_wallet";

  label?: string | null;

  confidence: "low" | "medium" | "high";

  direction?: WalletRelationshipDirection;

  interactionCount?: number;

  incomingTransferCount?: number;

  outgoingTransferCount?: number;

  firstInteractionAt?: number | null;

  lastInteractionAt?: number | null;

  totalNativeAmountReceived?: number;

  totalNativeAmountSent?: number;

  transactionSignatures?: string[];

  evidenceReasons?: string[];

  limitations?: string[];

  // True when this address matched the protocol registry (any category -
  // DEX/bridge/lending/staking/etc.) or a known-infrastructure category in
  // the label registry (centralized_exchange, decentralized_exchange,
  // bridge, defi_protocol, nft_marketplace, staking, token_program,
  // system_program, burn_address). Deliberately does NOT reuse the
  // "exchange"/"bridge"/"known_wallet" values already in `relationship`
  // above - those are never assigned by analyzeWalletRelationships and
  // stay that way; this is a separate field so existing consumers of
  // `relationship` are unaffected. Still present in `relationships` below
  // for display/context, but excluded from relationshipCount and from the
  // confidence signals computed in this file - shared infrastructure
  // (millions of wallets touch the same DEX router or exchange hot
  // wallet) is not clustering evidence the way a shared unknown private
  // wallet is. suspicious/scam/rug_pull labels are deliberately NOT
  // infrastructure - a shared connection to a known-bad address is exactly
  // the signal worth surfacing, not suppressing.
  isKnownInfrastructure?: boolean;

  // Human-readable name of the matched registry entry (e.g. "Uniswap V2
  // Router02", "Binance 14") when isKnownInfrastructure is true - distinct
  // from `label` above, which reflects lookupWalletLabel only and stays
  // "Unknown Wallet" for a protocol-registry-only match.
  infrastructureLabel?: string | null;

  // Narrower than isKnownInfrastructure - true only for a
  // centralized_exchange label match, not any infrastructure category.
  // A wallet swapping on a DEX or bridging doesn't inform hosted-vs-
  // unhosted custody the way exchange interaction does, so this is a
  // separate, more specific signal for analyzers/custody.ts (which uses
  // it alongside funding.fundingSourceType === "exchange" - the same
  // signal, but for any relationship, not just the wallet's original
  // funder). The protocol registry can never produce this - centralized
  // exchanges aren't on-chain programs, so a centralized_exchange match
  // only ever comes from the label registry.
  isKnownExchange?: boolean;
};

export type WalletRelationshipSummary = {
  // Count of non-infrastructure relationships only - what scoring/
  // confidence should use. relationships.length may be larger than this;
  // see knownInfrastructureCount.
  relationshipCount: number;

  // Known-infrastructure relationships present in `relationships` below
  // but excluded from relationshipCount and from this summary's own
  // confidence computation - kept for transparency, not scoring.
  knownInfrastructureCount: number;

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  relationships: WalletRelationship[];

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

  reputation:
    | "high"
    | "medium"
    | "unknown";

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

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  confidence: "low" | "medium" | "high";

  traits: string[];

  explanation: string;

  limitations: string[];
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

  trustLevel:
    | "very_low"
    | "low"
    | "medium"
    | "high"
    | "very_high";

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  confidence: "low" | "medium" | "high";

  positiveSignals: string[];

  limitations: string[];

  investorExplanation: InvestorExplanation;
  
  investorInsights: InvestorEvidenceCollection;
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

// The always-free summary shown before any paywall. Deliberately headline-
// only for green/yellow (the full investigation is the paid product), but
// reasons are always populated for red - withholding an active scam warning
// behind a paywall would be a real harm, not just a lost sale, so red is
// never gated. See analyzers/trustCheckCard.ts.
export type WalletTrustCheckTier = "green" | "yellow" | "red";

export type WalletTrustCheckCard = {
  chain: SupportedChain;
  address: string;
  status: WalletInvestigationStatus;
  tier: WalletTrustCheckTier | null;
  headline: string;
  // Populated only when tier is "red" - see the file header comment above.
  reasons: string[];
  riskDisplay?: string;
  trustDisplay?: string;
  exposureDisplay?: string;
  warnings: string[];
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

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

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

  // Mirror sanctionsStatus/adverseMediaStatus exactly, sourced from
  // WalletExposureSummary's hasKnownScamExposure/hasKnownRugPullExposure/
  // hasKnownSuspiciousExposure booleans - the internal registry these
  // reflect was already claimed as "connected" in sourcesChecked below,
  // but until this addition nothing in this file's own matches/status
  // fields actually surfaced those 3 categories.
  scamStatus:
    | "not_screened"
    | "no_match_in_connected_sources"
    | "possible_match"
    | "confirmed_match";

  rugPullStatus:
    | "not_screened"
    | "no_match_in_connected_sources"
    | "possible_match"
    | "confirmed_match";

  suspiciousStatus:
    | "not_screened"
    | "no_match_in_connected_sources"
    | "possible_match"
    | "confirmed_match";

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  screeningConfidence: "low" | "medium" | "high";

  sourcesChecked: WalletComplianceScreeningSource[];

  matches: {
    type: "sanctions" | "adverse_media" | "scam" | "rug_pull" | "suspicious";
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
  // Only set for multi-address wallets (currently: Bitcoin xpub input).
  // activityLevel's thresholds were calibrated for one address - the same
  // raw transaction count means something different when it's spread
  // across N addresses (routine HD-wallet address rotation, not unusually
  // high activity). Rather than invent an unvalidated per-address scaling
  // formula, this is surfaced so activityLevel can be read in context
  // instead of taken at face value. Undefined means single-address, not
  // "unknown."
  addressesInSample?: number;
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
  | "rug_pull"
  | "burn_address";

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
  fundingAmountNative?: number | null;
  fundingTokenId?: string | null;
  fundingAmountToken?: number | null;
  fundingTransferType: "native" | "token" | "unknown";
  fundingSourceType: "unknown" | "wallet" | "exchange" | "bridge" | "program";
  fundingSourceLabel?: WalletLabel | null;
  evidenceConfidence: "low" | "medium" | "high";
  confidenceAnalysis?: WalletConfidenceAnalysis;
  confidence: "low" | "medium" | "high";
  notes: string[];
};

export type WalletRiskSummary = {
  score: number;

  level:
    | "low"
    | "medium"
    | "high";

  evidenceConfidence?: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  confidence?: "low" | "medium" | "high";

  reasons: string[];

  limitations?: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletTransactionRiskSummary = {
  assessmentType: "wallet_context";

  rawScore: number;

  maxScore: 100;

  level: "low" | "medium" | "high";

  displayScore: string;

  maxDisplayScore: 10;

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  confidence: "low" | "medium" | "high";

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

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

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

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletStrategySummary = {
  primaryStrategy:
    | "unknown"
    | "accumulating"
    | "holding"
    | "active_trading"
    | "taking_profits"
    | "distributing"
    | "defi_participation"
    | "yield_farming"
    | "liquidity_providing"
    | "whale_positioning"
    | "dormant";

  strategyScore: number;

  displayScore: string;

  confidence: "low" | "medium" | "high";

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  investorHeadline: string;

  investorSummary: string;

  investorTakeaway: string;

  supportingSignals: string[];

  conflictingSignals: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletConvictionSummary = {
  convictionLevel:
    | "very_low"
    | "low"
    | "medium"
    | "high"
    | "very_high";

  convictionScore: number;

  displayScore: string;

  confidence: "low" | "medium" | "high";

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  investorHeadline: string;

  investorSummary: string;

  investorTakeaway: string;

  supportingSignals: string[];

  conflictingSignals: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletAlphaSummary = {
  alphaScore: number;

  displayScore: string;

  alphaLevel:
    | "very_low"
    | "low"
    | "medium"
    | "high"
    | "elite";

  confidence:
    | "low"
    | "medium"
    | "high";

  evidenceConfidence:
    | "low"
    | "medium"
    | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  investorHeadline: string;

  investorSummary: string;

  investorTakeaway: string;

  strengths: string[];

  weaknesses: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletInvestmentStyleSummary = {
  style:
    | "long_term_investor"
    | "active_trader"
    | "swing_trader"
    | "momentum_trader"
    | "accumulator"
    | "defi_investor"
    | "yield_farmer"
    | "meme_coin_trader"
    | "whale_investor"
    | "passive_holder"
    | "diversified_investor"
    | "mixed";

  confidence:
    | "low"
    | "medium"
    | "high";

  evidenceConfidence:
    | "low"
    | "medium"
    | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  investorHeadline: string;

  investorSummary: string;

  investorTakeaway: string;

  styleDescription: string;

  supportingSignals: string[];

  conflictingSignals: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletProfitabilitySummary = {
  profitabilityScore: number;

  displayScore: string;

  profitabilityLevel:
    | "unknown"
    | "weak"
    | "limited"
    | "moderate"
    | "strong"
    | "very_strong";

  estimatedProfitability:
    | "unknown"
    | "unlikely"
    | "possible"
    | "likely";

  confidence:
    | "low"
    | "medium"
    | "high";

  evidenceConfidence:
    | "low"
    | "medium"
    | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  investorHeadline: string;

  investorSummary: string;

  investorTakeaway: string;

  positiveIndicators: string[];

  negativeIndicators: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletReputationSummary = {
  reputationScore: number;

  displayScore: string;

  reputationLevel:
    | "unknown"
    | "poor"
    | "limited"
    | "moderate"
    | "good"
    | "excellent";

  confidence: "low" | "medium" | "high";

  evidenceConfidence: "low" | "medium" | "high";

  confidenceAnalysis?: WalletConfidenceAnalysis;

  investorHeadline: string;

  investorSummary: string;

  investorTakeaway: string;

  strengths: string[];

  concerns: string[];

  limitations: string[];

  investorExplanation?: InvestorExplanation;

  investorInsights?: InvestorEvidenceCollection;
};

export type WalletSkunkScoreSummary = {
  score: number;

  displayScore: string;

  rating:
    | "poor"
    | "fair"
    | "good"
    | "very_good"
    | "excellent";

  stars: 1 | 2 | 3 | 4 | 5;

  recommendation: string;

  summary: string;
};

export type WalletNftSummary = {
  hasNfts: boolean;
  nftCount: number;
  items: Array<{
    mint: string;
    name: string | null;
    collection: string | null;
    imageUrl: string | null;
  }>;
  notes: string[];
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

// Mirrors ChainProtocol (protocols/registry.ts) and ProtocolAnalysis/
// ProtocolIntelligence (analyzers/protocols.ts, analyzers/protocolIntelligence.ts)
// structurally rather than importing them, matching this file's existing
// pattern for every other Wallet*Summary type - analyzers/registries
// already import SupportedChain from here, so importing back would be
// circular.
export type WalletProtocolMatch = {
  programId: string;
  protocol: {
    programId: string;
    name: string;
    category:
      | "dex"
      | "dex_aggregator"
      | "lending"
      | "staking"
      | "liquidity"
      | "bridge"
      | "nft"
      | "perpetuals"
      | "yield"
      | "launchpad"
      | "stablecoin"
      | "infrastructure"
      | "other";
    reputation: "high" | "medium" | "unknown";
    verified: boolean;
    custodial: boolean;
    deprecated: boolean;
    website?: string;
    notes?: string;
    tags: string[];
  };
  interactionCount: number;
  firstInteractionAt: string | null;
  lastInteractionAt: string | null;
};

export type WalletProtocolsSummary = {
  totalProtocols: number;
  verifiedProtocols: number;
  protocols: WalletProtocolMatch[];
};

export type WalletProtocolIntelligenceSummary = {
  primaryProtocol: string | null;
  primaryCategory: string | null;
  activeProtocols: number;
  protocolDiversity: "none" | "low" | "medium" | "high";
  dominantProtocolShare: number;
  investorProfile:
    | "Inactive"
    | "Basic User"
    | "DEX Trader"
    | "Multi-Protocol DeFi User";
  confidence: "low" | "medium" | "high";
};

// A fallback for wallets where the primary token-balances endpoint can't
// enumerate the full list (see the ETHEREUM_TOKEN_BALANCE_COUNT_EXCEEDS_
// PROVIDER_LIMIT warning). Deliberately NOT a holdings/balance shape -
// every field is lastSeen*-prefixed because this reflects a token's most
// recent transfer in the sampled transaction history, not its current
// balance. A token can appear here with a large recent inflow that has
// since been fully sent away, and a token the wallet currently holds a
// lot of can be absent if it hasn't been transferred recently. Never fed
// into portfolio/whale/risk analyzers - those consume tokenHoldings only.
export type WalletRecentTokenActivity = {
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  lastSeenAmount: number | null;
  lastSeenDirection: "send" | "receive" | "unknown";
  lastSeenAt: number | null;
  lastSeenTransactionId: string;
};

export type WalletInvestigationResult = {
  chain: SupportedChain;
  address: string;
  status: WalletInvestigationStatus;
  balance?: WalletBalance;
  tokenHoldings?: WalletTokenHolding[];
  portfolio?: WalletPortfolioSummary;
  nftHoldings?: UniversalNftHolding[];
  // Supplementary, not a replacement for tokenHoldings - only populated
  // when tokenHoldings is known-incomplete (see WalletRecentTokenActivity's
  // doc comment). Absent/empty otherwise.
  recentTokenActivity?: WalletRecentTokenActivity[];
  whale?: WalletWhaleSummary;
  defi?: WalletDeFiSummary;
  protocols?: WalletProtocolsSummary;
  protocolIntelligence?: WalletProtocolIntelligenceSummary;
  behavior?: WalletBehaviorSummary;
  caseSummary?: WalletCaseSummary;
  display?: WalletDisplaySummary;
  decision?: WalletDecisionSummary;
  executiveVerdict?: WalletExecutiveVerdict;
  assessment?: WalletAssessmentSummary;
  intelligenceBrief?: WalletIntelligenceBrief;
  custodyProfile?: WalletCustodyProfile;
  complianceScreening?: WalletComplianceScreeningSummary;
  intelligenceSources?: WalletIntelligenceSource[];
  trust?: WalletTrustSummary;
  investigationReplay?: WalletInvestigationReplayStep[];
  exposure?: WalletExposureSummary;
  relationships?: WalletRelationshipSummary;
  evidence?: WalletEvidenceItem[];
  evidenceRecords?: WalletEvidenceRecord[];
  recentTransactions?: WalletRecentTransaction[];
  transactionCountSample?: number;
  activity?: WalletActivitySummary;
  age?: WalletAgeSummary;
  funding?: WalletFundingSummary;
  risk?: WalletRiskSummary;
  transactionRisk?: WalletTransactionRiskSummary;
  smartMoney?: WalletSmartMoneySummary;
  strategy?: WalletStrategySummary;
  conviction?: WalletConvictionSummary;
  alpha?: WalletAlphaSummary;
  investmentStyle?: WalletInvestmentStyleSummary;
  profitability?: WalletProfitabilitySummary;
  reputation?: WalletReputationSummary;
  skunkScore?: WalletSkunkScoreSummary;
  investigationReport?: WalletInvestigationReport;
  investigationNarrative?: WalletInvestigationNarrative;
  summary: string;
  warnings: string[];
};
