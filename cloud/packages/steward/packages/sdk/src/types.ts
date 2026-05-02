// Standalone type definitions for the published SDK
// These mirror @stwd/shared but are bundled here for npm distribution

/** Identifies the blockchain family for a wallet key/address. */
export type ChainFamily = "evm" | "solana";

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
  platformId?: string;
  createdAt: Date;
}

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

export interface PolicyResult {
  policyId: string;
  type: PolicyType;
  passed: boolean;
  reason?: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AgentBalance {
  agentId: string;
  walletAddress: string;
  balances: {
    native: string;
    nativeFormatted: string;
    chainId: number;
    symbol: string;
  };
}

export interface SpendingLimitConfig {
  maxPerTx: string;
  maxPerDay: string;
  maxPerWeek: string;
}

export interface ApprovedAddressesConfig {
  addresses: string[];
  mode: "whitelist" | "blacklist";
}

export interface AutoApproveConfig {
  threshold: string;
}

export interface TimeWindowConfig {
  allowedHours: { start: number; end: number }[];
  allowedDays: number[];
}

export interface RateLimitConfig {
  maxTxPerHour: number;
  maxTxPerDay: number;
}

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
  value: string;
  data?: string;
  chainId: number;
  nonce?: number;
  gasLimit?: string;
  broadcast?: boolean;
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

export interface SignTypedDataRequest {
  agentId: string;
  tenantId: string;
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  value: Record<string, unknown>;
}

export interface SignSolanaTransactionRequest {
  agentId: string;
  tenantId: string;
  transaction: string;
  chainId?: number;
  broadcast?: boolean;
}

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

// ─── Tenant Config Types ──────────────────────────────────────

export interface TenantControlPlaneConfig {
  tenantId: string;
  displayName?: string;
  policyExposure?: Record<string, unknown>;
  policyTemplates?: Array<{ id: string; name: string; policies: PolicyRule[] }>;
  secretRoutePresets?: Array<{ id: string; name: string; path: string }>;
  approvalConfig?: Record<string, unknown>;
  featureFlags?: Record<string, boolean>;
  theme?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

// ─── Dashboard Types ──────────────────────────────────────────

export interface AgentDashboardResponse {
  agent: AgentIdentity;
  balances: {
    evm?: {
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

// ─── Approval Types ───────────────────────────────────────────

export interface ApprovalQueueEntry {
  id: string;
  txId: string;
  agentId: string;
  agentName?: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  toAddress?: string;
  value?: string;
  chainId?: number;
  txStatus?: TxStatus;
  comment?: string;
  reason?: string;
}

export interface ApprovalStats {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
  avgWaitSeconds: number;
}

export interface AutoApprovalRule {
  id?: string;
  tenantId: string;
  maxAmountWei: string;
  autoDenyAfterHours?: number | null;
  escalateAboveWei?: string | null;
  enabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// ─── Webhook Types ────────────────────────────────────────────

export type WebhookEventType =
  | "tx.pending"
  | "tx.approved"
  | "tx.denied"
  | "tx.signed"
  | "spend.threshold"
  | "policy.violation";

export interface WebhookConfig {
  id: string;
  tenantId: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  enabled: boolean;
  maxRetries: number;
  retryBackoffMs: number;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  url: string;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextRetryAt?: Date;
  lastError?: string;
  createdAt: Date;
}

export const SUPPORTED_CHAINS = {
  base: 8453,
  baseSepolia: 84532,
  bsc: 56,
  bscTestnet: 97,
} as const;

// ─── CAIP-2 Chain Identifiers ───

export interface ChainIdentifier {
  caip2: string;
  numericId: number;
  family: "evm" | "solana";
  name: string;
  symbol: string;
  testnet: boolean;
}

export interface AllowedChainsConfig {
  chains: string[];
}

/** Result of exporting private keys from a vault agent or user wallet. */
export interface ExportKeyResult {
  evm?: { privateKey: string; address: string };
  solana?: { privateKey: string; address: string };
  warning: string;
}

/**
 * Registry of all supported chains, keyed by CAIP-2 identifier.
 *
 * CAIP-2 format:
 *   EVM:    `eip155:{chainId}`
 *   Solana: `solana:{genesisHashPrefix}`
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

export function chainFromNumeric(id: number): ChainIdentifier | undefined {
  return Object.values(CHAINS).find((c) => c.numericId === id);
}

export function chainFromCaip2(caip2: string): ChainIdentifier | undefined {
  return CHAINS[caip2];
}

export function toCaip2(numericId: number): string | undefined {
  return chainFromNumeric(numericId)?.caip2;
}

export function fromCaip2(caip2: string): number | undefined {
  return CHAINS[caip2]?.numericId;
}
