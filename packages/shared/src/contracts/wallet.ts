/**
 * Shared wallet API contracts.
 */

export interface WalletKeys {
  evmPrivateKey: string;
  evmAddress: string;
  solanaPrivateKey: string;
  solanaAddress: string;
}

export interface WalletAddressPair {
  evmAddress: string | null;
  solanaAddress: string | null;
}

export interface WalletAddresses extends WalletAddressPair {}

export interface WalletTokenBalanceBase {
  symbol: string;
  name: string;
  balance: string;
  decimals: number;
  valueUsd: string;
  logoUrl: string;
}

export interface WalletNftMetadataBase {
  name: string;
  description: string;
  imageUrl: string;
  collectionName: string;
}

export interface EvmTokenBalance extends WalletTokenBalanceBase {
  contractAddress: string;
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

export interface SolanaTokenBalance extends WalletTokenBalanceBase {
  mint: string;
}

export interface WalletEvmBalances {
  address: string;
  chains: EvmChainBalance[];
}

export interface WalletSolanaBalances {
  address: string;
  solBalance: string;
  solValueUsd: string;
  tokens: SolanaTokenBalance[];
}

export interface WalletBalancesResponse {
  evm: WalletEvmBalances | null;
  solana: WalletSolanaBalances | null;
}

export interface EvmNft extends WalletNftMetadataBase {
  contractAddress: string;
  tokenId: string;
  tokenType: string;
}

export interface SolanaNft extends WalletNftMetadataBase {
  mint: string;
}

export interface WalletEvmNftCollection {
  chain: string;
  nfts: EvmNft[];
}

export interface WalletSolanaNftCollection {
  nfts: SolanaNft[];
}

export interface WalletNftsResponse {
  evm: WalletEvmNftCollection[];
  solana: WalletSolanaNftCollection | null;
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

const WALLET_RPC_PROVIDER_CREDENTIAL_KEYS: Record<
  WalletRpcChain,
  Record<string, WalletRpcCredentialKey[]>
> = {
  evm: {
    "eliza-cloud": [],
    alchemy: ["ALCHEMY_API_KEY"],
    infura: ["INFURA_API_KEY"],
    ankr: ["ANKR_API_KEY"],
  },
  bsc: {
    "eliza-cloud": [],
    alchemy: ["ALCHEMY_API_KEY"],
    ankr: ["ANKR_API_KEY"],
    nodereal: ["NODEREAL_BSC_RPC_URL"],
    quicknode: ["QUICKNODE_BSC_RPC_URL"],
  },
  solana: {
    "eliza-cloud": [],
    "helius-birdeye": ["HELIUS_API_KEY", "BIRDEYE_API_KEY"],
  },
};

const LEGACY_CUSTOM_WALLET_RPC_CHAIN_KEYS: Record<
  WalletRpcChain,
  WalletRpcCredentialKey[]
> = {
  evm: ["ETHEREUM_RPC_URL", "BASE_RPC_URL", "AVALANCHE_RPC_URL"],
  bsc: ["BSC_RPC_URL"],
  solana: ["SOLANA_RPC_URL"],
};

function isWalletConfigCredentialSet(
  walletConfig: WalletConfigStatus | null | undefined,
  configKey: WalletRpcCredentialKey,
): boolean {
  switch (configKey) {
    case "ALCHEMY_API_KEY":
      return Boolean(walletConfig?.alchemyKeySet);
    case "INFURA_API_KEY":
      return Boolean(walletConfig?.infuraKeySet);
    case "ANKR_API_KEY":
      return Boolean(walletConfig?.ankrKeySet);
    case "NODEREAL_BSC_RPC_URL":
      return Boolean(walletConfig?.nodeRealBscRpcSet);
    case "QUICKNODE_BSC_RPC_URL":
      return Boolean(walletConfig?.quickNodeBscRpcSet);
    case "HELIUS_API_KEY":
      return Boolean(walletConfig?.heliusKeySet);
    case "BIRDEYE_API_KEY":
      return Boolean(walletConfig?.birdeyeKeySet);
    case "SOLANA_RPC_URL":
      return Boolean(walletConfig?.legacyCustomChains?.includes("solana"));
    case "BSC_RPC_URL":
      return Boolean(walletConfig?.legacyCustomChains?.includes("bsc"));
    case "ETHEREUM_RPC_URL":
    case "BASE_RPC_URL":
    case "AVALANCHE_RPC_URL":
      return Boolean(walletConfig?.legacyCustomChains?.includes("evm"));
    default:
      return false;
  }
}

export function resolveInitialWalletRpcSelections(
  walletConfig: WalletConfigStatus | null | undefined,
): WalletRpcSelections {
  if (walletConfig?.selectedRpcProviders) {
    return normalizeWalletRpcSelections(walletConfig.selectedRpcProviders);
  }
  return {
    evm: walletConfig?.alchemyKeySet
      ? "alchemy"
      : walletConfig?.infuraKeySet
        ? "infura"
        : walletConfig?.ankrKeySet
          ? "ankr"
          : DEFAULT_WALLET_RPC_SELECTIONS.evm,
    bsc: walletConfig?.nodeRealBscRpcSet
      ? "nodereal"
      : walletConfig?.quickNodeBscRpcSet
        ? "quicknode"
        : walletConfig?.alchemyKeySet
          ? "alchemy"
          : walletConfig?.ankrKeySet
            ? "ankr"
            : DEFAULT_WALLET_RPC_SELECTIONS.bsc,
    solana:
      walletConfig?.heliusKeySet || walletConfig?.birdeyeKeySet
        ? "helius-birdeye"
        : DEFAULT_WALLET_RPC_SELECTIONS.solana,
  };
}

function collectSelectedWalletRpcCredentialKeys(
  selectedProviders: WalletRpcSelections,
): Set<WalletRpcCredentialKey> {
  const selectedKeys = new Set<WalletRpcCredentialKey>();
  for (const chain of Object.keys(selectedProviders) as WalletRpcChain[]) {
    const provider = selectedProviders[chain];
    for (const key of WALLET_RPC_PROVIDER_CREDENTIAL_KEYS[chain][provider] ??
      []) {
      selectedKeys.add(key);
    }
  }
  return selectedKeys;
}

export function buildWalletRpcUpdateRequest(args: {
  walletConfig?: WalletConfigStatus | null;
  rpcFieldValues: Partial<Record<WalletRpcCredentialKey, string>>;
  selectedProviders:
    | WalletRpcSelections
    | Partial<Record<WalletRpcChain, string | null | undefined>>;
  selectedNetwork?: "mainnet" | "testnet";
}): WalletConfigUpdateRequest {
  const { walletConfig, rpcFieldValues, selectedProviders, selectedNetwork } =
    args;
  const credentials: Partial<Record<WalletRpcCredentialKey, string>> = {};
  const normalizedSelections = normalizeWalletRpcSelections(selectedProviders);
  const selectedKeys =
    collectSelectedWalletRpcCredentialKeys(normalizedSelections);

  for (const key of selectedKeys) {
    const value = rpcFieldValues[key]?.trim();
    if (value) {
      credentials[key] = value;
    }
  }

  const allKnownKeys = new Set<WalletRpcCredentialKey>([
    "ALCHEMY_API_KEY",
    "INFURA_API_KEY",
    "ANKR_API_KEY",
    "NODEREAL_BSC_RPC_URL",
    "QUICKNODE_BSC_RPC_URL",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
  ]);

  for (const chain of Object.keys(
    LEGACY_CUSTOM_WALLET_RPC_CHAIN_KEYS,
  ) as WalletRpcChain[]) {
    if (walletConfig?.legacyCustomChains?.includes(chain)) {
      for (const key of LEGACY_CUSTOM_WALLET_RPC_CHAIN_KEYS[chain]) {
        credentials[key] = "";
        allKnownKeys.add(key);
      }
    }
  }

  for (const key of allKnownKeys) {
    if (selectedKeys.has(key)) {
      continue;
    }
    if (
      isWalletConfigCredentialSet(walletConfig, key) ||
      rpcFieldValues[key] !== undefined
    ) {
      credentials[key] = "";
    }
  }

  return {
    selections: normalizedSelections,
    walletNetwork:
      selectedNetwork ??
      (walletConfig?.walletNetwork === "testnet" ? "testnet" : "mainnet"),
    credentials,
  };
}

export type WalletNetworkMode = "mainnet" | "testnet";

/**
 * Paths through which plugin-wallet can produce a signature.
 *
 * - "local":             EVM_PRIVATE_KEY env var (non-placeholder)
 * - "steward-self":      self-hosted Steward vault
 * - "steward-cloud":     cloud-provisioned Steward sidecar
 * - "cloud-view-only":   cloud-custodied address known, but no signing path
 *                        is wired in this runtime — view-only
 * - "none":              no signer, no address
 *
 * Source of truth: packages/agent/src/services/evm-signing-capability.ts.
 */
export type EvmSigningCapabilityKind =
  | "local"
  | "steward-self"
  | "steward-cloud"
  | "cloud-view-only"
  | "none";

export interface WalletConfigStatus extends WalletAddressPair {
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
  walletSource?: "local" | "managed" | "none";
  automationMode?: "full" | "connectors-only";
  pluginEvmLoaded?: boolean;
  pluginEvmRequired?: boolean;
  executionReady?: boolean;
  executionBlockedReason?: string | null;
  evmSigningCapability?: EvmSigningCapabilityKind;
  evmSigningReason?: string;
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

export type WalletTradingProfileWindow = "24h" | "7d" | "30d" | "all";

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

export interface WalletMarketPriceSnapshot {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  imageUrl: string | null;
}

export interface WalletMarketMover {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

export interface WalletMarketPrediction {
  id: string;
  slug: string | null;
  question: string;
  highlightedOutcomeLabel: string;
  highlightedOutcomeProbability: number | null;
  volume24hUsd: number;
  totalVolumeUsd: number | null;
  endsAt: string | null;
  imageUrl: string | null;
}

export type WalletMarketOverviewProviderId = "coingecko" | "polymarket";

export interface WalletMarketOverviewSource {
  providerId: WalletMarketOverviewProviderId;
  providerName: string;
  providerUrl: string;
  available: boolean;
  stale: boolean;
  error: string | null;
}

export interface WalletMarketOverviewResponse {
  generatedAt: string;
  cacheTtlSeconds: number;
  stale: boolean;
  sources: {
    prices: WalletMarketOverviewSource;
    movers: WalletMarketOverviewSource;
    predictions: WalletMarketOverviewSource;
  };
  prices: WalletMarketPriceSnapshot[];
  movers: WalletMarketMover[];
  predictions: WalletMarketPrediction[];
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
export interface StewardWalletAddressesResponse extends WalletAddressPair {}

/** Response from GET /api/wallet/steward-balances. */
export interface StewardBalanceResponse {
  balance: string;
  formatted: string;
  symbol: string;
  chainId: number;
}

export interface StewardTokenBalance {
  address: string;
  symbol: string;
  name: string;
  balance: string;
  formatted: string;
  decimals: number;
  valueUsd?: string;
  logoUrl?: string;
}

/** Response from GET /api/wallet/steward-tokens. */
export interface StewardTokenBalancesResponse {
  native: StewardBalanceResponse;
  tokens: StewardTokenBalance[];
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
