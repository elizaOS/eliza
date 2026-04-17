/**
 * Shared wallet API contracts.
 */

export interface WalletKeys {
  evmPrivateKey: string;
  evmAddress: string;
  solanaPrivateKey: string;
  solanaAddress: string;
}

export interface WalletAddresses {
  evmAddress: string | null;
  solanaAddress: string | null;
}

export interface EvmTokenBalance {
  symbol: string;
  name: string;
  contractAddress: string;
  balance: string;
  decimals: number;
  valueUsd: string;
  logoUrl: string;
}

export interface EvmChainBalance {
  chain: string;
  chainId: number;
  nativeBalance: string;
  nativeSymbol: string;
  nativeValueUsd: string;
  tokens: EvmTokenBalance[];
  error: string | null;
}

export interface SolanaTokenBalance {
  symbol: string;
  name: string;
  mint: string;
  balance: string;
  decimals: number;
  valueUsd: string;
  logoUrl: string;
}

export interface WalletBalancesResponse {
  evm: { address: string; chains: EvmChainBalance[] } | null;
  solana: {
    address: string;
    solBalance: string;
    solValueUsd: string;
    tokens: SolanaTokenBalance[];
  } | null;
}

export interface EvmNft {
  contractAddress: string;
  tokenId: string;
  name: string;
  description: string;
  imageUrl: string;
  collectionName: string;
  tokenType: string;
}

export interface SolanaNft {
  mint: string;
  name: string;
  description: string;
  imageUrl: string;
  collectionName: string;
}

export interface WalletNftsResponse {
  evm: Array<{ chain: string; nfts: EvmNft[] }>;
  solana: { nfts: SolanaNft[] } | null;
}

export const WALLET_RPC_PROVIDER_OPTIONS = {
  evm: [
    { id: "eliza-cloud", label: "Eliza Cloud" },
    { id: "alchemy", label: "Alchemy" },
    { id: "infura", label: "Infura" },
    { id: "ankr", label: "Ankr" },
  ],
  bsc: [
    { id: "eliza-cloud", label: "Eliza Cloud" },
    { id: "alchemy", label: "Alchemy" },
    { id: "ankr", label: "Ankr" },
    { id: "nodereal", label: "NodeReal" },
    { id: "quicknode", label: "QuickNode" },
  ],
  solana: [
    { id: "eliza-cloud", label: "Eliza Cloud" },
    { id: "helius-birdeye", label: "Helius + Birdeye" },
  ],
} as const;

export type WalletRpcChain = keyof typeof WALLET_RPC_PROVIDER_OPTIONS;
export type EvmWalletRpcProvider =
  (typeof WALLET_RPC_PROVIDER_OPTIONS.evm)[number]["id"];
export type BscWalletRpcProvider =
  (typeof WALLET_RPC_PROVIDER_OPTIONS.bsc)[number]["id"];
export type SolanaWalletRpcProvider =
  (typeof WALLET_RPC_PROVIDER_OPTIONS.solana)[number]["id"];

export interface WalletRpcSelections {
  evm: EvmWalletRpcProvider;
  bsc: BscWalletRpcProvider;
  solana: SolanaWalletRpcProvider;
}

export const DEFAULT_WALLET_RPC_SELECTIONS: WalletRpcSelections = {
  evm: "eliza-cloud",
  bsc: "eliza-cloud",
  solana: "eliza-cloud",
};

const WALLET_RPC_PROVIDER_ALIASES = {
  elizacloud: "eliza-cloud",
  helius: "helius-birdeye",
} as const;

const WALLET_RPC_PROVIDER_IDS = {
  evm: new Set(WALLET_RPC_PROVIDER_OPTIONS.evm.map((option) => option.id)),
  bsc: new Set(WALLET_RPC_PROVIDER_OPTIONS.bsc.map((option) => option.id)),
  solana: new Set(
    WALLET_RPC_PROVIDER_OPTIONS.solana.map((option) => option.id),
  ),
} as const;

