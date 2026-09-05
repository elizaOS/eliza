// @stwd/shared - types, constants, utils

import { CHAIN_PROVIDERS, type ChainProvider } from "./chains/index.js";
import type { VenueId } from "./types/venue.js";

// ─── Chain providers (extensible registry) ───
export * from "./chains/index.js";
export * from "./execution-contract.js";
export * from "./execution-payload.js";
export type { PriceOracle } from "./price-oracle.js";
export { createPriceOracle } from "./price-oracle.js";
export * from "./provider-action.js";
export * from "./provider-execution-auth.js";
// ─── Non-throwing description of an arbitrary thrown value (fail-closed catches) ───
export {
  describeThrown,
  redactedThrownDiagnostics,
  UNPRINTABLE_THROWN_VALUE,
} from "./safe-error.js";
export * from "./secret-route-matching.js";
export * from "./sensitive-keys.js";
// ─── Token Registry & Price Oracle ───
export * from "./tokens.js";
// ─── Per-request app context shape (shared so plugins can type routes) ───
export type {
  AppVariables,
  VerifiedAgentPrincipal,
} from "./types/app-variables.js";
// ─── Lean-core + opt-in-plugin contract ───
export type {
  AdapterContribution,
  ContributedPolicyResult,
  ContributedPolicyRule,
  LoginPlugin,
  PluginMigrationSource,
  PolicyRuleContribution,
} from "./types/plugin.js";
// ─── Trading venues (Sprint 4) ───
export * from "./types/venue.js";
// ─── Runtime-extensible webhook event registry (core ∪ plugin-declared) ───
export { WebhookEventRegistry } from "./webhook-event-registry.js";

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

export const WEBHOOK_EVENT_TYPES = [
  "tx.pending",
  "tx.approved",
  "tx.denied",
  "tx.signed",
  "spend.threshold",
  "policy.violation",
  "user.created",
  "user.authenticated",
  "user.linked_account",
  "user.unlinked_account",
  "user.updated_account",
  "user.transferred_account",
  "user.wallet_created",
  "mfa.enabled",
  "mfa.disabled",
  "private_key.exported",
  "wallet.imported",
  "wallet.recovery_setup",
  "wallet.recovered",
  "wallet.raw_signature.created",
  "wallet.funds_deposited",
  "wallet.funds_withdrawn",
  "wallet.frozen",
  "wallet.unfrozen",
  "transaction.broadcasted",
  "transaction.confirmed",
  "transaction.execution_reverted",
  "transaction.replaced",
  "transaction.failed",
  "transaction.provider_error",
  "transaction.still_pending",
  "user_operation.completed",
  "user_operation.failed",
  "intent.created",
  "intent.authorized",
  "intent.executed",
  "intent.failed",
  "intent.rejected",
  "intent.canceled",
  "intent.expired",
  "wallet_action.transfer.created",
  "wallet_action.transfer.succeeded",
  "wallet_action.transfer.rejected",
  "wallet_action.transfer.failed",
  "wallet_action.swap.created",
  "wallet_action.swap.succeeded",
  "wallet_action.swap.rejected",
  "wallet_action.swap.failed",
  "wallet_action.send_calls.created",
  "wallet_action.send_calls.succeeded",
  "wallet_action.send_calls.rejected",
  "wallet_action.send_calls.failed",
  "wallet_action.earn_deposit.created",
  "wallet_action.earn_deposit.succeeded",
  "wallet_action.earn_deposit.rejected",
  "wallet_action.earn_deposit.failed",
  "wallet_action.earn_withdraw.created",
  "wallet_action.earn_withdraw.succeeded",
  "wallet_action.earn_withdraw.rejected",
  "wallet_action.earn_withdraw.failed",
  "wallet_action.earn_incentive_claim.created",
  "wallet_action.earn_incentive_claim.succeeded",
  "wallet_action.earn_incentive_claim.rejected",
  "wallet_action.earn_incentive_claim.failed",
] as const;

export type WebhookCatalogEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export type DiagnosticWebhookEventType = "webhook.test";

// Legacy event types kept for backwards-compatible dispatch inputs.
export type LegacyWebhookEventType =
  | "approval_required"
  | "tx_signed"
  | "tx_confirmed"
  | "tx_failed"
  | "tx_rejected";

