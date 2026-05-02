// @stwd/shared — types, constants, utils

export type { PriceOracle } from "./price-oracle.js";
export { createPriceOracle } from "./price-oracle.js";
// ─── Token Registry & Price Oracle ───
export * from "./tokens.js";

// ─── Tenancy ───

export interface Tenant {
  id: string;
  name: string;
  apiKeyHash: string;
  createdAt: Date;
}

export interface TenantConfig {
  id: string;
  name: string;
  webhookUrl?: string;
  defaultPolicies?: PolicyRule[];
}

export type WebhookEventType =
  | "tx.pending"
  | "tx.approved"
  | "tx.denied"
  | "tx.signed"
  | "spend.threshold"
  | "policy.violation"
  // Legacy event types (kept for backwards compat)
  | "approval_required"
  | "tx_signed"
  | "tx_confirmed"
  | "tx_failed"
  | "tx_rejected";

export interface WebhookEvent {
  type: WebhookEventType;
  tenantId: string;
  agentId: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export interface WebhookConfigRecord {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  enabled: boolean;
  maxRetries: number;
  retryBackoffMs: number;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutoApprovalRuleRecord {
  id: string;
  tenantId: string;
  maxAmountWei: string;
  autoDenyAfterHours: number | null;
  escalateAboveWei: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Chain Family ───

/** Identifies the blockchain family for a wallet key/address. */
export type ChainFamily = "evm" | "solana";

// ─── Agent Identity ───

export interface AgentIdentity {
  id: string;
  tenantId: string;
  name: string;
  /** Primary EVM address — kept for backwards compatibility. */
  walletAddress: string;
  /**
   * All addresses for this agent, keyed by chain family.
   * Present for agents created with multi-wallet support.
   */
  walletAddresses?: { evm?: string; solana?: string };
  erc8004TokenId?: string;
  platformId?: string; // e.g. waifu.fun agent ID
  createdAt: Date;
}

// ─── CAIP-2 Chain Identifiers ───

/**
 * A chain identifier following the CAIP-2 standard.
 * See https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
 */
export interface ChainIdentifier {
  caip2: string;
  numericId: number;
  family: "evm" | "solana";
  name: string;
  symbol: string;
  testnet: boolean;
}

/**
 * Registry of all supported chains, keyed by CAIP-2 identifier.
 *
 * CAIP-2 format:
 *   EVM:    `eip155:{chainId}`
 *   Solana: `solana:{genesisHashPrefix}`
 *
 * Solana convention IDs used internally: 101 = mainnet-beta, 102 = devnet.
 */
export const CHAINS: Record<string, ChainIdentifier> = {
  "eip155:1": {
    caip2: "eip155:1",
    numericId: 1,
    family: "evm",
    name: "Ethereum",
    symbol: "ETH",
    testnet: false,
  },
  "eip155:56": {
    caip2: "eip155:56",
    numericId: 56,
    family: "evm",
    name: "BSC",
    symbol: "BNB",
    testnet: false,
  },
  "eip155:97": {
    caip2: "eip155:97",
    numericId: 97,
    family: "evm",
    name: "BSC Testnet",
    symbol: "tBNB",
    testnet: true,
  },
  "eip155:137": {
    caip2: "eip155:137",
    numericId: 137,
    family: "evm",
    name: "Polygon",
    symbol: "POL",
    testnet: false,
  },
  "eip155:8453": {
    caip2: "eip155:8453",
    numericId: 8453,
    family: "evm",
    name: "Base",
    symbol: "ETH",
    testnet: false,
  },
  "eip155:42161": {
    caip2: "eip155:42161",
    numericId: 42161,
    family: "evm",
    name: "Arbitrum",
    symbol: "ETH",
    testnet: false,
  },
  "eip155:84532": {
    caip2: "eip155:84532",
    numericId: 84532,
    family: "evm",
    name: "Base Sepolia",
    symbol: "ETH",
    testnet: true,
  },
  // Solana: genesis hash prefix used as the reference identifier
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    numericId: 101,
    family: "solana",
    name: "Solana",
    symbol: "SOL",
    testnet: false,
  },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    numericId: 102,
    family: "solana",
    name: "Solana Devnet",
    symbol: "SOL",
    testnet: true,
  },
};

/** Look up a chain by its internal numeric ID. Returns undefined if not found. */
export function chainFromNumeric(id: number): ChainIdentifier | undefined {
  return Object.values(CHAINS).find((c) => c.numericId === id);
}

/** Look up a chain by its CAIP-2 string (e.g. `"eip155:8453"`). Returns undefined if not found. */
export function chainFromCaip2(caip2: string): ChainIdentifier | undefined {
  return CHAINS[caip2];
}

/**
 * Convert an internal numeric chain ID to its CAIP-2 string.
 * Returns undefined for unrecognised chain IDs.
 */
export function toCaip2(numericId: number): string | undefined {
  return chainFromNumeric(numericId)?.caip2;
}

/**
 * Convert a CAIP-2 string back to the internal numeric chain ID.
 * Returns undefined for unrecognised CAIP-2 strings.
 */
export function fromCaip2(caip2: string): number | undefined {
  return CHAINS[caip2]?.numericId;
}

// ─── Policies ───

export type PolicyType =
  | "spending-limit"
  | "approved-addresses"
  | "auto-approve-threshold"
  | "time-window"
  | "rate-limit"
  | "allowed-chains"
  | "reputation-threshold"
  | "reputation-scaling";

export interface PolicyRule {
  id: string;
  type: PolicyType;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SpendingLimitConfig {
  // Wei-based (legacy/direct)
  maxPerTx?: string;
  maxPerDay?: string;
  maxPerWeek?: string;
  // USD-based (preferred — takes precedence when price oracle is available)
  maxPerTxUsd?: number;
  maxPerDayUsd?: number;
  maxPerWeekUsd?: number;
}

export interface ApprovedAddressesConfig {
  addresses: string[];
  mode: "whitelist" | "blacklist";
}

export interface AutoApproveConfig {
  threshold?: string; // wei — below this, auto-approve (legacy)
  thresholdUsd?: number; // USD — below this, auto-approve (preferred)
}

export interface TimeWindowConfig {
  allowedHours: { start: number; end: number }[]; // UTC hours
  allowedDays: number[]; // 0=Sun, 6=Sat
}

export interface RateLimitConfig {
  maxTxPerHour: number;
  maxTxPerDay: number;
}

export interface AllowedChainsConfig {
  /** Array of CAIP-2 chain identifiers that are permitted. e.g. ["eip155:8453", "eip155:1"] */
  chains: string[];
}

// ─── Transactions ───

export type TxStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "failed";

export interface SignRequest {
  agentId: string;
  tenantId: string;
  to: string;
  value: string; // wei
  data?: string; // calldata
  chainId: number;
  nonce?: number;
  gasLimit?: string;
  broadcast?: boolean; // default true — set false to return signed tx without broadcasting
}

/**
 * EIP-712 typed data signing request (`eth_signTypedData_v4`).
 */
export interface SignTypedDataRequest {
  agentId: string;
  tenantId: string;
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  value: Record<string, unknown>;
}

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

export interface TypedDataField {
  name: string;
  type: string;
}

/**
 * Solana transaction signing request.
 */
export interface SignSolanaTransactionRequest {
  agentId: string;
  tenantId: string;
  transaction: string; // base64-encoded serialized transaction
  chainId?: number; // 101 = mainnet, 102 = devnet
  broadcast?: boolean; // default true
}

/**
 * Generic RPC passthrough request for read-only operations.
 */
export interface RpcRequest {
  method: string;
  params?: unknown[];
  chainId: number;
}

export interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface TxRecord {
  id: string;
  agentId: string;
  status: TxStatus;
  request: SignRequest;
  txHash?: string;
  policyResults: PolicyResult[];
  createdAt: Date;
  signedAt?: Date;
  confirmedAt?: Date;
}

export interface PolicyResult {
  policyId: string;
  type: PolicyType;
  passed: boolean;
  reason?: string;
}

// ─── API Responses ───

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ─── Balance ───

export interface AgentBalance {
  agentId: string;
  walletAddress: string;
  balances: {
    native: string; // wei as string
    nativeFormatted: string; // human-readable (e.g. "0.005")
    chainId: number;
    symbol: string; // e.g. "ETH", "BNB"
  };
}

// ─── Control Plane Types ───

export type PolicyExposure = "visible" | "hidden" | "enforced";

export type PolicyExposureConfig = Partial<Record<PolicyType, PolicyExposure>>;

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  policies: PolicyRule[];
  customizableFields: CustomizableField[];
}

export interface CustomizableField {
  path: string;
  label: string;
  description: string;
  type: "currency" | "number" | "toggle" | "address-list" | "chain-select";
  default: unknown;
  min?: unknown;
  max?: unknown;
}

export interface SecretRoutePreset {
  id: string;
  name: string;
  hostPattern: string;
  pathPattern: string;
  injectAs: "header" | "query" | "bearer";
  injectKey: string;
  injectFormat: string;
  provisioning: "platform" | "user";
  platformSecretId?: string;
}

export interface ApprovalConfig {
  notificationChannels?: ApprovalNotificationChannel[];
  autoExpireSeconds?: number;
  approvers?: ApproverConfig;
  approvalWebhookUrl?: string;
  webhookCallbackEnabled?: boolean;
}

export interface ApprovalNotificationChannel {
  type: "webhook" | "email" | "in-app";
  config: Record<string, string>;
}

export interface ApproverConfig {
  mode: "owner" | "tenant-admin" | "list";
  allowedApprovers?: string[];
}

export interface TenantFeatureFlags {
  showFundingQR?: boolean;
  showTransactionHistory?: boolean;
  showSpendDashboard?: boolean;
  showPolicyControls?: boolean;
  showApprovalQueue?: boolean;
  showSecretManager?: boolean;
  enableSolana?: boolean;
  showChainSelector?: boolean;
  allowAddressExport?: boolean;
}

export interface TenantTheme {
  primaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  surfaceColor?: string;
  textColor?: string;
  mutedColor?: string;
  successColor?: string;
  errorColor?: string;
  warningColor?: string;
  borderRadius?: number;
  fontFamily?: string;
  colorScheme?: "light" | "dark" | "system";
}

export interface TenantControlPlaneConfig {
  tenantId: string;
  displayName?: string;
  policyExposure: PolicyExposureConfig;
  policyTemplates: PolicyTemplate[];
  secretRoutePresets: SecretRoutePreset[];
  approvalConfig: ApprovalConfig;
  featureFlags: TenantFeatureFlags;
  theme?: TenantTheme;
  /** Allowed CORS origins for this tenant. Empty array = wildcard (*) in dev mode. */
  allowedOrigins?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export const DEFAULT_FEATURE_FLAGS: TenantFeatureFlags = {
  showFundingQR: true,
  showTransactionHistory: true,
  showSpendDashboard: true,
  showPolicyControls: true,
  showApprovalQueue: true,
  showSecretManager: false,
  enableSolana: true,
  showChainSelector: false,
  allowAddressExport: true,
};

/** Aggregated dashboard response for a single agent */
export interface AgentDashboardResponse {
  agent: AgentIdentity;
  balances: {
    evm?: {
      native: string;
      nativeFormatted: string;
      chainId: number;
      symbol: string;
    };
    solana?: {
      native: string;
      nativeFormatted: string;
      chainId: number;
      symbol: string;
    };
  };
  spend: {
    today: string;
    thisWeek: string;
    thisMonth: string;
    todayFormatted: string;
    thisWeekFormatted: string;
    thisMonthFormatted: string;
  };
  policies: PolicyRule[];
  pendingApprovals: number;
  recentTransactions: TxRecord[];
}

// ─── Constants ───

export const SUPPORTED_CHAINS = {
  ethereum: 1,
  bsc: 56,
  bscTestnet: 97,
  polygon: 137,
  base: 8453,
  arbitrum: 42161,
  baseSepolia: 84532,
  // Solana — convention IDs (not EVM chainIds)
  solana: 101,
  solanaDevnet: 102,
} as const;

export const DEFAULT_CHAIN_ID = SUPPORTED_CHAINS.base;

// ─── Chain Metadata ───

export interface ChainMeta {
  id: number;
  name: string;
  symbol: string;
  explorerUrl: string;
  explorerTxUrl: string; // append tx hash to this
}

export const CHAIN_META: Record<number, ChainMeta> = {
  1: {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    explorerUrl: "https://etherscan.io",
    explorerTxUrl: "https://etherscan.io/tx/",
  },
  56: {
    id: 56,
    name: "BSC",
    symbol: "BNB",
    explorerUrl: "https://bscscan.com",
    explorerTxUrl: "https://bscscan.com/tx/",
  },
  97: {
    id: 97,
    name: "BSC Testnet",
    symbol: "tBNB",
    explorerUrl: "https://testnet.bscscan.com",
    explorerTxUrl: "https://testnet.bscscan.com/tx/",
  },
  137: {
    id: 137,
    name: "Polygon",
    symbol: "POL",
    explorerUrl: "https://polygonscan.com",
    explorerTxUrl: "https://polygonscan.com/tx/",
  },
  8453: {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    explorerUrl: "https://basescan.org",
    explorerTxUrl: "https://basescan.org/tx/",
  },
  42161: {
    id: 42161,
    name: "Arbitrum",
    symbol: "ETH",
    explorerUrl: "https://arbiscan.io",
    explorerTxUrl: "https://arbiscan.io/tx/",
  },
  84532: {
    id: 84532,
    name: "Base Sepolia",
    symbol: "ETH",
    explorerUrl: "https://sepolia.basescan.org",
    explorerTxUrl: "https://sepolia.basescan.org/tx/",
  },
  // Solana
  101: {
    id: 101,
    name: "Solana",
    symbol: "SOL",
    explorerUrl: "https://explorer.solana.com",
    explorerTxUrl: "https://explorer.solana.com/tx/",
  },
  102: {
    id: 102,
    name: "Solana Devnet",
    symbol: "SOL",
    explorerUrl: "https://explorer.solana.com?cluster=devnet",
    explorerTxUrl: "https://explorer.solana.com/tx/",
  },
};

export function getChainMeta(chainId: number): ChainMeta | undefined {
  return CHAIN_META[chainId];
}

export function getExplorerTxLink(chainId: number, txHash: string): string | undefined {
  const meta = CHAIN_META[chainId];
  return meta ? `${meta.explorerTxUrl}${txHash}` : undefined;
}