export function normalizeWalletRpcProviderId<TChain extends WalletRpcChain>(
  chain: TChain,
  value: string | null | undefined,
): WalletRpcSelections[TChain] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const normalized = WALLET_RPC_PROVIDER_ALIASES[
    trimmed as keyof typeof WALLET_RPC_PROVIDER_ALIASES
  ]
    ? WALLET_RPC_PROVIDER_ALIASES[
        trimmed as keyof typeof WALLET_RPC_PROVIDER_ALIASES
      ]
    : trimmed;
  if ((WALLET_RPC_PROVIDER_IDS[chain] as ReadonlySet<string>).has(normalized)) {
    return normalized as WalletRpcSelections[TChain];
  }
  return null;
}

export function normalizeWalletRpcSelections(
  input:
    | Partial<Record<WalletRpcChain, string | null | undefined>>
    | WalletRpcSelections
    | null
    | undefined,
): WalletRpcSelections {
  return {
    evm:
      normalizeWalletRpcProviderId("evm", input?.evm) ??
      DEFAULT_WALLET_RPC_SELECTIONS.evm,
    bsc:
      normalizeWalletRpcProviderId("bsc", input?.bsc) ??
      DEFAULT_WALLET_RPC_SELECTIONS.bsc,
    solana:
      normalizeWalletRpcProviderId("solana", input?.solana) ??
      DEFAULT_WALLET_RPC_SELECTIONS.solana,
  };
}

export type WalletRpcCredentialKey =
  | "ALCHEMY_API_KEY"
  | "INFURA_API_KEY"
  | "ANKR_API_KEY"
  | "NODEREAL_BSC_RPC_URL"
  | "QUICKNODE_BSC_RPC_URL"
  | "HELIUS_API_KEY"
  | "BIRDEYE_API_KEY"
  | "ETHEREUM_RPC_URL"
  | "BASE_RPC_URL"
  | "AVALANCHE_RPC_URL"
  | "BSC_RPC_URL"
  | "SOLANA_RPC_URL";

export interface WalletConfigUpdateRequest {
  selections: WalletRpcSelections;
  walletNetwork?: WalletNetworkMode;
  credentials?: Partial<Record<WalletRpcCredentialKey, string>>;
}

export type WalletNetworkMode = "mainnet" | "testnet";

export interface WalletConfigStatus {
  selectedRpcProviders: WalletRpcSelections;
  walletNetwork?: WalletNetworkMode;
  legacyCustomChains: WalletRpcChain[];
  alchemyKeySet: boolean;
  infuraKeySet: boolean;
  ankrKeySet: boolean;
  nodeRealBscRpcSet?: boolean;
  quickNodeBscRpcSet?: boolean;
  managedBscRpcReady?: boolean;
  cloudManagedAccess?: boolean;
  evmBalanceReady?: boolean;
  ethereumBalanceReady?: boolean;
  baseBalanceReady?: boolean;
  bscBalanceReady?: boolean;
  avalancheBalanceReady?: boolean;
  solanaBalanceReady?: boolean;
  tradePermissionMode?: TradePermissionMode;
  tradeUserCanLocalExecute?: boolean;
  tradeAgentCanLocalExecute?: boolean;
  heliusKeySet: boolean;
  birdeyeKeySet: boolean;
  evmChains: string[];
  evmAddress: string | null;
  solanaAddress: string | null;
  walletSource?: "local" | "managed" | "none";
  automationMode?: "full" | "connectors-only";
  pluginEvmLoaded?: boolean;
  pluginEvmRequired?: boolean;
  executionReady?: boolean;
  executionBlockedReason?: string | null;
  solanaSigningAvailable?: boolean;
  /** Present only when ENABLE_CLOUD_WALLET is on. */
  wallets?: WalletEntry[];
  /** Present only when ENABLE_CLOUD_WALLET is on. */
  primary?: WalletPrimaryMap;
}