export type WebhookEventType =
  | WebhookCatalogEventType
  | DiagnosticWebhookEventType
  | LegacyWebhookEventType;

export interface WebhookEvent {
  type: WebhookEventType;
  tenantId: string;
  agentId?: string;
  deliveryId?: string;
  // Unix-seconds the canonical signature was first computed; fixed at first send and reused on retries so the signature stays stable.
  signedAt?: number;
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
export type ChainFamily = "evm" | "solana" | "bitcoin" | "monero";

export type BitcoinNetwork = "mainnet" | "testnet";
export type BitcoinAddressType = "p2wpkh" | "p2tr";

export interface BitcoinWalletMetadata {
  network: BitcoinNetwork;
  addressType: BitcoinAddressType;
  path: string;
  publicKey: string;
  xOnlyPublicKey?: string;
  account: number;
  change: 0 | 1;
  index: number;
  caip2: string;
}

export type MoneroNetwork = "mainnet" | "stagenet";

/**
 * Public wallet metadata for a Monero wallet. Contains PUBLIC keys only.
 *
 * Monero-specific caveat: the private view key is a secret in Monero's
 * privacy model (it grants incoming-transaction visibility) and lives in the
 * encrypted key payload alongside the spend key — it must NEVER appear here.
 */
export interface MoneroWalletMetadata {
  network: MoneroNetwork;
  address: string;
  publicSpendKey: string;
  publicViewKey: string;
  /** Chain height at wallet creation; scanning starts here (light-sync). */
  restoreHeight: number;
  account: number;
  caip2: string;
}

export interface WalletAddressMetadata {
  bitcoin?: BitcoinWalletMetadata;
  monero?: MoneroWalletMetadata;
  [key: string]: unknown;
}

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
  walletAddresses?: {
    evm?: string;
    solana?: string;
    bitcoin?: string;
    monero?: string;
  };
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
  family: ChainFamily;
  name: string;
  symbol: string;
  testnet: boolean;
}

/**
 * Registry of all supported chains, keyed by CAIP-2 identifier.
 *
 * Derived from the per-chain `ChainProvider` modules under `chains/`. To add
 * a new chain, create a new file there and register it in `chains/index.ts`.
 *
 * CAIP-2 format:
 *   EVM:    `eip155:{chainId}`
 *   Solana: `solana:{genesisHashPrefix}`
 *
 * Solana convention IDs used internally: 101 = mainnet-beta, 102 = devnet.
 */
export const CHAINS: Record<string, ChainIdentifier> = Object.freeze(
  Object.fromEntries(
    CHAIN_PROVIDERS.map((p: ChainProvider): [string, ChainIdentifier] => [
      p.caip2,
      {
        caip2: p.caip2,
        numericId: p.numericId,
        family: p.family,
        name: p.name,
        symbol: p.symbol,
        testnet: p.testnet,
      },
    ]),
  ),
);

/** Look up a chain by its internal numeric ID. Returns undefined if not found. */
export function chainFromNumeric(id: number): ChainIdentifier | undefined {
  return Object.values(CHAINS).find((c) => c.numericId === id);
}

/** Look up a chain by its CAIP-2 string (e.g. `"eip155:8453"`). Returns undefined if not found. */
export function chainFromCaip2(caip2: string): ChainIdentifier | undefined {
  // Own-key lookup: a bare index would return Object.prototype members (e.g.
  // "constructor") as if they were known chains (SEC-116).
  return Object.hasOwn(CHAINS, caip2) ? CHAINS[caip2] : undefined;
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
  return chainFromCaip2(caip2)?.numericId;
}

// ─── Policies ───

export type PolicyType =
  | "spending-limit"
  | "approved-addresses"
  | "auto-approve-threshold"
  | "time-window"
  | "rate-limit"
  | "allowed-chains"
  | "condition-set"
  | "aggregation"
  | "contract-allowlist"
  | "typed-data"
  | "raw-signing-chain"
  | "reputation-threshold"
  | "reputation-scaling"
  | "venue-allowlist"
  | "leverage-cap";