export type WalletSource = "local" | "cloud";
export type WalletChainKind = "evm" | "solana";
export type WalletProviderKind = "local" | "privy" | "steward";

export interface WalletEntry {
  source: WalletSource;
  chain: WalletChainKind;
  address: string;
  provider: WalletProviderKind;
  primary: boolean;
}

export interface WalletPrimaryMap {
  evm: WalletSource;
  solana: WalletSource;
}

export interface WalletPrimaryUpdateRequest {
  chain: WalletChainKind;
  source: WalletSource;
}

export interface WalletPrimaryUpdateResponse {
  ok: boolean;
  chain: WalletChainKind;
  source: WalletSource;
  warnings?: string[];
}

export type TradePermissionMode =
  | "user-sign-only"
  | "manual-local-key"
  | "agent-auto";

export type BscTradeSide = "buy" | "sell";
export type BscTradeRouteProvider = "pancakeswap-v2" | "0x";
export type BscTradeRoutePreference = BscTradeRouteProvider | "auto";

export interface BscTradePreflightRequest {
  tokenAddress?: string;
}

export interface BscTradeReadinessChecks {
  walletReady: boolean;
  rpcReady: boolean;
  chainReady: boolean;
  gasReady: boolean;
  tokenAddressValid: boolean;
}

export interface BscTradePreflightResponse {
  ok: boolean;
  walletAddress: string | null;
  rpcUrlHost: string | null;
  chainId: number | null;
  bnbBalance: string | null;
  minGasBnb: string;
  checks: BscTradeReadinessChecks;
  reasons: string[];
}

export interface BscTradeQuoteRequest {
  side: BscTradeSide;
  tokenAddress: string;
  amount: string;
  slippageBps?: number;
  routeProvider?: BscTradeRoutePreference;
}

export interface BscTradeQuoteLeg {
  symbol: string;
  amount: string;
  amountWei: string;
}

export interface BscTradeQuoteResponse {
  ok: boolean;
  side: BscTradeSide;
  routeProvider: BscTradeRouteProvider;
  routeProviderRequested: BscTradeRoutePreference;
  routeProviderFallbackUsed: boolean;
  routeProviderNotes?: string[];
  routerAddress: string;
  wrappedNativeAddress: string;
  tokenAddress: string;
  slippageBps: number;
  route: string[];
  quoteIn: BscTradeQuoteLeg;
  quoteOut: BscTradeQuoteLeg;
  minReceive: BscTradeQuoteLeg;
  price: string;
  preflight: BscTradePreflightResponse;
  swapTargetAddress?: string;
  swapCallData?: string;
  swapValueWei?: string;
  allowanceTarget?: string;
  quotedAt?: number;
}

export interface BscTradeExecuteRequest {
  side: BscTradeSide;
  tokenAddress: string;
  amount: string;
  slippageBps?: number;
  routeProvider?: BscTradeRoutePreference;
  confirm?: boolean;
  deadlineSeconds?: number;
}

export interface BscUnsignedTradeTx {
  chainId: number;
  from: string | null;
  to: string;
  data: string;
  valueWei: string;
  deadline: number;
  explorerUrl: string;
}

export interface BscUnsignedApprovalTx {
  chainId: number;
  from: string | null;
  to: string;
  data: string;
  valueWei: string;
  explorerUrl: string;
  spender: string;
  amountWei: string;
}

export interface BscTradeExecutionResult {
  hash: string;
  nonce: number;
  gasLimit: string;
  valueWei: string;
  explorerUrl: string;
  blockNumber: number | null;
  status: "success" | "pending";
  approvalHash?: string;
}

export type BscTradeTxStatus = "pending" | "success" | "reverted" | "not_found";

export interface BscTradeTxStatusResponse {
  ok: boolean;
  hash: string;
  status: BscTradeTxStatus;
  explorerUrl: string;
  chainId: number | null;
  blockNumber: number | null;
  confirmations: number;
  nonce: number | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  reason?: string;
}

export type WalletTradeSource = "agent" | "manual";

export type WalletTradingProfileWindow = "7d" | "30d" | "all";

export type WalletTradingProfileSourceFilter = "all" | WalletTradeSource;

export interface WalletTradeLedgerQuoteLeg {
  symbol: string;
  amount: string;
  amountWei: string;
}

export interface WalletTradeLedgerEntry {
  hash: string;
  createdAt: string;
  updatedAt: string;
  source: WalletTradeSource;
  side: BscTradeSide;
  tokenAddress: string;
  slippageBps: number;
  route: string[];
  quoteIn: WalletTradeLedgerQuoteLeg;
  quoteOut: WalletTradeLedgerQuoteLeg;
  status: BscTradeTxStatus;
  confirmations: number;
  nonce: number | null;
  blockNumber: number | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  reason?: string;
  explorerUrl: string;
}

export interface WalletTradingProfileSummary {
  totalSwaps: number;
  buyCount: number;
  sellCount: number;
  settledCount: number;
  successCount: number;
  revertedCount: number;
  tradeWinRate: number | null;
  txSuccessRate: number | null;
  winningTrades: number;
  evaluatedTrades: number;
  realizedPnlBnb: string;
  volumeBnb: string;
}

export interface WalletTradingProfileSeriesPoint {
  day: string;
  realizedPnlBnb: string;
  volumeBnb: string;
  swaps: number;
}

export interface WalletTradingProfileTokenBreakdown {
  tokenAddress: string;
  symbol: string;
  buyCount: number;
  sellCount: number;
  realizedPnlBnb: string;
  volumeBnb: string;
  tradeWinRate: number | null;
  winningTrades: number;
  evaluatedTrades: number;
}

export interface WalletTradingProfileRecentSwap {
  hash: string;
  createdAt: string;
  source: WalletTradeSource;
  side: BscTradeSide;
  status: BscTradeTxStatus;
  tokenAddress: string;
  tokenSymbol: string;
  inputAmount: string;
  inputSymbol: string;
  outputAmount: string;
  outputSymbol: string;
  explorerUrl: string;
  confirmations: number;
  reason?: string;
}

export interface WalletTradingProfileResponse {
  window: WalletTradingProfileWindow;
  source: WalletTradingProfileSourceFilter;
  generatedAt: string;
  summary: WalletTradingProfileSummary;
  pnlSeries: WalletTradingProfileSeriesPoint[];
  tokenBreakdown: WalletTradingProfileTokenBreakdown[];
  recentSwaps: WalletTradingProfileRecentSwap[];
}

/** Result from a Steward policy evaluation. */
export interface StewardPolicyResult {
  policyId?: string;
  name?: string;
  status: "approved" | "rejected" | "pending";
  reason?: string;
}

/** Steward pending-approval or rejection info attached to a tx step. */
export interface StewardApprovalInfo {
  status: "pending_approval" | "rejected";
  policyResults?: StewardPolicyResult[];
}

/** Response from GET /api/wallet/steward-addresses. */
export interface StewardWalletAddressesResponse {
  evmAddress: string | null;
  solanaAddress: string | null;
}

/** Response from GET /api/wallet/steward-balances. */
export interface StewardBalanceResponse {
  balance: string;
  formatted: string;
  symbol: string;
  chainId: number;
}

/** Response from GET /api/wallet/steward-tokens. */
export interface StewardTokenBalancesResponse {
  native: StewardBalanceResponse;
  tokens: Array<{
    address: string;
    symbol: string;
    name: string;
    balance: string;
    formatted: string;
    decimals: number;
    valueUsd?: string;
    logoUrl?: string;
  }>;
}

export type StewardWebhookEventType =
  | "tx.pending"
  | "tx.approved"
  | "tx.denied"
  | "tx.confirmed";