export interface PolicyRule {
  id: string;
  type: PolicyType;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SpendingLimitConfig {
  // Canonical wei-based limits. Wei values are decimal strings so conversion
  // to bigint is exact across JSON and JavaScript runtimes.
  maxPerTx?: string;
  maxPerDay?: string;
  maxPerWeek?: string;
  // USD limits are conjunctive with any canonical or legacy wei limits.
  maxPerTxUsd?: number;
  maxPerDayUsd?: number;
  maxPerWeekUsd?: number;
  // Legacy simplified representation retained for persisted-policy and API
  // compatibility. A missing period means "day".
  maxAmount?: string;
  period?: "tx" | "transaction" | "day" | "daily" | "week" | "weekly";
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

export interface ConditionSetConfig {
  /** Condition set id whose items are evaluated against. */
  conditionSetId: string;
  /** Request field to compare. Defaults to `ethereum_transaction.to`. */
  field?:
    | "to"
    | "ethereum_transaction.to"
    | "ethereum_transaction.chain_id"
    | "ethereum_transaction.value"
    | "ethereum_transaction.data"
    | "solana_system_program_instruction.Transfer.to"
    | "chain_id"
    | "value"
    | "data";
  /** Privy-style operator. Defaults to `in_condition_set`. */
  operator?: "in_condition_set" | "not_in_condition_set";
  /** Defaults to false for address/string allowlists. */
  caseSensitive?: boolean;
}

/**
 * Metric an {@link AggregationConditionConfig} rolls up over its window.
 * Extensible union — add new metrics here and teach the provider/evaluator
 * how to source them.
 */
export type AggregationMetric = "value_sum" | "tx_count" | "unique_recipients";

/** Named rolling windows accepted by an aggregation condition. */
export type AggregationNamedWindow = "1h" | "24h" | "7d" | "30d";

/**
 * Rolling window for an aggregation. Either a named bucket (`"24h"`) or an
 * explicit positive integer number of seconds. Seconds win when both are set.
 */
export interface AggregationWindow {
  named?: AggregationNamedWindow;
  seconds?: number;
}

/**
 * How the aggregate is grouped before comparison:
 *  - `agent`         → one bucket spanning all of the agent's activity
 *  - `per_recipient` → bucket keyed by the request's `to` address
 *  - `per_chain`     → bucket keyed by the request's `chainId`
 */
export type AggregationScope = "agent" | "per_recipient" | "per_chain";

/** Comparator applied as `aggregate <cmp> threshold`. Deny when it holds. */
export type AggregationComparator = "lte" | "lt" | "gte" | "gt" | "eq";

/**
 * How the threshold (and the underlying aggregate) is denominated:
 *  - `raw`  → native base units (wei/lamports), integer/bigint-safe
 *  - `usd`  → US dollars; evaluation REQUIRES a price oracle and MUST fail
 *             closed (deny) when the oracle or a conversion is unavailable.
 *
 * USD aggregates are expressed in integer cents to stay bigint-safe; the
 * threshold for a USD condition is therefore also interpreted as cents.
 */
export type AggregationDenomination = "raw" | "usd";

/**
 * Privy-style stateful aggregation condition (parity with Privy "aggregations").
 *
 * Gates a request on a rolling server-side aggregate of the agent's activity,
 * e.g. "deny if total value transferred in the last 24h exceeds X" or "deny if
 * the count of transactions in the last 1h exceeds N". The aggregate is ALWAYS
 * sourced from the authoritative provider (Redis rolling counters / tx history)
 * — never from caller-supplied request fields.
 *
 * Semantics: the condition DENIES (policy NACK) when
 *   `(currentAggregate + thisRequestContribution) <cmp> threshold`
 * holds. The contribution of the current request is included so the cap is
 * enforced *before* it is breached (matching the spending-limit "would exceed"
 * behaviour). The evaluator FAILS CLOSED: a missing provider value, a missing
 * oracle for USD, or a malformed/negative threshold all DENY.
 */
export interface AggregationConditionConfig {
  metric: AggregationMetric;
  window: AggregationWindow;
  /** Defaults to `agent`. */
  scope?: AggregationScope;
  comparator: AggregationComparator;
  /** Decimal string; bigint-safe (raw base units, or USD cents when denomination=usd). */
  threshold: string;
  /** Defaults to `raw`. When `usd`, a price oracle is required or evaluation denies. */
  denomination?: AggregationDenomination;
}

/**
 * SEC-183 (documented seam): `contract-allowlist` gates CONTRACT CALLS ONLY.
 * A transaction with no calldata — a plain native-value transfer — passes
 * this rule unconditionally regardless of the allowlist below. Operators who
 * expect it to also constrain native sends MUST pair it with an
 * `approved-addresses` rule (whose write validator currently restricts
 * addresses to EVM format).
 */
export interface ContractAllowlistConfig {
  contracts: Array<{
    address: string;
    selectors: string[];
    constraints?: Record<
      string,
      {
        recipientAllowlist?: string[];
        recipientBlocklist?: string[];
        spenderAllowlist?: string[];
        spenderBlocklist?: string[];
        fromAllowlist?: string[];
        fromBlocklist?: string[];
        /** Decimal uint256 token ids permitted (ERC721/1155). */
        tokenIdAllowlist?: string[];
        /** Decimal uint256 token ids blocked (ERC721/1155). */
        tokenIdBlocklist?: string[];
        /** Maximum native chain value, in decimal wei, permitted with this selector. */
        maxNativeValueWei?: string;
        maxAmount?: string;
      }
    >;
  }>;
}

/**
 * Per-field condition applied to an EIP-712 message `value` by a
 * {@link TypedDataConditionConfig}. `field` is a dot-path into the decoded
 * message object (e.g. `"spender"`, `"details.token"`, `"permitted.token"`).
 *
 * Operators:
 *  - `address_in` / `address_not_in` — the field is read as a 20-byte hex
 *    address and compared case-insensitively against `values`.
 *  - `eq`            — strict string equality against `value`.
 *  - `in` / `not_in` — string membership against `values`.
 *  - `uint_max`      — the field is parsed as a uint256 (decimal or 0x-hex) and
 *                      must be `<= value`.
 *
 * Every operator FAILS CLOSED: a missing field, an undecodable address, or a
 * non-numeric value DENIES the signature rather than skipping the check.
 */
export interface TypedDataMessageCondition {
  field: string;
  operator:
    | "address_in"
    | "address_not_in"
    | "eq"
    | "in"
    | "not_in"
    | "uint_max";
  value?: string;
  values?: string[];
}

/**
 * Privy-style EIP-712 typed-data condition (parity with Privy's
 * `eth_signTypedData_v4` domain/message conditions).
 *
 * Constrains an `eth_signTypedData_v4` request. Every constraint that is set
 * must hold or the signature is DENIED (fail-closed). When `ctx.typedData` is
 * absent (i.e. the request is an ordinary transaction sign, not a typed-data
 * sign) the policy is not applicable and passes — the typed-data signing route
 * is the only caller that populates `ctx.typedData`, so this cannot be used to
 * bypass the constraint on a real typed-data sign.
 */
export interface TypedDataConditionConfig {
  /** domain.verifyingContract must be one of these (case-insensitive). */
  verifyingContractAllowlist?: string[];
  /** domain.verifyingContract must NOT be one of these (case-insensitive). */
  verifyingContractBlocklist?: string[];
  /** domain.chainId must be one of these. */
  allowedChainIds?: number[];
  /** domain.name must be one of these (case-sensitive). */
  allowedDomainNames?: string[];
  /** primaryType must be one of these (case-sensitive). */
  allowedPrimaryTypes?: string[];
  /** Per-field constraints applied to the message `value`. */
  messageConditions?: TypedDataMessageCondition[];
}

export interface RawSigningChainConditionConfig {
  /** Lowercase chain slugs from RAW_SIGNING_CHAIN_SUPPORT, e.g. "sui", "tron", "tempo". */
  allowedChains?: string[];
  blockedChains?: string[];
  allowedCurves?: string[];
  /** Defaults true: unsupported chains/curves deny raw signing. */
  requireSupported?: boolean;
}

/**
 * `venue-allowlist` policy config (Sprint 4).
 *
 * Allows trades only on the named venues. Evaluator NACKs if the eval
 * context's `venue` is absent or not in the list.
 */
export interface VenueAllowlistConfig {
  allowedVenues: string[];
}

/**
 * `leverage-cap` policy config (Sprint 4).
 *
 * Caps requested leverage at `maxLeverage`. Non-leveraged trades (no
 * `leverage` in eval context) always pass. Per-venue refinement is
 * Phase 2 work; for now this is a single cap per agent.
 */
export interface LeverageCapConfig {
  maxLeverage: number;
}

// ─── Transactions ───

export type TxStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "outcome_unknown";

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
  /**
   * Optional venue selector. When set, the vault looks up the venue-scoped
   * signing key for (agentId, chainFamily, venue) instead of the legacy
   * NULL-venue key. Used by venue-aware integrations like Hyperliquid where
   * the agent has a per-venue wallet distinct from its main EVM wallet.
   */
  venue?: string;
  /**
   * Optional explicit wallet address selector. When set, validates the
   * resolved key derives this address (defense-in-depth). If venue is set,
   * this serves as an assertion; otherwise it's used to disambiguate when
   * multiple non-venue keys exist (which should not happen but defends).
   */
  walletAddress?: string;
}

/**
 * EIP-712 typed data signing request (`eth_signTypedData_v4`).
 */
export interface SignTypedDataRequest {
  agentId: string;
  tenantId: string;
  /**
   * Sprint 4: optional venue scope. When set, vault.signTypedData will
   * look up the venue-scoped wallet under (agentId, venue) instead of
   * the legacy NULL-venue row. Phase 1 is hyperliquid-only; the field is
   * accepted but not yet routed through the new lookup path.
   */
  venue?: VenueId;
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
  expectedTo?: string; // policy-evaluated recipient for serialized transfer validation
  expectedValue?: string; // policy-evaluated lamports for serialized transfer validation
  /**
   * SEC-163: explicit caller attestation required when signing WITHOUT the
   * expectedTo/expectedValue policy envelope (token/multi-instruction shapes
   * the vault's byte-level envelope check cannot model). Callers must only set
   * this after their own edge policy evaluation approved the transaction; the
   * vault rejects blind requests that omit it and logs every flagged blind
   * sign. Never forward client-controlled input into this flag.
   */
  allowBlindSign?: boolean;
  /**
   * Durable recovery checkpoint invoked after signing has produced the
   * deterministic transaction signature, but before any broadcast I/O. API
   * callers use this to persist the signature as outcome_unknown so a crash,
   * lost RPC response, or confirmation failure cannot make a potentially
   * submitted transaction indistinguishable from one that was never sent.
   */
  onBroadcastPrepared?: (checkpoint: {
    signature: string;
    recentBlockhash: string;
  }) => Promise<void>;
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
  walletIndex?: number;
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

export type EmbeddedWalletCreateOnLogin =
  | "off"
  | "users-without-wallets"
  | "all-users";

export interface TenantEmbeddedWalletFeatureFlags {
  createOnLogin?: EmbeddedWalletCreateOnLogin;
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
  embeddedWallets?: TenantEmbeddedWalletFeatureFlags;
  embeddedWalletCreateOnLogin?: EmbeddedWalletCreateOnLogin;
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
  logoUrl?: string;
  faviconUrl?: string;
}

export interface TenantOidcProviderConfig {
  id: string;
  enabled: boolean;
  issuer: string;
  audience: string[];
  jwksUri: string;
  clientId?: string;
  clientSecretEnv?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  subjectClaim?: "sub";
  emailClaim?: string;
  emailVerifiedClaim?: string;
  nameClaim?: string;
  pictureClaim?: string;
  allowedAlgs?: Array<"RS256" | "ES256">;
  allowJitProvisioning?: boolean;
}

export type TenantSamlSsoStatus = "pending" | "active" | "error";
export type TenantSamlGroupRole =
  | "admin"
  | "developer"
  | "billing"
  | "viewer"
  | "member";

export interface TenantSamlGroupRoleMapping {
  group: string;
  role: TenantSamlGroupRole;
}

export interface TenantSamlSsoConfig {
  tenantId: string;
  enabled: boolean;
  status: TenantSamlSsoStatus;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertPems: string[];
  spEntityId: string;
  acsUrl: string;
  nameIdFormat?: string;
  emailAttribute: string;
  groupsAttribute?: string;
  groupRoleMappings: TenantSamlGroupRoleMapping[];
  allowJitProvisioning: boolean;
  jitDefaultRole: "viewer";
  lastTestedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface TenantSamlSsoUpdate {
  enabled?: boolean;
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpCertPems?: string[];
  nameIdFormat?: string;
  emailAttribute?: string;
  groupsAttribute?: string;
  groupRoleMappings?: TenantSamlGroupRoleMapping[];
  allowJitProvisioning?: boolean;
}

export type TenantCaptchaProvider = "turnstile" | "hcaptcha";
export type TenantCaptchaAction = "email_otp" | "sms_otp";

export interface TenantMfaPolicyConfig {
  /**
   * Maximum age for step-up MFA on sensitive tenant-admin actions.
   * Defaults to 300 seconds and is bounded by the API normalizer.
   */
  maxAgeSeconds?: number;
  maxAgeFor?: {
    vaultSigning?: number;
    keyImport?: number;
    keyExport?: number;
    recoveryCodes?: number;
    tenantAdmin?: number;
  };
  requireFor?: {
    vaultSigning?: boolean;
    keyImport?: boolean;
    keyExport?: boolean;
    recoveryCodes?: boolean;
    tenantAdmin?: boolean;
  };
  disableFor?: {
    keyImport?: boolean;
    keyExport?: boolean;
  };
  allowDelegatedSignerAutomation?: boolean;
  allowKeyQuorumAutomation?: boolean;
}

export interface TenantAuthAbuseConfig {
  loginMethods?: {
    passkey?: boolean;
    email?: boolean;
    sms?: boolean;
    whatsapp?: boolean;
    totp?: boolean;
    siwe?: boolean;
    siws?: boolean;
    telegram?: boolean;
    farcaster?: boolean;
    oauth?: Record<string, boolean>;
    oidc?: Record<string, boolean>;
  };
  captcha?: {
    enabled?: boolean;
    provider?: TenantCaptchaProvider;
    siteKey?: string;
    /**
     * Name of the environment variable containing the provider secret.
     * Defaults to STEWARD_TURNSTILE_SECRET_KEY or STEWARD_HCAPTCHA_SECRET_KEY.
     */
    secretKeyEnv?: string;
    requiredFor?: TenantCaptchaAction[];
  };
  email?: {
    blockDisposable?: boolean;
    blockPlusAliases?: boolean;
    allowedEmails?: string[];
    blockedEmails?: string[];
    allowedDomains?: string[];
    blockedDomains?: string[];
  };
  wallet?: {
    allowedWallets?: string[];
    blockedWallets?: string[];
    /**
     * When enabled, a user can link at most one third-party wallet account
     * across supported wallet providers.
     */
    restrictToOneThirdPartyWallet?: boolean;
  };
  phone?: {
    /**
     * OSS-friendly VOIP hook: block known VOIP prefixes supplied by deployment
     * config without depending on a proprietary carrier lookup relationship.
     */
    blockVoip?: boolean;
    allowedPhoneNumbers?: string[];
    blockedPhoneNumbers?: string[];
    allowedCountryCodes?: string[];
    blockedCountryCodes?: string[];
  };
  mfa?: TenantMfaPolicyConfig;
}

export type TenantAppClientEnvironment =
  | "development"
  | "preview"
  | "staging"
  | "production";

export interface TenantAppClientEmbeddedWalletConfig {
  createOnLogin?: EmbeddedWalletCreateOnLogin;
}

export interface TenantAppClient {
  id: string;
  name: string;
  environment: TenantAppClientEnvironment;
  enabled?: boolean;
  isDefault?: boolean;
  allowedOrigins?: string[];
  allowedRedirectUrls?: string[];
  allowedBundleIds?: string[];
  allowedPackageNames?: string[];
  loginMethods?: TenantAuthAbuseConfig["loginMethods"];
  embeddedWallets?: TenantAppClientEmbeddedWalletConfig;
  globalWalletEnabled?: boolean;
  globalWalletAllowedScopes?: string[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface TenantAppClientSecret {
  id: string;
  tenantId: string;
  clientId: string;
  appId: string;
  secretPrefix: string;
  status: "active" | "retiring" | "revoked";
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
}

export interface TenantAppClientSecretCreateResult {
  secret: TenantAppClientSecret;
  appId: string;
  appSecret: string;
}

export interface TenantSsoDomain {
  id: string;
  tenantId: string;
  domain: string;
  verificationToken: string;
  status: "pending" | "verified";
  ssoRequired: boolean;
  verifiedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SsoDiscoveryResult {
  domain: string;
  tenantId: string | null;
  ssoRequired: boolean;
  available: boolean;
}

export interface TenantTestAccountConfig {
  enabled?: boolean;
  email?: string;
  phone?: string;
  otp?: string;
  otpHash?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type GasSponsorshipProvider =
  | "custom_evm_paymaster"
  | "custom_bundler"
  | "solana_fee_payer"
  | "mock";

export type GasSponsorshipMode = "erc4337" | "eip7702" | "solana_fee_payer";

export interface TenantGasSponsorshipConfig {
  enabled?: boolean;
  provider?: GasSponsorshipProvider;
  mode?: GasSponsorshipMode;
  allowedChainIds?: number[];
  allowedCaip2?: string[];
  paymasterUrl?: string;
  bundlerUrl?: string;
  entryPoint?: string;
  feePayerAgentId?: string;
  maxPerTxUsd?: number;
  maxPerWalletDayUsd?: number;
  maxTenantDayUsd?: number;
  maxTenantMonthUsd?: number;
  allowClientSponsorship?: boolean;
  requireSimulation?: boolean;
  circuitBreakerEnabled?: boolean;
}

export interface SponsoredGasSpendEntry {
  id: string;
  tenantId: string;
  agentId: string;
  userId?: string | null;
  txId?: string | null;
  chainFamily: ChainFamily;
  chainId?: number | null;
  caip2?: string | null;
  provider: GasSponsorshipProvider | string;
  mode: GasSponsorshipMode | string;
  status: string;
  reservedUsd?: string | null;
  actualUsd?: string | null;
  txHash?: string | null;
  userOperationHash?: string | null;
  signature?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SponsoredGasSpendSummary {
  currency: "USD";
  reservedUsd: string;
  actualUsd: string;
  count: number;
  entries: SponsoredGasSpendEntry[];
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
  oidcProviders?: TenantOidcProviderConfig[];
  samlSso?: TenantSamlSsoConfig;
  authAbuseConfig?: TenantAuthAbuseConfig;
  appClients?: TenantAppClient[];
  testAccount?: TenantTestAccountConfig;
  gasSponsorshipConfig?: TenantGasSponsorshipConfig;
  /** Allowed CORS origins for this tenant. Empty array = wildcard (*) in dev mode. */
  allowedOrigins?: string[];
  /** Allowed OAuth/email redirect URLs for this tenant. */
  allowedRedirectUrls?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export type TenantSecurityChecklistStatus = "pass" | "warning" | "fail";

export interface TenantSecurityChecklistItem {
  id: string;
  label: string;
  status: TenantSecurityChecklistStatus;
  description: string;
  remediation?: string;
}

export interface TenantSecurityChecklist {
  tenantId: string;
  generatedAt: Date | string;
  summary: {
    pass: number;
    warning: number;
    fail: number;
  };
  items: TenantSecurityChecklistItem[];
}

export interface IdempotencyMetricCounters {
  observed: number;
  reserved: number;
  completed: number;
  replayed: number;
  conflicts: number;
  inFlightConflicts: number;
  suppressedAuthResponses: number;
  invalidKeys: number;
  storeErrors: number;
  skippedUnsafeContext: number;
  releasedOnError: number;
}

export interface TenantIdempotencyMetrics {
  tenantId: string;
  generatedAt: Date | string;
  windowStartedAt: Date | string;
  lastSeenAt: Date | string | null;
  ttlMs: number;
  counters: IdempotencyMetricCounters;
}

export interface TenantRequestSigningKey {
  id: string;
  tenantId: string;
  name: string;
  secretPrefix: string;
  status: "active" | "retiring" | "revoked";
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
}

export interface TenantRequestSigningKeyCreateResult {
  key: TenantRequestSigningKey;
  signingSecret: string;
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
  gnosis: 100,
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
  100: {
    id: 100,
    name: "Gnosis",
    symbol: "xDAI",
    explorerUrl: "https://gnosisscan.io",
    explorerTxUrl: "https://gnosisscan.io/tx/",
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

export * from "./security-metrics.js";

export function getExplorerTxLink(
  chainId: number,
  txHash: string,
): string | undefined {
  const meta = CHAIN_META[chainId];
  return meta ? `${meta.explorerTxUrl}${txHash}` : undefined;
}