/** Event entry from GET /api/wallet/steward-webhook-events. */
export interface StewardWebhookEvent {
  event: StewardWebhookEventType;
  data: Record<string, unknown>;
  timestamp?: string;
}

/** Response from GET /api/wallet/steward-webhook-events. */
export interface StewardWebhookEventsResponse {
  events: StewardWebhookEvent[];
  nextIndex: number;
}

export interface BscTradeExecuteResponse {
  ok: boolean;
  side: BscTradeSide;
  mode: "local-key" | "user-sign" | "steward";
  quote: BscTradeQuoteResponse;
  executed: boolean;
  requiresUserSignature: boolean;
  unsignedTx: BscUnsignedTradeTx;
  unsignedApprovalTx?: BscUnsignedApprovalTx;
  requiresApproval?: boolean;
  execution?: Omit<BscTradeExecutionResult, "status"> & {
    status?:
      | BscTradeExecutionResult["status"]
      | "pending_approval"
      | "rejected";
    policyResults?: StewardPolicyResult[];
  };
  /** Present when the approval tx is pending Steward policy review. */
  approval?: StewardApprovalInfo;
  /** Steward error message on policy rejection (403). */
  error?: string;
}

export interface BscTransferExecuteRequest {
  toAddress: string;
  amount: string;
  assetSymbol: string;
  tokenAddress?: string;
  confirm?: boolean;
}

export interface BscUnsignedTransferTx {
  chainId: number;
  from: string | null;
  to: string;
  data: string;
  valueWei: string;
  explorerUrl: string;
  assetSymbol: string;
  amount: string;
  tokenAddress?: string;
}

export interface BscTransferExecutionResult {
  hash: string;
  nonce: number;
  gasLimit: string;
  valueWei: string;
  explorerUrl: string;
  blockNumber: number | null;
  status: "success" | "pending";
}

export interface BscTransferExecuteResponse {
  ok: boolean;
  mode: "local-key" | "user-sign" | "steward";
  executed: boolean;
  requiresUserSignature: boolean;
  toAddress: string;
  amount: string;
  assetSymbol: string;
  tokenAddress?: string;
  unsignedTx: BscUnsignedTransferTx;
  execution?: Omit<BscTransferExecutionResult, "status"> & {
    status?:
      | BscTransferExecutionResult["status"]
      | "pending_approval"
      | "rejected";
    policyResults?: StewardPolicyResult[];
  };
  /** Steward error message on policy rejection (403). */
  error?: string;
}

export type WalletChain = "evm" | "solana";

export interface KeyValidationResult {
  valid: boolean;
  chain: WalletChain;
  address: string | null;
  error: string | null;
}

export interface WalletImportResult {
  success: boolean;
  chain: WalletChain;
  address: string | null;
  error: string | null;
}

export interface WalletGenerateResult {
  chain: WalletChain;
  address: string;
  privateKey: string;
}

// ── Wallet Export ──────────────────────────────────────────────────────────

/** Request body for wallet private key export endpoints. */
export interface WalletExportRequestBody {
  confirm?: boolean;
  exportToken?: string;
}

/** Rejection returned by the wallet export guard. */
export interface WalletExportRejection {
  status: 400 | 401 | 402 | 403 | 429;
  reason: string;
}

// ── Wallet Trade Ledger ───────────────────────────────────────────────────

/** Input for recording a trade in the wallet trading profile ledger. */
export interface WalletTradeLedgerRecordInput {
  hash: string;
  source: WalletTradeSource;
  side: BscTradeSide;
  tokenAddress: string;
  slippageBps: number;
  route: string[];
  quoteIn: WalletTradeLedgerQuoteLeg;
  quoteOut: WalletTradeLedgerQuoteLeg;
  status: BscTradeTxStatus;
  confirmations: number;
  nonce: number | null;
  blockNumber: number | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  reason?: string;
  explorerUrl: string;
  createdAt?: string;
  updatedAt?: string;
}
