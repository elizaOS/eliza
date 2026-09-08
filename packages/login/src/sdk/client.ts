/** Sends authenticated identity and wallet requests to the host-owned login service. */
import { assertSecureBaseUrl, stripTrailingSlashes } from "./base-url.ts";
import type {
  AgentAccountSummary,
  AgentBalance,
  AgentDashboardResponse,
  AgentIdentity,
  AgentKeyQuorum,
  AgentKeyQuorumCreate,
  AgentKeyQuorumStatus,
  AgentKeyQuorumUpdate,
  AgentSigner,
  AgentSignerCreate,
  AgentSignerCreateResult,
  AgentSignerStatus,
  AgentSignerUpdate,
  AgentSpendSummary,
  ApiResponse,
  ApprovalQueueEntry,
  ApprovalStats,
  AuthorizationKey,
  AuthorizationKeyCreate,
  AuthorizationKeyCreateResult,
  AuthorizationKeyUpdate,
  AutoApprovalRule,
  ChainFamily,
  EncryptedAgentKeyImportInitResult,
  EncryptedAgentKeyImportResult,
  EncryptedAgentKeyImportSubmitInput,
  EncryptedUserWalletKeyImportInitResult,
  EncryptedUserWalletKeyImportResult,
  EncryptedUserWalletKeyImportSubmitInput,
  ExportKeyResult,
  PendingProxyRequest,
  PendingProxyRequestStatus,
  PlatformLinkAccountResult,
  PlatformTenantInvitation,
  PlatformTenantInvitationCreateResult,
  PlatformTenantInvitationListResult,
  PlatformTenantUser,
  PlatformTransferAccountResult,
  PlatformUserCreateInput,
  PlatformUserCreateResult,
  PlatformUserDeactivateResult,
  PlatformUserDeleteResult,
  PlatformUserIdentity,
  PlatformUserLookupResult,
  PlatformUserSearchResult,
  PlatformWalletExternalIdAssignInput,
  PlatformWalletExternalIdAssignResult,
  PlatformWalletExternalIdConnectOrCreateInput,
  PlatformWalletExternalIdConnectOrCreateResult,
  PolicyResult,
  PolicyRule,
  PregeneratedUserWalletClaimResult,
  PregeneratedUserWalletCreateResult,
  RpcResponse,
  SponsoredGasSpendSummary,
  SsoDiscoveryResult,
  TenantAccessAllowlistEntry,
  TenantAccessAllowlistEntryInput,
  TenantAdminUser,
  TenantAdminUserEventsResult,
  TenantAdminUserSearchResult,
  TenantAppClient,
  TenantAppClientSecret,
  TenantAppClientSecretCreateResult,
  TenantAuthAbuseConfig,
  TenantControlPlaneConfig,
  TenantGasSponsorshipConfig,
  TenantIdempotencyMetrics,
  TenantMembership,
  TenantOidcProviderConfig,
  TenantRequestSigningKey,
  TenantRequestSigningKeyCreateResult,
  TenantSamlSsoConfig,
  TenantSamlSsoUpdate,
  TenantSecurityChecklist,
  TenantSsoDomain,
  TenantTeamRole,
  TenantTestAccountConfig,
  TenantWalletPolicyBulkRemediationItem,
  TenantWalletPolicyBulkRemediationResponse,
  TenantWalletPolicyRemediationResult,
  TenantWalletPolicyViolationReport,
  TxRecord,
  TypedDataDomain,
  TypedDataField,
  UserAccountSummary,
  UserPushSubscriptionInput,
  UserPushSubscriptionListResult,
  UserPushSubscriptionResult,
  UserWalletCreateResult,
  UserWalletHistoryResult,
  UserWalletRecoveryRestoreResult,
  UserWalletRecoverySetupResult,
  UserWalletSigner,
  UserWalletSignerCreate,
  UserWalletSignerCreateResult,
  UserWalletSignMessageResult,
  UserWalletSignResult,
} from "./types.ts";

export interface BatchAgentSpec {
  id: string;
  name: string;
  /** login-native immutable per-tenant wallet external identifier. */
  platformId?: string;
  /** Privy-style alias for platformId. Ignored when platformId is supplied. */
  externalId?: string;
}

export interface BatchCreateResult {
  created: AgentIdentity[];
  errors: Array<{ id: string; error: string }>;
}

export interface WalletBatchSpec {
  /** Client-side reference id used only for partial-failure reporting. */
  id: string;
  name: string;
  /** Immutable per-tenant wallet external id. */
  externalId?: string;
}

export type WalletBatchCreateResult = BatchCreateResult;

export type GetBalanceResult = AgentBalance;
export interface UserWalletSelector {
  walletIndex?: number;
}
export interface UserWalletBalanceInput extends UserWalletSelector {
  chainId?: number;
}

export interface LoginClientConfig {
  baseUrl: string;
  apiKey?: string;
  /** Privy-style app id for server auth, sent as Basic auth username and X-Steward-App-Id. */
  appId?: string;
  /** Privy-style app secret for server auth, sent only through Basic auth. */
  appSecret?: string;
  /** Platform management key - sent as `X-Steward-Platform-Key`. */
  platformKey?: string;
  /** Agent-scoped JWT - sent as `Authorization: Bearer <token>`. Preferred over apiKey when both are set. */
  bearerToken?: string;
  tenantId?: string;
  /** Optional HMAC secret used to sign sensitive mutating requests. */
  requestSigningSecret?: string;
  /** Optional tenant request-signing key id, sent as `X-Steward-Signing-Key-Id`. */
  requestSigningKeyId?: string;
  /**
   * Server-grade credentials are blocked in browser runtimes by default because
   * injected scripts can read request headers. Prefer bearerToken in browsers.
   */
  allowUnsafeBrowserSecrets?: boolean;
  /**
   * Permit a plaintext non-loopback baseUrl (warns at construction). HTTPS is
   * required by default so credentials never travel cleartext off-loopback.
   */
  allowInsecureBaseUrl?: boolean;
  /**
   * End-to-end request deadline, including request-header signing, receipt of
   * response headers, and consumption of the response body. Defaults to 30s.
   */
  requestTimeoutMs?: number;
  /**
   * Maximum decoded response-body bytes accepted from the API. Defaults to
   * 8 MiB and can never exceed the SDK's 16 MiB safety ceiling.
   */
  maxResponseBodyBytes?: number;
}

export interface QuorumSignerCredential {
  signerId: string;
  signerSecret: string;
}

export interface LoginSignerAuthOptions {
  /** Delegated signer id for non-admin flows. */
  signerId?: string;
  /** One-time-issued signer credential secret for delegated flows. */
  signerSecret?: string;
  /** Key quorum id for multi-signer non-admin flows. */
  keyQuorumId?: string;
  /** Signer-bound credentials that satisfy the key quorum threshold. */
  keyQuorumCredentials?: QuorumSignerCredential[];
}

export interface SignTransactionInput {
  to: string;
  value: string;
  data?: string;
  chainId?: number;
  broadcast?: boolean; // default true; set false to get signed tx without broadcasting
}

export type SignTransactionOptions = LoginSignerAuthOptions;

export interface SignTypedDataInput {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  value: Record<string, unknown>;
}

export type SignTypedDataOptions = LoginSignerAuthOptions;

export interface SignUserOperationInput {
  userOperation: {
    sender: string;
    nonce: string;
    initCode?: string;
    callData: string;
    verificationGasLimit: string;
    callGasLimit: string;
    preVerificationGas: string;
    maxPriorityFeePerGas: string;
    maxFeePerGas: string;
    paymasterAndData?: string;
  };
  entryPoint?: string;
  chainId: number;
  /** Explicit policy recipient until calldata-level extraction is configured. */
  to: string;
  /** Explicit policy value in wei until calldata-level extraction is configured. */
  value: string;
  /** Optional caller-supplied ID mirrored in action payloads and lifecycle webhooks. */
  referenceId?: string;
}

export type SignUserOperationOptions = LoginSignerAuthOptions;

export interface SignAuthorizationInput {
  contractAddress: string;
  /** EIP-7702 allows 0 to designate any chain. */
  chainId: number;
  nonce: number;
  /** Optional caller-supplied ID mirrored in action payloads and lifecycle webhooks. */
  referenceId?: string;
}

export type SignAuthorizationOptions = LoginSignerAuthOptions;

export interface SignSolanaTransactionInput {
  transaction: string; // base64-encoded serialized Solana transaction
  chainId?: number; // 101 = mainnet, 102 = devnet
  broadcast?: boolean; // default true
}

export interface RpcPassthroughInput {
  method: string;
  params?: unknown[];
  chainId: number;
}

export interface LoginPendingApproval {
  status: "pending_approval";
  results: PolicyResult[];
}

/**
 * The provider produced a deterministic transaction hash, but the login service could
 * not prove whether the upstream broadcast was accepted. Callers must
 * reconcile `txHash` and must not submit the intent again.
 */
export interface LoginBroadcastOutcomeUnknown {
  code: "external_broadcast_outcome_unknown";
  txId: string;
  txHash: string;
  reconciliationRequired: true;
}

export interface LoginHistoryEntry {
  timestamp: number;
  value: string;
}

export interface SignMessageResult {
  signature: string;
}

export type SignMessageOptions = LoginSignerAuthOptions;

export interface SignRawHashInput {
  hash: `0x${string}`;
  /** Optional caller-supplied ID mirrored in audit metadata. */
  referenceId?: string;
  /** Delegated signer or key quorum authentication for non-admin unsafe signing flows. */
  signerId?: LoginSignerAuthOptions["signerId"];
  signerSecret?: LoginSignerAuthOptions["signerSecret"];
  keyQuorumId?: LoginSignerAuthOptions["keyQuorumId"];
  keyQuorumCredentials?: LoginSignerAuthOptions["keyQuorumCredentials"];
}

export interface SignRawHashResult {
  signature: string;
  hash: `0x${string}`;
  walletAddress: string;
}

// Keep in lockstep with the equivalent list in EVERY other SDK (go, java,
// python, ruby, rust, swift, csharp, flutter): mutations under these prefixes
// are HMAC-signed, and divergence silently downgrades integrity (SEC-049).
const SENSITIVE_SIGNED_PATHS = [
  "/vault",
  "/agents",
  "/policies",
  "/secrets",
  "/trade",
  "/v1/trade",
  "/approvals",
  "/intents",
  "/user",
  "/webhooks",
  "/tenants",
  "/platform",
  "/condition-sets",
  "/condition_sets",
  "/v1/condition_sets",
  "/global-wallet",
];
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type IdempotencyOptions = {
  idempotencyKey?: string;
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(
  secret: string,
  canonical: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isSensitiveMutatingRequest(path: string, method: string): boolean {
  return (
    MUTATING_METHODS.has(method.toUpperCase()) &&
    SENSITIVE_SIGNED_PATHS.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

/**
 * Result of creating a wallet. For new agents, includes `walletAddresses`
 * with both EVM and Solana addresses.
 */
export type CreateWalletResult = AgentIdentity;

export interface GetAddressesResult {
  agentId: string;
  addresses: Array<{ chainFamily: ChainFamily; address: string }>;
}

export interface AdapterTokenRef {
  address: string;
  symbol?: string;
  decimals?: number;
}

export interface AdapterUnsignedIntent {
  signed: false;
  kind: "evm-tx" | "evm-typed-data" | "abstract-intent";
  chainId: number;
  to: string;
  value: string;
  data?: string;
  owner: string;
  category: string;
  provider: string;
  metadata?: Record<string, unknown>;
}

export type AdapterRegistryDescription = Record<string, unknown>;
export type GetHistoryResult = LoginHistoryEntry[];
export type SignTransactionResult =
  | { txHash: string; caip2?: string }
  | { signedTx: string; caip2?: string }
  | LoginPendingApproval
  | LoginBroadcastOutcomeUnknown;
export interface TransferActionQuoteInput {
  to: string;
  /** ERC20 token contract address. Defaults to native chain asset. */
  token?: "native" | string;
  value?: string;
  amountWei?: string;
  chainId?: number;
  broadcast?: boolean;
  /** Optional caller-supplied ID mirrored in action payloads and lifecycle webhooks. */
  referenceId?: string;
  /** Request tenant-configured gas sponsorship for supported execution paths. */
  sponsor?: boolean;
}

export type WalletActionOptions = LoginSignerAuthOptions;

export interface UserLinkedAccount {
  id: string;
  provider: string;
  providerAccountId: string;
  expiresAt: number | null;
  type?: string;
  embeddedWallets?: Array<{ address: string }>;
  smartWallets?: Array<{ address: string }>;
  providerApp?: {
    id: string;
    name: string | null;
    logoUrl: string | null;
  };
  firstVerifiedAt?: string | Date;
  latestVerifiedAt?: string | Date;
}

export interface UserAccountsResult {
  accounts: UserLinkedAccount[];
  primaryLoginMethods: Array<{
    provider: "email" | "wallet";
    providerAccountId: string;
  }>;
}

export interface GlobalWalletAppSummary {
  id: string;
  appId: string;
  tenantId: string;
  name: string;
  environment: string;
  origin: string;
  redirectUri: string | null;
}

export interface GlobalWalletConsent {
  id: string;
  tenantId: string;
  clientId: string;
  appId: string;
  origin: string;
  redirectUri: string | null;
  walletAgentId: string | null;
  walletAddress: string | null;
  walletIndex: number | null;
  scopes: string[];
  status: string;
  grantedAt: string | Date;
  lastUsedAt: string | Date | null;
  expiresAt: string | Date | null;
  revokedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface GlobalWalletConsentRequest {
  app: GlobalWalletAppSummary;
  requestedScopes: string[];
  wallet: { agentId: string; address: string; walletIndex: number };
  consent: GlobalWalletConsent | null;
}

export interface GlobalWalletApproveResult {
  consent: GlobalWalletConsent;
  wallet: { agentId: string; address: string; walletIndex: number };
}

export interface GlobalWalletRpcResult<T = unknown> {
  jsonrpc: string;
  id: unknown;
  result: T;
}

export interface GlobalWalletActionConfirmation {
  confirmationId: string;
  method:
    | "personal_sign"
    | "eth_signTypedData_v4"
    | "eth_sendTransaction"
    | string;
  wallet?: { agentId: string; address: string; walletIndex: number };
  expiresAt: string;
}

export interface GlobalWalletTransactionScan {
  method: "eth_sendTransaction";
  wallet: { address: string; agentId: string; walletIndex: number };
  transaction: {
    from?: string;
    to: string;
    valueWei: string;
    data?: string;
    chainId: number;
  };
  blocked: boolean;
  riskLevel: "low" | "medium" | "high" | "blocked";
  warnings: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }>;
  confirmationRequired: boolean;
  executionSupported: boolean;
  unsupportedReason?: string | null;
}

export interface UserAccountUnlinkResult {
  deleted: boolean;
  issuedBefore: number;
}

export interface UserEthereumWalletLinkNonce {
  nonce: string;
  message: string;
  expiresIn: number;
  address?: string;
}

export interface UserEthereumWalletLinkResult {
  account: UserLinkedAccount;
  isNew: boolean;
}

export interface UserSolanaWalletLinkNonce {
  nonce: string;
  message: string;
  expiresIn: number;
  publicKey?: string;
}

export interface UserSolanaWalletLinkResult {
  account: UserLinkedAccount;
  isNew: boolean;
}

export interface UserOAuthAccountLinkResult {
  account: UserLinkedAccount;
  isNew: boolean;
}

export interface UserOAuthAccountLinkChallenge {
  state: string;
  redirectUri: string;
  expiresIn: number;
}

export interface UserPhoneAccountLinkSendResult {
  phone: string;
  expiresAt: string;
}

export interface UserPhoneAccountLinkResult {
  account: UserLinkedAccount;
  isNew: boolean;
}

export interface UserSocialAccountLinkResult {
  account: UserLinkedAccount;
  isNew: boolean;
}

export interface UserSocialAccountLinkChallenge {
  challengeId?: string;
  nonce?: string;
  expiresIn: number;
}

export type AgentPolicyRuleCreate = Omit<PolicyRule, "id" | "enabled"> & {
  id?: string;
  enabled?: boolean;
};

export type AgentPolicyRuleUpdate = Partial<Omit<PolicyRule, "id">> & {
  id?: never;
};

export interface TransferActionQuote {
  quoteId: string;
  type: "transfer";
  chainId: number;
  from: string;
  to: string;
  value: string;
  token: "native" | string;
  expiresAt: string;
  request: {
    to: string;
    token: "native" | string;
    value: string;
    chainId: number;
    broadcast: boolean;
    referenceId?: string;
    sponsor?: boolean;
  };
}
export interface SendCallsActionInput {
  calls: Array<{ to: string; value?: string; data?: string }>;
  chainId?: number;
  broadcast?: boolean;
  /** Optional caller-supplied ID mirrored in action payloads and lifecycle webhooks. */
  referenceId?: string;
  /** Request tenant-configured gas sponsorship for supported execution paths. */
  sponsor?: boolean;
}
export type TransferActionStatus =
  | "pending_approval"
  | "rejected"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "outcome_unknown";
export interface TransferAction {
  id: string;
  type: "transfer";
  status: TransferActionStatus;
  chainId: number;
  to: string;
  value: string;
  token: "native" | string;
  txHash?: string;
  signedTx?: string;
  sponsorship?: {
    requested: boolean;
    sponsored: boolean;
    provider?: string;
    mode?: string;
    estimatedUsd?: number | null;
  };
  policyResults?: PolicyResult[];
  createdAt?: string;
  signedAt?: string;
  confirmedAt?: string;
}
export interface SendCallsAction {
  id: string;
  type: "send_calls";
  status: "pending_approval" | "rejected";
  chainId: number;
  calls: Array<{ to: string; value: string; data?: string }>;
  totalValue: string;
  sponsorship?: {
    requested: boolean;
    sponsored: boolean;
    provider?: string;
    mode?: string;
    estimatedUsd?: number | null;
  };
  policyResults?: Array<PolicyResult & { callIndex?: number }>;
}
export type SignTypedDataResult = { signature: string };
export type SignUserOperationResult = {
  signature: string;
  userOperationHash: string;
  entryPoint: string;
  chainId: number;
  txId: string;
};
export type SignAuthorizationResult = {
  authorization: {
    contractAddress: string;
    chainId: number;
    nonce: number;
    r: string;
    s: string;
    yParity: 0 | 1;
  };
  txId: string;
};
export type SignSolanaTransactionResult = {
  signature: string;
  broadcast: boolean;
  chainId?: number;
  caip2?: string;
};
export type RpcPassthroughResult = RpcResponse;
export type TransactionListResult = {
  transactions: TxRecord[];
  limit: number;
  offset: number;
};
export type VaultApprovalResult = {
  txId: string;
  txHash?: string;
  signedTx?: string;
};
export type TransactionLifecycleEventType =
  | "transaction.broadcasted"
  | "transaction.confirmed"
  | "transaction.execution_reverted"
  | "transaction.replaced"
  | "transaction.failed"
  | "transaction.provider_error"
  | "transaction.still_pending";
export interface TransactionLifecycleUpdateInput {
  type: TransactionLifecycleEventType;
  txHash?: string;
  replacementTxHash?: string;
  reason?: string;
  error?: string;
  provider?: string;
  blockNumber?: string | number;
  confirmations?: number;
}
export interface TransactionReplaceInput {
  replacementTxHash: string;
  reason?: string;
  provider?: string;
  blockNumber?: string | number;
  confirmations?: number;
}
export interface LoginMfaRequiredErrorData {
  mfaRequired?: true;
  reason?: string;
  maxAgeSeconds?: number;
  mfaVerifiedAt?: number | null;
}

export type LoginErrorResponse = {
  results?: PolicyResult[];
} & LoginMfaRequiredErrorData;

function errorMessageRequiresMfa(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("recent mfa") ||
    normalized.includes("mfa step-up") ||
    normalized.includes("multi-factor") ||
    normalized.includes("mfa verification")
  );
}

type ApiRequestResult<TSuccess, TFailure> =
  | { ok: true; status: number; data: TSuccess }
  | { ok: false; status: number; error: string; data?: TFailure };

function parseAgentIdentity(agent: AgentIdentity): AgentIdentity {
  return {
    ...agent,
    createdAt: new Date(agent.createdAt),
  };
}

function parsePlatformTenantUser(user: PlatformTenantUser): PlatformTenantUser {
  return {
    ...user,
    joinedAt: new Date(user.joinedAt),
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}

function parsePlatformTenantInvitation(
  invitation: PlatformTenantInvitation,
): PlatformTenantInvitation {
  return {
    ...invitation,
    acceptedAt: invitation.acceptedAt ? new Date(invitation.acceptedAt) : null,
    revokedAt: invitation.revokedAt ? new Date(invitation.revokedAt) : null,
    expiresAt: new Date(invitation.expiresAt),
    createdAt: new Date(invitation.createdAt),
    updatedAt: invitation.updatedAt
      ? new Date(invitation.updatedAt)
      : undefined,
  };
}

function parseTenantAdminUser(user: TenantAdminUser): TenantAdminUser {
  return {
    ...user,
    joinedAt: new Date(user.joinedAt),
    deactivatedAt: user.deactivatedAt ? new Date(user.deactivatedAt) : null,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}

function parseTenantAdminUserEvents(
  result: TenantAdminUserEventsResult,
): TenantAdminUserEventsResult {
  return {
    ...result,
    events: result.events.map((event) => ({
      ...event,
      createdAt: new Date(event.createdAt),
    })),
  };
}

function parsePlatformUserIdentity(
  user: PlatformUserIdentity,
): PlatformUserIdentity {
  return {
    ...user,
    deactivatedAt: user.deactivatedAt ? new Date(user.deactivatedAt) : null,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}

function parseTxRecord(tx: TxRecord): TxRecord {
  return {
    ...tx,
    createdAt:
      tx.createdAt instanceof Date ? tx.createdAt : new Date(tx.createdAt),
    signedAt: tx.signedAt
      ? tx.signedAt instanceof Date
        ? tx.signedAt
        : new Date(tx.signedAt)
      : undefined,
    confirmedAt: tx.confirmedAt
      ? tx.confirmedAt instanceof Date
        ? tx.confirmedAt
        : new Date(tx.confirmedAt)
      : undefined,
  };
}

function signerHeaders(
  options?: LoginSignerAuthOptions,
): HeadersInit | undefined {
  if (
    !options?.signerId &&
    !options?.signerSecret &&
    !options?.keyQuorumId &&
    !options?.keyQuorumCredentials?.length
  ) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  if (options.signerId) headers["X-Steward-Signer-Id"] = options.signerId;
  if (options.signerSecret)
    headers["X-Steward-Signer-Secret"] = options.signerSecret;
  if (options.keyQuorumId)
    headers["X-Steward-Key-Quorum-Id"] = options.keyQuorumId;
  if (options.keyQuorumCredentials?.length) {
    headers["X-Steward-Key-Quorum-Credentials"] = JSON.stringify(
      options.keyQuorumCredentials,
    );
  }
  return headers;
}

export class LoginApiError<TData = unknown> extends Error {
  readonly status: number;
  readonly data?: TData;
  readonly mfaRequired: boolean;

  constructor(message: string, status: number, data?: TData) {
    super(message);
    this.name = "LoginApiError";
    this.status = status;
    this.data = data;
    this.mfaRequired =
      (typeof data === "object" &&
        data !== null &&
        "mfaRequired" in data &&
        (data as { mfaRequired?: unknown }).mfaRequired === true) ||
      errorMessageRequiresMfa(message);
  }
}

export function isLoginMfaRequiredError(
  error: unknown,
): error is LoginApiError<LoginMfaRequiredErrorData> {
  return error instanceof LoginApiError && error.mfaRequired;
}

export function isLoginBroadcastOutcomeUnknown(
  result: SignTransactionResult,
): result is LoginBroadcastOutcomeUnknown {
  return (
    "code" in result &&
    result.code === "external_broadcast_outcome_unknown" &&
    result.reconciliationRequired === true
  );
}

function isBrowserRuntime(): boolean {
  return (
    typeof globalThis.window !== "undefined" &&
    typeof globalThis.document !== "undefined"
  );
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;

function boundedPositiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new LoginApiError(
      `${name} must be a positive integer no greater than ${maximum}`,
      0,
    );
  }
  return resolved;
}

export class LoginClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly platformKey?: string;
  private readonly bearerToken?: string;
  private readonly tenantId?: string;
  private readonly requestSigningSecret?: string;
  private readonly requestSigningKeyId?: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBodyBytes: number;

  constructor({
    baseUrl,
    apiKey,
    appId,
    appSecret,
    platformKey,
    bearerToken,
    tenantId,
    requestSigningSecret,
    requestSigningKeyId,
    allowUnsafeBrowserSecrets,
    allowInsecureBaseUrl,
    requestTimeoutMs,
    maxResponseBodyBytes,
  }: LoginClientConfig) {
    if (
      isBrowserRuntime() &&
      !allowUnsafeBrowserSecrets &&
      (apiKey || appSecret || platformKey || requestSigningSecret)
    ) {
      throw new LoginApiError(
        "apiKey, appSecret, platformKey, and requestSigningSecret must not be used in browser runtimes; use bearerToken or set allowUnsafeBrowserSecrets only for audited local tools.",
        0,
      );
    }
    assertSecureBaseUrl(baseUrl, allowInsecureBaseUrl);
    this.baseUrl = stripTrailingSlashes(baseUrl);
    this.apiKey = apiKey;
    this.appId = appId;
    this.appSecret = appSecret;
    this.platformKey = platformKey;
    this.bearerToken = bearerToken;
    this.tenantId = tenantId;
    this.requestSigningSecret = requestSigningSecret;
    this.requestSigningKeyId = requestSigningKeyId;
    this.requestTimeoutMs = boundedPositiveInteger(
      "requestTimeoutMs",
      requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    );
    this.maxResponseBodyBytes = boundedPositiveInteger(
      "maxResponseBodyBytes",
      maxResponseBodyBytes,
      DEFAULT_MAX_RESPONSE_BODY_BYTES,
      MAX_RESPONSE_BODY_BYTES,
    );
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  readonly platformUsers = {
    create: async (
      input: PlatformUserCreateInput,
    ): Promise<PlatformUserCreateResult> => {
      const response = await this.request<
        PlatformUserCreateResult,
        LoginErrorResponse
      >("/platform/users", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },

    getIdentity: async (userId: string): Promise<PlatformUserIdentity> => {
      const response = await this.request<
        PlatformUserIdentity,
        LoginErrorResponse
      >(`/platform/users/${encodeURIComponent(userId)}`);
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return parsePlatformUserIdentity(response.data);
    },

    updateCustomMetadata: async (
      userId: string,
      customMetadata: Record<string, unknown>,
    ): Promise<PlatformUserIdentity> => {
      const response = await this.request<
        PlatformUserIdentity,
        LoginErrorResponse
      >(`/platform/users/${encodeURIComponent(userId)}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ customMetadata }),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return parsePlatformUserIdentity(response.data);
    },

    deactivate: async (
      userId: string,
      deactivated = true,
    ): Promise<PlatformUserDeactivateResult> => {
      const response = await this.request<
        PlatformUserDeactivateResult,
        LoginErrorResponse
      >(`/platform/users/${encodeURIComponent(userId)}/deactivate`, {
        method: "PATCH",
        body: JSON.stringify({ deactivated }),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return {
        ...response.data,
        deactivatedAt: response.data.deactivatedAt
          ? new Date(response.data.deactivatedAt)
          : null,
      };
    },

    delete: async (userId: string): Promise<PlatformUserDeleteResult> => {
      const response = await this.request<
        PlatformUserDeleteResult,
        LoginErrorResponse
      >(`/platform/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },

    lookup: async (opts: {
      email?: string;
      phone?: string;
      walletAddress?: string;
      walletExternalId?: string;
      smartWalletId?: string;
      customAuthId?: string;
      provider?: string;
      providerAccountId?: string;
      tenantId?: string;
    }): Promise<PlatformUserLookupResult> => {
      const params = new URLSearchParams();
      if (opts.email) params.set("email", opts.email);
      if (opts.phone) params.set("phone", opts.phone);
      if (opts.walletAddress) params.set("walletAddress", opts.walletAddress);
      if (opts.walletExternalId)
        params.set("walletExternalId", opts.walletExternalId);
      if (opts.smartWalletId) params.set("smartWalletId", opts.smartWalletId);
      if (opts.customAuthId) params.set("customAuthId", opts.customAuthId);
      if (opts.provider) params.set("provider", opts.provider);
      if (opts.providerAccountId)
        params.set("providerAccountId", opts.providerAccountId);
      if (opts.tenantId) params.set("tenantId", opts.tenantId);
      const response = await this.request<
        PlatformUserLookupResult,
        LoginErrorResponse
      >(`/platform/users/lookup?${params.toString()}`);
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return {
        user: response.data.user
          ? parsePlatformUserIdentity(response.data.user)
          : null,
      };
    },

    getUserByEmailAddress: async (
      email: string,
      opts?: { tenantId?: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({ email, tenantId: opts?.tenantId }),

    getUserByPhoneNumber: async (
      phone: string,
      opts?: { tenantId?: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({ phone, tenantId: opts?.tenantId }),

    getUserByWalletAddress: async (
      walletAddress: string,
      opts?: { tenantId?: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({ walletAddress, tenantId: opts?.tenantId }),

    getUserByWalletExternalId: async (
      walletExternalId: string,
      opts: { tenantId: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({ walletExternalId, tenantId: opts.tenantId }),

    getUserBySmartWalletAddress: async (
      smartWalletId: string,
      opts?: { tenantId?: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({ smartWalletId, tenantId: opts?.tenantId }),

    getUserByCustomAuthId: async (
      customAuthId: string,
      opts?: { tenantId?: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({ customAuthId, tenantId: opts?.tenantId }),

    getUserByProviderAccount: async (
      provider: string,
      providerAccountId: string,
      opts?: { tenantId?: string },
    ): Promise<PlatformUserLookupResult> =>
      this.platformUsers.lookup({
        provider,
        providerAccountId,
        tenantId: opts?.tenantId,
      }),

    getUserByDiscordUsername: async (
      username: string,
      opts?: { tenantId?: string },
    ) => this.platformUsers.getUserByProviderAccount("discord", username, opts),
    getUserByGithubUsername: async (
      username: string,
      opts?: { tenantId?: string },
    ) => this.platformUsers.getUserByProviderAccount("github", username, opts),
    getUserByFarcasterId: async (fid: string, opts?: { tenantId?: string }) =>
      this.platformUsers.getUserByProviderAccount("farcaster", fid, opts),
    getUserByInstagramUsername: async (
      username: string,
      opts?: { tenantId?: string },
    ) =>
      this.platformUsers.getUserByProviderAccount("instagram", username, opts),
    getUserBySpotifySubject: async (
      subject: string,
      opts?: { tenantId?: string },
    ) => this.platformUsers.getUserByProviderAccount("spotify", subject, opts),
    getUserByTelegramUserId: async (id: string, opts?: { tenantId?: string }) =>
      this.platformUsers.getUserByProviderAccount("telegram", id, opts),
    getUserByTelegramUsername: async (
      username: string,
      opts?: { tenantId?: string },
    ) =>
      this.platformUsers.getUserByProviderAccount("telegram", username, opts),
    getUserByTwitchUsername: async (
      username: string,
      opts?: { tenantId?: string },
    ) => this.platformUsers.getUserByProviderAccount("twitch", username, opts),
    getUserByTwitterSubject: async (
      subject: string,
      opts?: { tenantId?: string },
    ) => this.platformUsers.getUserByProviderAccount("twitter", subject, opts),
    getUserByTwitterUsername: async (
      username: string,
      opts?: { tenantId?: string },
    ) => this.platformUsers.getUserByProviderAccount("twitter", username, opts),

    search: async (
      tenantId: string,
      opts?: {
        q?: string;
        email?: string;
        walletExternalId?: string;
        limit?: number;
        offset?: number;
      },
    ): Promise<PlatformUserSearchResult> => {
      const params = new URLSearchParams();
      if (opts?.q) params.set("q", opts.q);
      if (opts?.email) params.set("email", opts.email);
      if (opts?.walletExternalId)
        params.set("walletExternalId", opts.walletExternalId);
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      const response = await this.request<
        PlatformUserSearchResult,
        LoginErrorResponse
      >(
        `/platform/tenants/${encodeURIComponent(tenantId)}/users${qs ? `?${qs}` : ""}`,
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return {
        ...response.data,
        users: response.data.users.map(parsePlatformTenantUser),
      };
    },

    get: async (
      tenantId: string,
      userId: string,
    ): Promise<PlatformTenantUser> => {
      const response = await this.request<
        PlatformTenantUser,
        LoginErrorResponse
      >(
        `/platform/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return parsePlatformTenantUser(response.data);
    },

    updateMetadata: async (
      tenantId: string,
      userId: string,
      metadata: {
        customMetadata?: Record<string, unknown>;
        tenantCustomMetadata?: Record<string, unknown>;
      },
    ): Promise<PlatformTenantUser> => {
      const response = await this.request<
        PlatformTenantUser,
        LoginErrorResponse
      >(
        `/platform/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/metadata`,
        {
          method: "PATCH",
          body: JSON.stringify(metadata),
        },
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return parsePlatformTenantUser(response.data);
    },

    listInvitations: async (
      tenantId: string,
      opts?: {
        status?: "pending" | "accepted" | "revoked" | "expired" | "all";
        limit?: number;
        offset?: number;
      },
    ): Promise<PlatformTenantInvitationListResult> => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      const response = await this.request<
        PlatformTenantInvitationListResult,
        LoginErrorResponse
      >(
        `/platform/tenants/${encodeURIComponent(tenantId)}/invitations${qs ? `?${qs}` : ""}`,
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return {
        invitations: response.data.invitations.map(
          parsePlatformTenantInvitation,
        ),
      };
    },

    createInvitation: async (
      tenantId: string,
      input: {
        email: string;
        role?: Exclude<TenantTeamRole, "owner"> | string;
        expiresInSeconds?: number;
        invitedByUserId?: string;
        sendEmail?: boolean;
      },
    ): Promise<PlatformTenantInvitationCreateResult> => {
      const response = await this.request<
        PlatformTenantInvitationCreateResult,
        LoginErrorResponse
      >(`/platform/tenants/${encodeURIComponent(tenantId)}/invitations`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return {
        token: response.data.token,
        emailSent: response.data.emailSent,
        invitation: parsePlatformTenantInvitation(response.data.invitation),
      };
    },

    revokeInvitation: async (
      tenantId: string,
      invitationId: string,
    ): Promise<void> => {
      const response = await this.request<
        Record<string, never>,
        LoginErrorResponse
      >(
        `/platform/tenants/${encodeURIComponent(tenantId)}/invitations/${encodeURIComponent(invitationId)}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
    },

    linkAccount: async (
      userId: string,
      input: { provider: string; providerAccountId: string; tenantId?: string },
    ): Promise<PlatformLinkAccountResult> => {
      const response = await this.request<
        PlatformLinkAccountResult,
        LoginErrorResponse
      >(`/platform/users/${encodeURIComponent(userId)}/accounts`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },

    unlinkAccount: async (
      userId: string,
      provider: string,
      providerAccountId: string,
      opts?: { force?: boolean },
    ): Promise<void> => {
      const params = new URLSearchParams();
      if (opts?.force) params.set("force", "true");
      const qs = params.toString();
      const response = await this.request<
        Record<string, never>,
        LoginErrorResponse
      >(
        `/platform/users/${encodeURIComponent(userId)}/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(providerAccountId)}${qs ? `?${qs}` : ""}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
    },

    transferAccount: async (
      fromUserId: string,
      provider: string,
      providerAccountId: string,
      input: { toUserId: string; force?: boolean },
    ): Promise<PlatformTransferAccountResult> => {
      const response = await this.request<
        PlatformTransferAccountResult,
        LoginErrorResponse
      >(
        `/platform/users/${encodeURIComponent(fromUserId)}/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(providerAccountId)}/transfer`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },

    assignWalletExternalId: async (
      userId: string,
      input: PlatformWalletExternalIdAssignInput,
    ): Promise<PlatformWalletExternalIdAssignResult> => {
      const response = await this.request<
        PlatformWalletExternalIdAssignResult,
        LoginErrorResponse
      >(`/platform/users/${encodeURIComponent(userId)}/wallet/external-id`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },

    resolveWalletExternalId: async (
      input: PlatformWalletExternalIdAssignInput,
    ): Promise<PlatformUserLookupResult> => {
      const response = await this.request<
        PlatformUserLookupResult,
        LoginErrorResponse
      >("/platform/users/wallet/external-id", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return {
        user: response.data.user
          ? parsePlatformUserIdentity(response.data.user)
          : null,
      };
    },

    connectOrCreateByWalletExternalId: async (
      input: PlatformWalletExternalIdConnectOrCreateInput,
    ): Promise<PlatformWalletExternalIdConnectOrCreateResult> => {
      const response = await this.request<
        PlatformWalletExternalIdConnectOrCreateResult,
        LoginErrorResponse
      >("/platform/users/wallet/external-id/connect-or-create", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },
  };

  readonly platformApps = {
    getGasSpend: async (input: {
      tenantId: string;
      walletIds?: string[];
      walletExternalIds?: string[];
      startTimestamp?: number;
      endTimestamp?: number;
    }): Promise<SponsoredGasSpendSummary> => {
      const params = new URLSearchParams();
      params.set("tenant_id", input.tenantId);
      if (input.walletIds?.length) {
        params.set("wallet_ids", input.walletIds.join(","));
      }
      if (input.walletExternalIds?.length) {
        params.set("wallet_external_ids", input.walletExternalIds.join(","));
      }
      if (input.startTimestamp !== undefined) {
        params.set("start_timestamp", String(input.startTimestamp));
      }
      if (input.endTimestamp !== undefined) {
        params.set("end_timestamp", String(input.endTimestamp));
      }
      const response = await this.request<
        SponsoredGasSpendSummary,
        LoginErrorResponse
      >(`/platform/apps/gas_spend?${params.toString()}`);
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data;
    },
  };

  readonly platformTestAccounts = {
    get: async (tenantId: string): Promise<TenantTestAccountConfig> => {
      const response = await this.request<
        { testAccount: TenantTestAccountConfig },
        LoginErrorResponse
      >(`/platform/tenants/${encodeURIComponent(tenantId)}/test-account`);
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data.testAccount;
    },

    enable: async (tenantId: string): Promise<TenantTestAccountConfig> => {
      const response = await this.request<
        { testAccount: TenantTestAccountConfig },
        LoginErrorResponse
      >(`/platform/tenants/${encodeURIComponent(tenantId)}/test-account`, {
        method: "POST",
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data.testAccount;
    },

    disable: async (tenantId: string): Promise<TenantTestAccountConfig> => {
      const response = await this.request<
        { testAccount: TenantTestAccountConfig },
        LoginErrorResponse
      >(`/platform/tenants/${encodeURIComponent(tenantId)}/test-account`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new LoginApiError(response.error, response.status, response.data);
      return response.data.testAccount;
    },
  };

  async createWallet(
    agentId: string,
    name: string,
    platformId?: string,
  ): Promise<CreateWalletResult> {
    const response = await this.request<AgentIdentity, LoginErrorResponse>(
      "/agents",
      {
        method: "POST",
        body: JSON.stringify({ id: agentId, name, platformId }),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return parseAgentIdentity(response.data);
  }

  async signTransaction(
    agentId: string,
    tx: SignTransactionInput,
    options?: SignTransactionOptions,
  ): Promise<SignTransactionResult> {
    const response = await this.request<
      { txHash: string },
      LoginPendingApproval | LoginBroadcastOutcomeUnknown | LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/sign`, {
      method: "POST",
      headers: signerHeaders(options),
      body: JSON.stringify(tx),
    });

    if (response.ok) {
      return response.data;
    }

    if (response.status === 202 && this.isPendingApproval(response.data)) {
      return response.data;
    }

    if (
      response.status === 202 &&
      this.isBroadcastOutcomeUnknown(response.data)
    ) {
      return response.data;
    }

    throw new LoginApiError(response.error, response.status, response.data);
  }

  async quoteTransfer(
    agentId: string,
    input: TransferActionQuoteInput,
  ): Promise<TransferActionQuote> {
    const response = await this.request<
      TransferActionQuote,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/actions/transfer/quote`, {
      method: "POST",
      body: JSON.stringify(input),
    });

    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async createTransferAction(
    agentId: string,
    input: TransferActionQuoteInput,
    options?: WalletActionOptions,
  ): Promise<TransferAction> {
    const response = await this.request<TransferAction, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/actions/transfer`,
      {
        method: "POST",
        headers: signerHeaders(options),
        body: JSON.stringify(input),
      },
    );

    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async createSendCallsAction(
    agentId: string,
    input: SendCallsActionInput,
    options?: WalletActionOptions,
  ): Promise<SendCallsAction> {
    const response = await this.request<SendCallsAction, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/actions/send-calls`,
      {
        method: "POST",
        headers: signerHeaders(options),
        body: JSON.stringify(input),
      },
    );

    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async getTransferAction(
    agentId: string,
    actionId: string,
  ): Promise<TransferAction> {
    const response = await this.request<TransferAction, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/actions/${encodeURIComponent(actionId)}`,
    );

    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async getPolicies(agentId: string): Promise<PolicyRule[]> {
    const response = await this.request<PolicyRule[], LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/policies`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Replace the policy set for an agent. Returns the stored policies
   * (with server-assigned ids where applicable).
   */
  async setPolicies(
    agentId: string,
    policies: PolicyRule[],
  ): Promise<PolicyRule[]> {
    const response = await this.request<
      PolicyRule[] | undefined,
      LoginErrorResponse
    >(`/agents/${encodeURIComponent(agentId)}/policies`, {
      method: "PUT",
      body: JSON.stringify(policies),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    // Older API builds returned no body; fall back to the input on void.
    return response.data ?? policies;
  }

  async listPolicyRules(agentId: string): Promise<PolicyRule[]> {
    const response = await this.request<
      { rules: PolicyRule[] },
      LoginErrorResponse
    >(`/agents/${encodeURIComponent(agentId)}/policies/rules`);

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data.rules;
  }

  async createPolicyRule(
    agentId: string,
    rule: AgentPolicyRuleCreate,
  ): Promise<PolicyRule> {
    const response = await this.request<PolicyRule, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/policies/rules`,
      {
        method: "POST",
        body: JSON.stringify(rule),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  async getPolicyRule(agentId: string, ruleId: string): Promise<PolicyRule> {
    const response = await this.request<PolicyRule, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/policies/rules/${encodeURIComponent(ruleId)}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  async updatePolicyRule(
    agentId: string,
    ruleId: string,
    update: AgentPolicyRuleUpdate,
  ): Promise<PolicyRule> {
    const response = await this.request<PolicyRule, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/policies/rules/${encodeURIComponent(ruleId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(update),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  async deletePolicyRule(agentId: string, ruleId: string): Promise<PolicyRule> {
    const response = await this.request<PolicyRule, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/policies/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  async getAgent(agentId: string): Promise<AgentIdentity> {
    const response = await this.request<AgentIdentity, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return parseAgentIdentity(response.data);
  }

  async listAgents(): Promise<AgentIdentity[]> {
    const response = await this.request<AgentIdentity[], LoginErrorResponse>(
      "/agents",
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data.map(parseAgentIdentity);
  }

  /**
   * Return a compact history feed for an agent. Each entry is a
   * `{ timestamp, value }` pair - suitable for trend charts and volume
   * windows. For the full signed-transaction objects, prefer
   * {@link getTransactionHistory}.
   */
  async getHistory(agentId: string): Promise<GetHistoryResult> {
    const records = await this.getTransactionHistory(agentId);
    return records.map((tx) => ({
      timestamp: Math.floor(
        (tx.createdAt instanceof Date
          ? tx.createdAt.getTime()
          : new Date(tx.createdAt).getTime()) / 1000,
      ),
      value: tx.request?.value ?? "0",
    }));
  }

  /**
   * Return the full transaction history for an agent as `TxRecord[]`.
   * Includes status, policy results, tx hash, timestamps, and the
   * original sign request.
   */
  async getTransactionHistory(agentId: string): Promise<TxRecord[]> {
    const response = await this.request<
      TxRecord[] | TransactionListResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/history`);

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    const records = Array.isArray(response.data)
      ? response.data
      : response.data.transactions;
    return records.map(parseTxRecord);
  }

  async listTransactions(
    agentId: string,
    opts?: {
      status?: string;
      actionType?: string;
      txHash?: string;
      referenceId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<TransactionListResult> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.actionType) params.set("actionType", opts.actionType);
    if (opts?.txHash) params.set("txHash", opts.txHash);
    if (opts?.referenceId) params.set("referenceId", opts.referenceId);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    const response = await this.request<
      TransactionListResult,
      LoginErrorResponse
    >(
      `/vault/${encodeURIComponent(agentId)}/transactions${qs ? `?${qs}` : ""}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return {
      ...response.data,
      transactions: response.data.transactions.map(parseTxRecord),
    };
  }

  async getTransaction(agentId: string, txId: string): Promise<TxRecord> {
    const response = await this.request<TxRecord, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/transactions/${encodeURIComponent(txId)}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return parseTxRecord(response.data);
  }

  async updateTransactionLifecycle(
    agentId: string,
    txId: string,
    input: TransactionLifecycleUpdateInput,
  ): Promise<TxRecord> {
    const response = await this.request<TxRecord, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/transactions/${encodeURIComponent(txId)}/lifecycle`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return parseTxRecord(response.data);
  }

  async replaceTransaction(
    agentId: string,
    txId: string,
    input: TransactionReplaceInput,
  ): Promise<TxRecord> {
    const response = await this.request<TxRecord, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/transactions/${encodeURIComponent(txId)}/replace`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return parseTxRecord(response.data);
  }

  async signMessage(
    agentId: string,
    message: string,
    options?: SignMessageOptions,
  ): Promise<SignMessageResult> {
    const response = await this.request<SignMessageResult, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/sign-message`,
      {
        method: "POST",
        headers: signerHeaders(options),
        body: JSON.stringify({ message }),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  async signRawHash(
    agentId: string,
    input: SignRawHashInput,
  ): Promise<SignRawHashResult> {
    const {
      signerId: _signerId,
      signerSecret: _signerSecret,
      keyQuorumId: _keyQuorumId,
      keyQuorumCredentials: _keyQuorumCredentials,
      ...body
    } = input;
    const response = await this.request<SignRawHashResult, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/sign-raw-hash`,
      {
        method: "POST",
        headers: signerHeaders(input),
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Sign EIP-712 typed data (`eth_signTypedData_v4`).
   * Used for DEX approvals, ERC-20 permits, and structured data signatures.
   */
  async signTypedData(
    agentId: string,
    input: SignTypedDataInput,
    options?: SignTypedDataOptions,
  ): Promise<SignTypedDataResult> {
    const response = await this.request<
      SignTypedDataResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/sign-typed-data`, {
      method: "POST",
      headers: signerHeaders(options),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Sign an ERC-4337 EntryPoint v0.7 user operation (`eth_signUserOperation`).
   * `to` and `value` are required for policy evaluation until calldata extraction is configured.
   */
  async signUserOperation(
    agentId: string,
    input: SignUserOperationInput,
    options?: SignUserOperationOptions,
  ): Promise<SignUserOperationResult> {
    const response = await this.request<
      SignUserOperationResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/sign-user-operation`, {
      method: "POST",
      headers: signerHeaders(options),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Sign an EIP-7702 set-code authorization for inclusion in an authorizationList.
   */
  async signAuthorization(
    agentId: string,
    input: SignAuthorizationInput,
    options?: SignAuthorizationOptions,
  ): Promise<SignAuthorizationResult> {
    const response = await this.request<
      SignAuthorizationResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/sign-authorization`, {
      method: "POST",
      headers: signerHeaders(options),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Sign a serialized Solana transaction.
   * Pass a base64-encoded transaction; optionally broadcast via Solana RPC.
   */
  async signSolanaTransaction(
    agentId: string,
    input: SignSolanaTransactionInput,
    options?: IdempotencyOptions,
  ): Promise<SignSolanaTransactionResult> {
    const response = await this.request<
      SignSolanaTransactionResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/sign-solana`, {
      method: "POST",
      headers: options?.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : undefined,
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Proxy a read-only RPC call to the appropriate chain provider.
   * Signing/state-modifying methods are blocked server-side.
   */
  async rpcPassthrough(
    agentId: string,
    input: RpcPassthroughInput,
  ): Promise<RpcPassthroughResult> {
    const response = await this.request<
      RpcPassthroughResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/rpc`, {
      method: "POST",
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Get the on-chain native balance for an agent wallet.
   * Optionally pass a chainId to query a specific network (defaults to the server's active chain).
   */
  async getBalance(
    agentId: string,
    chainId?: number,
  ): Promise<GetBalanceResult> {
    const params = chainId ? `?chainId=${chainId}` : "";
    const response = await this.request<AgentBalance, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/balance${params}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Get all wallet addresses for an agent across all chain families.
   * New agents have both EVM and Solana addresses; legacy agents have EVM only.
   */
  async getAddresses(agentId: string): Promise<GetAddressesResult> {
    const response = await this.request<GetAddressesResult, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/addresses`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Export the private keys for the authenticated user's personal wallet.
   * Requires a user session token (Bearer JWT).
   */
  async exportUserWalletKey(
    input: UserWalletSelector = {},
  ): Promise<ExportKeyResult> {
    const response = await this.request<ExportKeyResult, LoginErrorResponse>(
      "/user/me/wallet/export",
      {
        method: "POST",
        body:
          input.walletIndex === undefined
            ? undefined
            : JSON.stringify({ walletIndex: input.walletIndex }),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Initialize a one-time encrypted private-key import session for the
   * authenticated user's embedded wallet. Requires a personal user session with
   * recent MFA and the audited import feature flags.
   */
  async initializeEncryptedUserWalletKeyImport(
    chain: "evm" | "solana",
    input: UserWalletSelector = {},
  ): Promise<EncryptedUserWalletKeyImportInitResult> {
    const response = await this.request<
      EncryptedUserWalletKeyImportInitResult,
      LoginErrorResponse
    >("/user/me/wallet/import/init", {
      method: "POST",
      body: JSON.stringify({
        chain,
        ...(input.walletIndex === undefined
          ? {}
          : { walletIndex: input.walletIndex }),
      }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Submit an encrypted private-key import envelope for the authenticated user's
   * embedded wallet. Plaintext privateKey fields are rejected by the API.
   */
  async submitEncryptedUserWalletKeyImport(
    input: EncryptedUserWalletKeyImportSubmitInput,
  ): Promise<EncryptedUserWalletKeyImportResult> {
    const response = await this.request<
      EncryptedUserWalletKeyImportResult,
      LoginErrorResponse
    >("/user/me/wallet/import/submit", {
      method: "POST",
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Get the authenticated user's embedded wallet native balance.
   * Requires a personal user session token (Bearer JWT).
   */
  async getUserWallet(
    input?: number | UserWalletBalanceInput,
  ): Promise<GetBalanceResult> {
    const params = new URLSearchParams();
    if (typeof input === "number") {
      params.set("chainId", String(input));
    } else if (input) {
      if (input.chainId !== undefined)
        params.set("chainId", String(input.chainId));
      if (input.walletIndex !== undefined)
        params.set("walletIndex", String(input.walletIndex));
    }
    const qs = params.toString();
    const response = await this.request<AgentBalance, LoginErrorResponse>(
      `/user/me/wallet${qs ? `?${qs}` : ""}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** Privy-style alias for the authenticated user's embedded wallet balance. */
  async getUserWalletBalance(
    input?: number | UserWalletBalanceInput,
  ): Promise<GetBalanceResult> {
    return this.getUserWallet(input);
  }

  /**
   * Provision the authenticated user's embedded wallet if needed.
   * Requires a personal user session token (Bearer JWT).
   */
  async createUserWallet(
    input: UserWalletSelector = {},
  ): Promise<UserWalletCreateResult> {
    const response = await this.request<
      UserWalletCreateResult,
      LoginErrorResponse
    >("/user/me/wallet", {
      method: "POST",
      body:
        input.walletIndex === undefined
          ? undefined
          : JSON.stringify({ walletIndex: input.walletIndex }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** Privy-style alias for authenticated user-wallet provisioning. */
  async provisionUserWallet(
    input: UserWalletSelector = {},
  ): Promise<UserWalletCreateResult> {
    return this.createUserWallet(input);
  }

  /**
   * Provision the authenticated user's wallet from a one-time BIP-39 recovery
   * phrase. Requires a user session token with recent MFA and only works before
   * a user wallet already exists.
   */
  async setupUserWalletRecovery(
    input: UserWalletSelector = {},
  ): Promise<UserWalletRecoverySetupResult> {
    const response = await this.request<
      UserWalletRecoverySetupResult,
      LoginErrorResponse
    >("/user/me/wallet/recovery/setup", {
      method: "POST",
      body:
        input.walletIndex === undefined
          ? undefined
          : JSON.stringify({ walletIndex: input.walletIndex }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Restore/import the authenticated user's mnemonic-backed wallet. Requires a
   * user session with recent MFA. The mnemonic is sent once and is never returned.
   */
  async restoreUserWalletRecovery(input: {
    mnemonic: string;
    walletIndex?: number;
  }): Promise<UserWalletRecoveryRestoreResult> {
    const response = await this.request<
      UserWalletRecoveryRestoreResult,
      LoginErrorResponse
    >("/user/me/wallet/recovery/restore", {
      method: "POST",
      body: JSON.stringify({
        mnemonic: input.mnemonic,
        ...(input.walletIndex === undefined
          ? {}
          : { walletIndex: input.walletIndex }),
      }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Claim a tenant-admin pregenerated wallet for the authenticated user.
   * Requires a personal user session with recent MFA and no existing user wallet.
   */
  async claimPregeneratedUserWallet(input: {
    tenantId: string;
    claimToken: string;
    walletIndex?: number;
  }): Promise<PregeneratedUserWalletClaimResult> {
    const response = await this.request<
      PregeneratedUserWalletClaimResult,
      LoginErrorResponse
    >("/user/me/wallet/claim-pregenerated", {
      method: "POST",
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /**
   * Sign a native transfer with the authenticated user's embedded wallet.
   * Broadcast requests require an idempotency key server-side.
   */
  async signUserWalletTransaction(
    input: SignTransactionInput & UserWalletSelector,
    options?: { idempotencyKey?: string },
  ): Promise<UserWalletSignResult> {
    const response = await this.request<
      UserWalletSignResult,
      LoginErrorResponse
    >("/user/me/wallet/sign", {
      method: "POST",
      headers: options?.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : undefined,
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** Sign a message with the authenticated user's embedded wallet when server-side unsafe signing is enabled. */
  async signUserWalletMessage(
    message: string,
    input: UserWalletSelector = {},
  ): Promise<UserWalletSignMessageResult> {
    const response = await this.request<
      UserWalletSignMessageResult,
      LoginErrorResponse
    >("/user/me/wallet/sign-message", {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(input.walletIndex === undefined
          ? {}
          : { walletIndex: input.walletIndex }),
      }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** List the authenticated user's embedded-wallet transaction history. */
  async getUserWalletHistory(opts?: {
    limit?: number;
    offset?: number;
    walletIndex?: number;
  }): Promise<UserWalletHistoryResult> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.walletIndex !== undefined)
      params.set("walletIndex", String(opts.walletIndex));
    const qs = params.toString();
    const response = await this.request<
      UserWalletHistoryResult,
      LoginErrorResponse
    >(`/user/me/wallet/history${qs ? `?${qs}` : ""}`);

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return {
      ...response.data,
      transactions: response.data.transactions.map(parseTxRecord),
    };
  }

  /** Get active/default policy rules for the authenticated user's embedded wallet. */
  async getUserWalletPolicies(
    input: UserWalletSelector = {},
  ): Promise<PolicyRule[]> {
    const params = new URLSearchParams();
    if (input.walletIndex !== undefined)
      params.set("walletIndex", String(input.walletIndex));
    const qs = params.toString();
    const response = await this.request<PolicyRule[], LoginErrorResponse>(
      `/user/me/wallet/policies${qs ? `?${qs}` : ""}`,
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** List additional signer credentials for the authenticated user's embedded wallet. */
  async listUserWalletSigners(
    input: UserWalletSelector & { status?: AgentSignerStatus } = {},
  ): Promise<UserWalletSigner[]> {
    const params = new URLSearchParams();
    if (input.walletIndex !== undefined)
      params.set("walletIndex", String(input.walletIndex));
    if (input.status) params.set("status", input.status);
    const qs = params.toString();
    const response = await this.request<
      { signers: UserWalletSigner[] },
      LoginErrorResponse
    >(`/user/me/wallet/signers${qs ? `?${qs}` : ""}`);

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data.signers;
  }

  /**
   * Create a server-issued signer credential for the authenticated user's embedded wallet.
   * The returned credentialSecret is shown once.
   */
  async createUserWalletSigner(
    input: UserWalletSignerCreate = {},
  ): Promise<UserWalletSignerCreateResult> {
    const { walletIndex, ...body } = input;
    const response = await this.request<
      UserWalletSignerCreateResult,
      LoginErrorResponse
    >("/user/me/wallet/signers", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        ...(walletIndex === undefined ? {} : { walletIndex }),
      }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** Revoke an additional signer credential on the authenticated user's embedded wallet. */
  async revokeUserWalletSigner(
    signerId: string,
    input: UserWalletSelector = {},
  ): Promise<UserWalletSigner> {
    const params = new URLSearchParams();
    if (input.walletIndex !== undefined)
      params.set("walletIndex", String(input.walletIndex));
    const qs = params.toString();
    const response = await this.request<UserWalletSigner, LoginErrorResponse>(
      `/user/me/wallet/signers/${encodeURIComponent(signerId)}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** List linked accounts for the authenticated user. Requires user JWT. */
  async listUserAccounts(): Promise<UserAccountsResult> {
    const response = await this.request<UserAccountsResult, LoginErrorResponse>(
      "/user/me/accounts",
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Get the authenticated user's aggregated account, wallets, portfolio, and spend. */
  async getUserAccount(
    opts: { chainId?: number; tokens?: string[] } = {},
  ): Promise<UserAccountSummary> {
    const params = new URLSearchParams();
    if (opts.chainId) params.set("chainId", String(opts.chainId));
    if (opts.tokens?.length) params.set("tokens", opts.tokens.join(","));
    const qs = params.toString();
    const response = await this.request<UserAccountSummary, LoginErrorResponse>(
      `/user/me/account${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Privy-style alias for the authenticated user's aggregated account summary. */
  async getUserAccountAggregation(
    opts: { chainId?: number; tokens?: string[] } = {},
  ): Promise<UserAccountSummary> {
    const params = new URLSearchParams();
    if (opts.chainId) params.set("chainId", String(opts.chainId));
    if (opts.tokens?.length) params.set("tokens", opts.tokens.join(","));
    const qs = params.toString();
    const response = await this.request<UserAccountSummary, LoginErrorResponse>(
      `/user/me/aggregation${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List active push subscriptions for the authenticated user. Requires user JWT. */
  async listUserPushSubscriptions(): Promise<UserPushSubscriptionListResult> {
    const response = await this.request<
      UserPushSubscriptionListResult,
      LoginErrorResponse
    >("/user/me/push-subscriptions");
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Register or refresh a push subscription for the authenticated user. Requires user JWT. */
  async registerUserPushSubscription(
    input: UserPushSubscriptionInput,
  ): Promise<UserPushSubscriptionResult> {
    const response = await this.request<
      UserPushSubscriptionResult,
      LoginErrorResponse
    >("/user/me/push-subscriptions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Revoke a push subscription for the authenticated user. Requires user JWT. */
  async revokeUserPushSubscription(
    subscriptionId: string,
  ): Promise<UserPushSubscriptionResult> {
    const response = await this.request<
      UserPushSubscriptionResult,
      LoginErrorResponse
    >(`/user/me/push-subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Preview a global-wallet consent request for a tenant app. Requires user JWT. */
  async getGlobalWalletConsentRequest(input: {
    appId: string;
    origin?: string;
    redirectUri?: string;
    scopes?: string[];
    walletIndex?: number;
  }): Promise<GlobalWalletConsentRequest> {
    const params = new URLSearchParams({ app_id: input.appId });
    if (input.origin) params.set("origin", input.origin);
    if (input.redirectUri) params.set("redirect_uri", input.redirectUri);
    if (input.walletIndex !== undefined)
      params.set("wallet_index", String(input.walletIndex));
    for (const scope of input.scopes ?? []) params.append("scope", scope);
    const response = await this.request<
      GlobalWalletConsentRequest,
      LoginErrorResponse
    >(`/global-wallet/consent/request?${params.toString()}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Approve global-wallet access for a tenant app. Requires user JWT with recent MFA. */
  async approveGlobalWalletConsent(input: {
    appId: string;
    origin?: string;
    redirectUri?: string;
    scopes?: string[];
    walletIndex?: number;
  }): Promise<GlobalWalletApproveResult> {
    const response = await this.request<
      GlobalWalletApproveResult,
      LoginErrorResponse
    >("/global-wallet/consent/approve", {
      method: "POST",
      body: JSON.stringify({
        app_id: input.appId,
        origin: input.origin,
        redirect_uri: input.redirectUri,
        scopes: input.scopes,
        wallet_index: input.walletIndex,
      }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List global-wallet app consents for the authenticated user. Requires user JWT. */
  async listGlobalWalletConsents(): Promise<{
    consents: GlobalWalletConsent[];
  }> {
    const response = await this.request<
      { consents: GlobalWalletConsent[] },
      LoginErrorResponse
    >("/global-wallet/consents");
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Revoke a global-wallet app consent. Requires user JWT with recent MFA. */
  async revokeGlobalWalletConsent(
    consentId: string,
  ): Promise<{ consent: GlobalWalletConsent }> {
    const response = await this.request<
      { consent: GlobalWalletConsent },
      LoginErrorResponse
    >(`/global-wallet/consents/${encodeURIComponent(consentId)}/revoke`, {
      method: "POST",
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Call the global-wallet RPC bridge. Write methods require explicit server-side enablement. */
  async confirmGlobalWalletAction(input: {
    appId: string;
    origin?: string;
    method:
      | "personal_sign"
      | "eth_signTypedData_v4"
      | "eth_sendTransaction"
      | string;
    params?: unknown;
    walletIndex?: number;
  }): Promise<GlobalWalletActionConfirmation> {
    const response = await this.request<
      GlobalWalletActionConfirmation,
      LoginErrorResponse
    >("/global-wallet/rpc/confirm", {
      method: "POST",
      body: JSON.stringify({
        app_id: input.appId,
        origin: input.origin,
        method: input.method,
        params: input.params,
        wallet_index: input.walletIndex,
      }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Scan a global-wallet transaction request before confirming/executing it. */
  async scanGlobalWalletTransaction(input: {
    appId: string;
    origin?: string;
    method?: "eth_sendTransaction";
    params: unknown;
    walletIndex?: number;
  }): Promise<GlobalWalletTransactionScan> {
    const response = await this.request<
      GlobalWalletTransactionScan,
      LoginErrorResponse
    >("/global-wallet/rpc/scan", {
      method: "POST",
      body: JSON.stringify({
        app_id: input.appId,
        origin: input.origin,
        method: input.method ?? "eth_sendTransaction",
        params: input.params,
        wallet_index: input.walletIndex,
      }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Call the global-wallet RPC bridge. Write methods require a one-time action confirmation. */
  async globalWalletRpc<T = unknown>(input: {
    appId: string;
    origin?: string;
    method: string;
    params?: unknown;
    confirmationId?: string;
    id?: unknown;
    jsonrpc?: string;
    walletIndex?: number;
  }): Promise<GlobalWalletRpcResult<T>> {
    const response = await this.request<
      GlobalWalletRpcResult<T>,
      LoginErrorResponse
    >("/global-wallet/rpc", {
      method: "POST",
      body: JSON.stringify({
        app_id: input.appId,
        origin: input.origin,
        method: input.method,
        params: input.params,
        confirmation_id: input.confirmationId,
        id: input.id,
        jsonrpc: input.jsonrpc,
        wallet_index: input.walletIndex,
      }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Create a one-time message for linking an Ethereum wallet to the authenticated user. */
  async createUserEthereumWalletLinkNonce(
    address?: string,
  ): Promise<UserEthereumWalletLinkNonce> {
    const response = await this.request<
      UserEthereumWalletLinkNonce,
      LoginErrorResponse
    >("/user/me/accounts/wallet/ethereum/nonce", {
      method: "POST",
      body: JSON.stringify(address ? { address } : {}),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Link an Ethereum wallet to the authenticated user using the signed nonce message. */
  async linkUserEthereumWallet(input: {
    address: string;
    message: string;
    signature: string;
  }): Promise<UserEthereumWalletLinkResult> {
    const response = await this.request<
      UserEthereumWalletLinkResult,
      LoginErrorResponse
    >("/user/me/accounts/wallet/ethereum", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Create a one-time message for linking a Solana wallet to the authenticated user. */
  async createUserSolanaWalletLinkNonce(
    publicKey?: string,
  ): Promise<UserSolanaWalletLinkNonce> {
    const response = await this.request<
      UserSolanaWalletLinkNonce,
      LoginErrorResponse
    >("/user/me/accounts/wallet/solana/nonce", {
      method: "POST",
      body: JSON.stringify(publicKey ? { publicKey } : {}),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Link a Solana wallet to the authenticated user using the signed nonce message. */
  async linkUserSolanaWallet(input: {
    publicKey: string;
    message: string;
    signature: string;
  }): Promise<UserSolanaWalletLinkResult> {
    const response = await this.request<
      UserSolanaWalletLinkResult,
      LoginErrorResponse
    >("/user/me/accounts/wallet/solana", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Create a one-time state challenge for linking an OAuth account. */
  async createUserOAuthAccountLinkChallenge(
    provider: string,
    input: {
      redirectUri: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    },
  ): Promise<UserOAuthAccountLinkChallenge> {
    const response = await this.request<
      UserOAuthAccountLinkChallenge,
      LoginErrorResponse
    >(`/user/me/accounts/oauth/${encodeURIComponent(provider)}/challenge`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Link an OAuth account to the authenticated user using an authorization code and state. */
  async linkUserOAuthAccount(
    provider: string,
    input: {
      code: string;
      redirectUri: string;
      state: string;
      codeVerifier?: string;
    },
  ): Promise<UserOAuthAccountLinkResult> {
    const response = await this.request<
      UserOAuthAccountLinkResult,
      LoginErrorResponse
    >(`/user/me/accounts/oauth/${encodeURIComponent(provider)}/token`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Send an OTP for linking a phone number to the authenticated user. */
  async sendUserPhoneAccountLinkOtp(
    phone: string,
    channel: "sms" | "whatsapp" = "sms",
  ): Promise<UserPhoneAccountLinkSendResult> {
    const response = await this.request<
      UserPhoneAccountLinkSendResult,
      LoginErrorResponse
    >(`/user/me/accounts/phone/${channel}/send`, {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Verify an OTP and link a phone number to the authenticated user. */
  async verifyUserPhoneAccountLinkOtp(
    input: { phone: string; code: string },
    channel: "sms" | "whatsapp" = "sms",
  ): Promise<UserPhoneAccountLinkResult> {
    const response = await this.request<
      UserPhoneAccountLinkResult,
      LoginErrorResponse
    >(`/user/me/accounts/phone/${channel}/verify`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Link a Telegram Login Widget account to the authenticated user. */
  async createUserTelegramAccountLinkChallenge(): Promise<UserSocialAccountLinkChallenge> {
    const response = await this.request<
      UserSocialAccountLinkChallenge,
      LoginErrorResponse
    >("/user/me/accounts/telegram/challenge", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Link a Telegram Login Widget account to the authenticated user. */
  async linkUserTelegramAccount(
    input: Record<string, unknown>,
  ): Promise<UserSocialAccountLinkResult> {
    const response = await this.request<
      UserSocialAccountLinkResult,
      LoginErrorResponse
    >("/user/me/accounts/telegram", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Create a one-time nonce for linking a Farcaster account to the authenticated user. */
  async createUserFarcasterAccountLinkNonce(): Promise<UserSocialAccountLinkChallenge> {
    const response = await this.request<
      UserSocialAccountLinkChallenge,
      LoginErrorResponse
    >("/user/me/accounts/farcaster/nonce", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Link a Farcaster SIWF account to the authenticated user. */
  async linkUserFarcasterAccount(input: {
    message: string;
    signature: string;
    custodyAddress?: string;
    address?: string;
    fid?: string | number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
    pfp?: string;
  }): Promise<UserSocialAccountLinkResult> {
    const response = await this.request<
      UserSocialAccountLinkResult,
      LoginErrorResponse
    >("/user/me/accounts/farcaster", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Unlink a linked account from the authenticated user. Requires another login method. */
  async unlinkUserAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<UserAccountUnlinkResult> {
    const response = await this.request<
      UserAccountUnlinkResult,
      LoginErrorResponse
    >(
      `/user/me/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(providerAccountId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /**
   * Export the private keys for a vault agent.
   * Requires tenant-level authentication.
   */
  async exportAgentKey(agentId: string): Promise<ExportKeyResult> {
    const response = await this.request<ExportKeyResult, LoginErrorResponse>(
      `/vault/${encodeURIComponent(agentId)}/export`,
      { method: "POST" },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** Initialize a one-time encrypted private-key import session for a vault agent. */
  async initializeEncryptedAgentKeyImport(
    agentId: string,
    chain: "evm" | "solana",
  ): Promise<EncryptedAgentKeyImportInitResult> {
    const response = await this.request<
      EncryptedAgentKeyImportInitResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/import/init`, {
      method: "POST",
      body: JSON.stringify({ chain }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  /** Submit an encrypted private-key import envelope for a vault agent. */
  async submitEncryptedAgentKeyImport(
    agentId: string,
    input: EncryptedAgentKeyImportSubmitInput,
  ): Promise<EncryptedAgentKeyImportResult> {
    const response = await this.request<
      EncryptedAgentKeyImportResult,
      LoginErrorResponse
    >(`/vault/${encodeURIComponent(agentId)}/import/submit`, {
      method: "POST",
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return response.data;
  }

  // ─── Tenant Config ─────────────────────────────────────────────

  /** Get the control-plane configuration for a tenant. */
  async getTenantConfig(tenantId: string): Promise<TenantControlPlaneConfig> {
    const response = await this.request<
      TenantControlPlaneConfig,
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/config`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Update the control-plane configuration for a tenant. */
  async updateTenantConfig(
    tenantId: string,
    config: Partial<TenantControlPlaneConfig>,
  ): Promise<TenantControlPlaneConfig> {
    const response = await this.request<
      TenantControlPlaneConfig,
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/config`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List tenant app origins used for CORS, passkeys, SIWE/SIWS, and OAuth redirects. */
  async listAppOrigins(tenantId: string): Promise<string[]> {
    const response = await this.request<
      { entries: string[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/app-origins`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Add one or more tenant app origins. Requires tenant-admin MFA server-side. */
  async addAppOrigin(tenantId: string, origin: string): Promise<string[]> {
    return this.addAppOrigins(tenantId, [origin]);
  }

  /** Add one or more tenant app origins. Requires tenant-admin MFA server-side. */
  async addAppOrigins(tenantId: string, origins: string[]): Promise<string[]> {
    const response = await this.request<
      { entries: string[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/app-origins`, {
      method: "POST",
      body: JSON.stringify({ origins }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Remove one tenant app origin. Requires tenant-admin MFA server-side. */
  async removeAppOrigin(tenantId: string, origin: string): Promise<string[]> {
    return this.removeAppOrigins(tenantId, [origin]);
  }

  /** Remove one or more tenant app origins. Requires tenant-admin MFA server-side. */
  async removeAppOrigins(
    tenantId: string,
    origins: string[],
  ): Promise<string[]> {
    const response = await this.request<
      { entries: string[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/app-origins`, {
      method: "DELETE",
      body: JSON.stringify({ origins }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** List tenant redirect URLs used for OAuth and email auth callbacks. */
  async listRedirectUrls(tenantId: string): Promise<string[]> {
    const response = await this.request<
      { entries: string[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/redirect-urls`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Add one tenant redirect URL. Requires tenant-admin MFA server-side. */
  async addRedirectUrl(tenantId: string, url: string): Promise<string[]> {
    return this.addRedirectUrls(tenantId, [url]);
  }

  /** Add one or more tenant redirect URLs. Requires tenant-admin MFA server-side. */
  async addRedirectUrls(tenantId: string, urls: string[]): Promise<string[]> {
    const response = await this.request<
      { entries: string[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/redirect-urls`, {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Remove one tenant redirect URL. Requires tenant-admin MFA server-side. */
  async removeRedirectUrl(tenantId: string, url: string): Promise<string[]> {
    return this.removeRedirectUrls(tenantId, [url]);
  }

  /** Remove one or more tenant redirect URLs. Requires tenant-admin MFA server-side. */
  async removeRedirectUrls(
    tenantId: string,
    urls: string[],
  ): Promise<string[]> {
    const response = await this.request<
      { entries: string[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/redirect-urls`, {
      method: "DELETE",
      body: JSON.stringify({ urls }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** List tenant app clients/environments. Requires tenant-admin MFA server-side. */
  async listTenantAppClients(tenantId: string): Promise<TenantAppClient[]> {
    const response = await this.request<
      { clients: TenantAppClient[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/app-clients`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.clients;
  }

  /** Replace the tenant app client/environment registry. Requires tenant-admin MFA server-side. */
  async replaceTenantAppClients(
    tenantId: string,
    clients: TenantAppClient[],
  ): Promise<TenantAppClient[]> {
    const response = await this.request<
      { clients: TenantAppClient[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/app-clients`, {
      method: "PUT",
      body: JSON.stringify({ clients }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.clients;
  }

  /** Create one tenant app client/environment. Requires tenant-admin MFA server-side. */
  async createTenantAppClient(
    tenantId: string,
    client: TenantAppClient,
  ): Promise<TenantAppClient> {
    const response = await this.request<
      { client: TenantAppClient },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/app-clients`, {
      method: "POST",
      body: JSON.stringify({ client }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.client;
  }

  /** Delete one tenant app client/environment. Requires tenant-admin MFA server-side. */
  async deleteTenantAppClient(
    tenantId: string,
    clientId: string,
  ): Promise<TenantAppClient[]> {
    const response = await this.request<
      { clients: TenantAppClient[] },
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/app-clients/${encodeURIComponent(clientId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.clients;
  }

  /** List app-client secret metadata. Raw secrets are never returned by this endpoint. */
  async listTenantAppClientSecrets(
    tenantId: string,
    clientId: string,
  ): Promise<{ appId: string; secrets: TenantAppClientSecret[] }> {
    const response = await this.request<
      { appId: string; secrets: TenantAppClientSecret[] },
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/app-clients/${encodeURIComponent(clientId)}/secrets`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Rotate an app-client secret. Returns the raw appSecret once. */
  async rotateTenantAppClientSecret(
    tenantId: string,
    clientId: string,
  ): Promise<TenantAppClientSecretCreateResult> {
    const response = await this.request<
      TenantAppClientSecretCreateResult,
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/app-clients/${encodeURIComponent(clientId)}/secrets`,
      { method: "POST" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Revoke one app-client secret immediately. */
  async revokeTenantAppClientSecret(
    tenantId: string,
    clientId: string,
    secretId: string,
  ): Promise<TenantAppClientSecret> {
    const response = await this.request<
      { secret: TenantAppClientSecret },
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/app-clients/${encodeURIComponent(
        clientId,
      )}/secrets/${encodeURIComponent(secretId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.secret;
  }

  /** List tenant app access allowlist entries for email, domain, wallet, and phone login. */
  async listAccessAllowlistEntries(
    tenantId: string,
  ): Promise<TenantAccessAllowlistEntry[]> {
    const response = await this.request<
      { entries: TenantAccessAllowlistEntry[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/access-allowlist`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Add one tenant app access allowlist entry. Requires tenant-admin MFA server-side. */
  async addAccessAllowlistEntry(
    tenantId: string,
    entry: TenantAccessAllowlistEntryInput,
  ): Promise<TenantAccessAllowlistEntry[]> {
    return this.addAccessAllowlistEntries(tenantId, [entry]);
  }

  /** Add one or more tenant app access allowlist entries. Requires tenant-admin MFA server-side. */
  async addAccessAllowlistEntries(
    tenantId: string,
    entries: TenantAccessAllowlistEntryInput[],
  ): Promise<TenantAccessAllowlistEntry[]> {
    const response = await this.request<
      { entries: TenantAccessAllowlistEntry[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/access-allowlist`, {
      method: "POST",
      body: JSON.stringify({ entries }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Remove one tenant app access allowlist entry. Requires tenant-admin MFA server-side. */
  async removeAccessAllowlistEntry(
    tenantId: string,
    entry: TenantAccessAllowlistEntryInput | { id: string },
  ): Promise<TenantAccessAllowlistEntry[]> {
    if ("id" in entry) {
      return this.removeAccessAllowlistEntries(tenantId, { ids: [entry.id] });
    }
    return this.removeAccessAllowlistEntries(tenantId, { entries: [entry] });
  }

  /** Remove tenant app access allowlist entries by id or by type/value pair. */
  async removeAccessAllowlistEntries(
    tenantId: string,
    input: { ids?: string[]; entries?: TenantAccessAllowlistEntryInput[] },
  ): Promise<TenantAccessAllowlistEntry[]> {
    const response = await this.request<
      { entries: TenantAccessAllowlistEntry[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/access-allowlist`, {
      method: "DELETE",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.entries;
  }

  /** Get tenant-scoped OIDC/JWT login provider configuration. */
  async getTenantOidcProviders(
    tenantId: string,
  ): Promise<TenantOidcProviderConfig[]> {
    const response = await this.request<
      { providers: TenantOidcProviderConfig[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/oidc-providers`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.providers;
  }

  /** Discover whether an email domain should route to tenant SSO. */
  async discoverSso(email: string): Promise<SsoDiscoveryResult> {
    const response = await this.request<SsoDiscoveryResult, LoginErrorResponse>(
      "/auth/sso/discover",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List tenant verified/draft SSO email domains. Requires tenant-admin MFA server-side. */
  async listTenantSsoDomains(tenantId: string): Promise<TenantSsoDomain[]> {
    const response = await this.request<
      { domains: TenantSsoDomain[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/sso-domains`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.domains;
  }

  /** Create or reset a tenant SSO email-domain verification token. */
  async createTenantSsoDomain(
    tenantId: string,
    input: { domain: string; ssoRequired?: boolean },
  ): Promise<TenantSsoDomain> {
    const response = await this.request<
      { domain: TenantSsoDomain },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/sso-domains`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.domain;
  }

  /** Mark a tenant SSO domain verified after out-of-band DNS/manual verification. */
  async verifyTenantSsoDomain(
    tenantId: string,
    domain: string,
  ): Promise<TenantSsoDomain> {
    const response = await this.request<
      { domain: TenantSsoDomain },
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/sso-domains/${encodeURIComponent(domain)}/verify`,
      { method: "POST" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.domain;
  }

  /** Delete a tenant SSO domain. */
  async deleteTenantSsoDomain(tenantId: string, domain: string): Promise<void> {
    const response = await this.request<
      { deleted: boolean },
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/sso-domains/${encodeURIComponent(domain)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
  }

  /** Get tenant SAML dashboard/team SSO config and generated SP URLs. */
  async getTenantSamlSso(tenantId: string): Promise<{
    config: TenantSamlSsoConfig | null;
    serviceProvider: {
      spEntityId: string;
      acsUrl: string;
      metadataUrl: string;
    };
  }> {
    const response = await this.request<
      {
        config: TenantSamlSsoConfig | null;
        serviceProvider: {
          spEntityId: string;
          acsUrl: string;
          metadataUrl: string;
        };
      },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/saml-sso`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Replace tenant SAML dashboard/team SSO config. Requires tenant-admin MFA server-side. */
  async updateTenantSamlSso(
    tenantId: string,
    input: TenantSamlSsoUpdate,
  ): Promise<TenantSamlSsoConfig> {
    const response = await this.request<
      { config: TenantSamlSsoConfig },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/saml-sso`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.config;
  }

  /** Delete tenant SAML dashboard/team SSO config. */
  async deleteTenantSamlSso(tenantId: string): Promise<void> {
    const response = await this.request<
      { deleted: boolean },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/saml-sso`, {
      method: "DELETE",
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
  }

  /** Replace tenant-scoped OIDC/JWT login provider configuration. */
  async updateTenantOidcProviders(
    tenantId: string,
    providers: TenantOidcProviderConfig[],
  ): Promise<TenantOidcProviderConfig[]> {
    const response = await this.request<
      { providers: TenantOidcProviderConfig[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/oidc-providers`, {
      method: "PUT",
      body: JSON.stringify({ providers }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.providers;
  }

  /** Get tenant-scoped auth abuse and login method controls. */
  async getTenantAuthAbuseConfig(
    tenantId: string,
  ): Promise<TenantAuthAbuseConfig> {
    const response = await this.request<
      { authAbuseConfig: TenantAuthAbuseConfig },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/auth-abuse-config`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.authAbuseConfig;
  }

  /** Replace tenant-scoped auth abuse and login method controls. */
  async updateTenantAuthAbuseConfig(
    tenantId: string,
    authAbuseConfig: TenantAuthAbuseConfig,
  ): Promise<TenantAuthAbuseConfig> {
    const response = await this.request<
      { authAbuseConfig: TenantAuthAbuseConfig },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/auth-abuse-config`, {
      method: "PUT",
      body: JSON.stringify({ authAbuseConfig }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.authAbuseConfig;
  }

  /** Get tenant gas sponsorship/paymaster configuration. */
  async getTenantGasSponsorshipConfig(
    tenantId: string,
  ): Promise<TenantGasSponsorshipConfig> {
    const response = await this.request<
      { gasSponsorshipConfig: TenantGasSponsorshipConfig },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/gas-sponsorship`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.gasSponsorshipConfig;
  }

  /** Replace tenant gas sponsorship/paymaster configuration. Requires tenant-admin MFA server-side. */
  async updateTenantGasSponsorshipConfig(
    tenantId: string,
    gasSponsorshipConfig: TenantGasSponsorshipConfig,
  ): Promise<TenantGasSponsorshipConfig> {
    const response = await this.request<
      { gasSponsorshipConfig: TenantGasSponsorshipConfig },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/gas-sponsorship`, {
      method: "PATCH",
      body: JSON.stringify({ gasSponsorshipConfig }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.gasSponsorshipConfig;
  }

  /** Get the production security checklist for a tenant deployment. Requires tenant-admin MFA server-side. */
  async getTenantSecurityChecklist(
    tenantId: string,
  ): Promise<TenantSecurityChecklist> {
    const response = await this.request<
      TenantSecurityChecklist,
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/security-checklist`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Get privacy-preserving idempotency counters for a tenant. Requires tenant-admin MFA server-side. */
  async getTenantIdempotencyMetrics(
    tenantId: string,
  ): Promise<TenantIdempotencyMetrics> {
    const response = await this.request<
      TenantIdempotencyMetrics,
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/idempotency-metrics`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List tenant request-signing key metadata. Requires tenant-admin MFA server-side. */
  async listTenantRequestSigningKeys(
    tenantId: string,
  ): Promise<TenantRequestSigningKey[]> {
    const response = await this.request<
      { keys: TenantRequestSigningKey[] },
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/request-signing-keys`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.keys;
  }

  /** Rotate tenant request-signing keys and reveal the new secret once. */
  async rotateTenantRequestSigningKey(
    tenantId: string,
    input: { name?: string } = {},
  ): Promise<TenantRequestSigningKeyCreateResult> {
    const response = await this.request<
      TenantRequestSigningKeyCreateResult,
      LoginErrorResponse
    >(`/tenants/${encodeURIComponent(tenantId)}/request-signing-keys`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Revoke a tenant request-signing key. Requires tenant-admin MFA server-side. */
  async revokeTenantRequestSigningKey(
    tenantId: string,
    keyId: string,
  ): Promise<TenantRequestSigningKey> {
    const response = await this.request<
      { key: TenantRequestSigningKey },
      LoginErrorResponse
    >(
      `/tenants/${encodeURIComponent(tenantId)}/request-signing-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.key;
  }

  // ─── Agent Dashboard ──────────────────────────────────────────

  /** Lists the caller-requested agent approval page using the current session authority. */
  async listPendingApprovals(
    agentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<
    Array<{
      queueId: string;
      status: string;
      requestedAt: string;
      transaction: TxRecord;
    }>
  > {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined)
      params.set("offset", String(options.offset));
    const query = params.toString();
    const response = await this.request<
      {
        approvals: Array<{
          queueId: string;
          status: string;
          requestedAt: string;
          transaction: TxRecord;
        }>;
      },
      LoginErrorResponse
    >(
      `/vault/${encodeURIComponent(agentId)}/pending${query ? `?${query}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    if (
      !response.data ||
      !Array.isArray(response.data.approvals) ||
      !response.data.approvals.every(
        (approval) =>
          approval &&
          typeof approval === "object" &&
          typeof approval.queueId === "string" &&
          approval.status === "pending" &&
          typeof approval.requestedAt === "string" &&
          approval.transaction &&
          typeof approval.transaction === "object" &&
          !Array.isArray(approval.transaction) &&
          typeof approval.transaction.id === "string",
      )
    ) {
      throw new LoginApiError(
        "Pending approvals response is invalid",
        502,
        response.data,
      );
    }
    return response.data.approvals;
  }

  /** Get the aggregated dashboard for an agent (balance, spend, policies, recent tx, pending approvals). */
  async getAgentDashboard(agentId: string): Promise<AgentDashboardResponse> {
    const response = await this.request<
      AgentDashboardResponse,
      LoginErrorResponse
    >(`/dashboard/${encodeURIComponent(agentId)}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Get on-chain and realtime spend accounting for an agent. */
  async getAgentSpend(agentId: string): Promise<AgentSpendSummary> {
    const response = await this.request<AgentSpendSummary, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/spend`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Get the aggregated digital asset account for an agent. */
  async getAgentAccount(
    agentId: string,
    opts: { chainId?: number; tokens?: string[] } = {},
  ): Promise<AgentAccountSummary> {
    const params = new URLSearchParams();
    if (opts.chainId) params.set("chainId", String(opts.chainId));
    if (opts.tokens?.length) params.set("tokens", opts.tokens.join(","));
    const qs = params.toString();
    const response = await this.request<
      AgentAccountSummary,
      LoginErrorResponse
    >(`/agents/${encodeURIComponent(agentId)}/account${qs ? `?${qs}` : ""}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Privy-style alias for an agent's aggregated digital asset account. */
  async getAgentAccountAggregation(
    agentId: string,
    opts: { chainId?: number; tokens?: string[] } = {},
  ): Promise<AgentAccountSummary> {
    const params = new URLSearchParams();
    if (opts.chainId) params.set("chainId", String(opts.chainId));
    if (opts.tokens?.length) params.set("tokens", opts.tokens.join(","));
    const qs = params.toString();
    const response = await this.request<
      AgentAccountSummary,
      LoginErrorResponse
    >(
      `/agents/${encodeURIComponent(agentId)}/aggregation${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async listAgentSigners(
    agentId: string,
    opts?: { status?: AgentSignerStatus },
  ): Promise<AgentSigner[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    const qs = params.toString();
    const response = await this.request<
      { signers: AgentSigner[] },
      LoginErrorResponse
    >(`/agents/${encodeURIComponent(agentId)}/signers${qs ? `?${qs}` : ""}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.signers;
  }

  async createAgentSigner(
    agentId: string,
    input: AgentSignerCreate,
  ): Promise<AgentSignerCreateResult> {
    const response = await this.request<
      AgentSignerCreateResult,
      LoginErrorResponse
    >(`/agents/${encodeURIComponent(agentId)}/signers`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Privy-style alias for agent signer authorization-key inventory. */
  async listAuthorizationKeys(
    agentId: string,
    opts?: { status?: AgentSignerStatus },
  ): Promise<AuthorizationKey[]> {
    return this.listAgentSigners(agentId, opts);
  }

  /** Privy-style alias for registering an agent signer authorization key. */
  async createAuthorizationKey(
    agentId: string,
    input: AuthorizationKeyCreate,
  ): Promise<AuthorizationKeyCreateResult> {
    return this.createAgentSigner(agentId, input);
  }

  async updateAgentSigner(
    agentId: string,
    signerId: string,
    input: AgentSignerUpdate,
  ): Promise<AgentSigner> {
    const response = await this.request<AgentSigner, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/signers/${encodeURIComponent(signerId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Privy-style alias for updating an agent signer authorization key. */
  async updateAuthorizationKey(
    agentId: string,
    keyId: string,
    input: AuthorizationKeyUpdate,
  ): Promise<AuthorizationKey> {
    return this.updateAgentSigner(agentId, keyId, input);
  }

  async revokeAgentSigner(
    agentId: string,
    signerId: string,
  ): Promise<AgentSigner> {
    const response = await this.request<AgentSigner, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/signers/${encodeURIComponent(signerId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Privy-style alias for revoking an agent signer authorization key. */
  async revokeAuthorizationKey(
    agentId: string,
    keyId: string,
  ): Promise<AuthorizationKey> {
    return this.revokeAgentSigner(agentId, keyId);
  }

  async listAgentKeyQuorums(
    agentId: string,
    opts?: { status?: AgentKeyQuorumStatus },
  ): Promise<AgentKeyQuorum[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    const qs = params.toString();
    const response = await this.request<
      { quorums: AgentKeyQuorum[] },
      LoginErrorResponse
    >(
      `/agents/${encodeURIComponent(agentId)}/key-quorums${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data.quorums;
  }

  async createAgentKeyQuorum(
    agentId: string,
    input: AgentKeyQuorumCreate,
  ): Promise<AgentKeyQuorum> {
    const response = await this.request<AgentKeyQuorum, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/key-quorums`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async updateAgentKeyQuorum(
    agentId: string,
    quorumId: string,
    input: AgentKeyQuorumUpdate,
  ): Promise<AgentKeyQuorum> {
    const response = await this.request<AgentKeyQuorum, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/key-quorums/${encodeURIComponent(quorumId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  async revokeAgentKeyQuorum(
    agentId: string,
    quorumId: string,
  ): Promise<AgentKeyQuorum> {
    const response = await this.request<AgentKeyQuorum, LoginErrorResponse>(
      `/agents/${encodeURIComponent(agentId)}/key-quorums/${encodeURIComponent(quorumId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  // ─── Approvals ────────────────────────────────────────────────

  /**
   * Execute an approved vault transaction through the policy-revalidating
   * vault route. The generic approval endpoint deliberately cannot sign or
   * broadcast vault transactions.
   */
  async approveVaultTransaction(
    agentId: string,
    txId: string,
  ): Promise<VaultApprovalResult> {
    const response = await this.request<
      VaultApprovalResult,
      LoginErrorResponse
    >(
      `/vault/${encodeURIComponent(agentId)}/approve/${encodeURIComponent(txId)}`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List approval queue entries for the tenant. */
  async listApprovals(opts?: {
    status?: string;
    agentId?: string;
    limit?: number;
    offset?: number;
    cursorRequestedAt?: string;
    cursorId?: string;
  }): Promise<ApprovalQueueEntry[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.agentId !== undefined) params.set("agentId", opts.agentId);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts?.cursorRequestedAt !== undefined)
      params.set("cursorRequestedAt", opts.cursorRequestedAt);
    if (opts?.cursorId !== undefined) params.set("cursorId", opts.cursorId);
    const qs = params.toString();
    const response = await this.request<
      ApprovalQueueEntry[],
      LoginErrorResponse
    >(`/approvals${qs ? `?${qs}` : ""}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Approve a pending transaction. */
  async approveTransaction(
    txId: string,
    opts?: { comment?: string; approvedBy?: string },
  ): Promise<ApprovalQueueEntry> {
    const response = await this.request<ApprovalQueueEntry, LoginErrorResponse>(
      `/approvals/${encodeURIComponent(txId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Deny a pending transaction. */
  async denyTransaction(
    txId: string,
    reason: string,
    deniedBy?: string,
  ): Promise<ApprovalQueueEntry> {
    const response = await this.request<ApprovalQueueEntry, LoginErrorResponse>(
      `/approvals/${encodeURIComponent(txId)}/deny`,
      {
        method: "POST",
        body: JSON.stringify({ reason, deniedBy }),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Poll one held proxy request through the control-plane API. */
  async getPendingProxyRequest(id: string): Promise<PendingProxyRequest> {
    const response = await this.request<
      PendingProxyRequest,
      LoginErrorResponse
    >(`/approvals/proxy/${encodeURIComponent(id)}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** List approval-gated proxy requests for an operator. */
  async listPendingProxyRequests(
    status?: PendingProxyRequestStatus,
  ): Promise<PendingProxyRequest[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await this.request<
      PendingProxyRequest[],
      LoginErrorResponse
    >(`/approvals/proxy${qs}`);
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Approve a held proxy request. It executes exactly once when the agent polls the proxy. */
  async approveProxyRequest(
    id: string,
  ): Promise<{ id: string; status: PendingProxyRequestStatus }> {
    const response = await this.request<
      { id: string; status: PendingProxyRequestStatus },
      LoginErrorResponse
    >(`/approvals/proxy/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: "{}",
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Deny a held proxy request without forwarding it. */
  async denyProxyRequest(
    id: string,
    reason?: string,
  ): Promise<{ id: string; status: PendingProxyRequestStatus }> {
    const response = await this.request<
      { id: string; status: PendingProxyRequestStatus },
      LoginErrorResponse
    >(`/approvals/proxy/${encodeURIComponent(id)}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Get approval statistics for the tenant. */
  async getApprovalStats(): Promise<ApprovalStats> {
    const response = await this.request<ApprovalStats, LoginErrorResponse>(
      "/approvals/stats",
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  // ─── Auto-Approval Rules ─────────────────────────────────────

  /** Get auto-approval rules for the tenant. */
  async getAutoApprovalRules(): Promise<AutoApprovalRule | null> {
    const response = await this.request<
      AutoApprovalRule | null,
      LoginErrorResponse
    >("/approvals/rules");
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Create or update auto-approval rules. */
  async updateAutoApprovalRules(
    rules: Partial<AutoApprovalRule>,
  ): Promise<AutoApprovalRule> {
    const response = await this.request<AutoApprovalRule, LoginErrorResponse>(
      "/approvals/rules",
      {
        method: "PUT",
        body: JSON.stringify(rules),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  // ─── User Tenants ─────────────────────────────

  /** List the tenants the authenticated user is a member of. Requires user JWT. */
  async listUserTenants(): Promise<TenantMembership[]> {
    const response = await this.request<TenantMembership[], LoginErrorResponse>(
      "/user/me/tenants",
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Search users in a tenant directory. Requires user JWT, tenant admin role, and recent MFA. */
  async listTenantUsers(
    tenantId: string,
    opts?: {
      q?: string;
      email?: string;
      walletExternalId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<TenantAdminUserSearchResult> {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.email) params.set("email", opts.email);
    if (opts?.walletExternalId)
      params.set("walletExternalId", opts.walletExternalId);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    const response = await this.request<
      TenantAdminUserSearchResult,
      LoginErrorResponse
    >(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return {
      ...response.data,
      users: response.data.users.map(parseTenantAdminUser),
    };
  }

  /** Report existing tenant users that violate the one third-party wallet policy. Requires user JWT, tenant admin role, and recent MFA. */
  async getTenantWalletPolicyViolations(
    tenantId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<TenantWalletPolicyViolationReport> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    const response = await this.request<
      TenantWalletPolicyViolationReport,
      LoginErrorResponse
    >(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/wallet-policy/violations${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Remove one linked third-party wallet from a tenant member as audited one-wallet-policy remediation. Requires user JWT, tenant admin role, and recent MFA. */
  async remediateTenantWalletPolicyViolation(
    tenantId: string,
    userId: string,
    accountId: string,
  ): Promise<TenantWalletPolicyRemediationResult> {
    const response = await this.request<
      TenantWalletPolicyRemediationResult,
      LoginErrorResponse
    >(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/wallet-policy/wallets/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Bulk-remediate selected linked third-party wallets from tenant members. Requires user JWT, tenant admin role, and recent MFA. */
  async bulkRemediateTenantWalletPolicyViolations(
    tenantId: string,
    wallets: TenantWalletPolicyBulkRemediationItem[],
  ): Promise<TenantWalletPolicyBulkRemediationResponse> {
    const response = await this.request<
      TenantWalletPolicyBulkRemediationResponse,
      LoginErrorResponse
    >(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/wallet-policy/remediations`,
      {
        method: "POST",
        body: JSON.stringify({ wallets }),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return response.data;
  }

  /** Export the tenant-scoped user directory as CSV. Requires user JWT, tenant admin role, and recent MFA. */
  async exportTenantUsersCsv(
    tenantId: string,
    opts?: { q?: string; email?: string; limit?: number },
  ): Promise<string> {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.email) params.set("email", opts.email);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = `${this.baseUrl}/user/me/tenants/${encodeURIComponent(tenantId)}/users/export${qs ? `?${qs}` : ""}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.buildHeaders(),
        redirect: "error",
      });
    } catch (error) {
      throw new LoginApiError(
        error instanceof Error ? error.message : "Network request failed",
        0,
      );
    }
    if (!response.ok) {
      throw new LoginApiError(
        `Tenant user export failed: ${response.status}`,
        response.status,
      );
    }
    return response.text();
  }

  /** Read a tenant-scoped user record. Requires user JWT, tenant admin role, and recent MFA. */
  async getTenantUser(
    tenantId: string,
    userId: string,
  ): Promise<TenantAdminUser> {
    const response = await this.request<TenantAdminUser, LoginErrorResponse>(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return parseTenantAdminUser(response.data);
  }

  /** List tenant-scoped activity for a user. Requires user JWT, tenant admin role, and recent MFA. */
  async listTenantUserEvents(
    tenantId: string,
    userId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<TenantAdminUserEventsResult> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    const response = await this.request<
      TenantAdminUserEventsResult,
      LoginErrorResponse
    >(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/events${qs ? `?${qs}` : ""}`,
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return parseTenantAdminUserEvents(response.data);
  }

  /** Update a tenant user's team role. Requires user JWT, tenant admin role, and recent MFA. */
  async updateTenantUserRole(
    tenantId: string,
    userId: string,
    role: TenantTeamRole,
  ): Promise<TenantAdminUser> {
    const response = await this.request<TenantAdminUser, LoginErrorResponse>(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/role`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return parseTenantAdminUser(response.data);
  }

  /** Replace tenant-scoped custom metadata. Requires user JWT, tenant admin role, and recent MFA. */
  async updateTenantUserMetadata(
    tenantId: string,
    userId: string,
    tenantCustomMetadata: Record<string, unknown>,
  ): Promise<TenantAdminUser> {
    const response = await this.request<TenantAdminUser, LoginErrorResponse>(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/metadata`,
      {
        method: "PATCH",
        body: JSON.stringify({ tenantCustomMetadata }),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return parseTenantAdminUser(response.data);
  }

  /** Deactivate or reactivate an app-scoped tenant user. Requires user JWT, admin role, and MFA. */
  async setTenantUserDeactivated(
    tenantId: string,
    userId: string,
    deactivated = true,
  ): Promise<TenantAdminUser> {
    const response = await this.request<TenantAdminUser, LoginErrorResponse>(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/deactivate`,
      {
        method: "PATCH",
        body: JSON.stringify({ deactivated }),
      },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
    return parseTenantAdminUser(response.data);
  }

  /** Remove a user from the current tenant. Requires user JWT, tenant admin role, and recent MFA. */
  async removeTenantUser(tenantId: string, userId: string): Promise<void> {
    const response = await this.request<
      Record<string, never>,
      LoginErrorResponse
    >(
      `/user/me/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new LoginApiError(response.error, response.status, response.data);
  }

  /**
   * Create multiple agent wallets in a single request.
   * Optionally supply a shared policy set to apply to every created agent.
   */
  async createWalletBatch(
    agents: BatchAgentSpec[],
    policies?: PolicyRule[],
  ): Promise<BatchCreateResult> {
    const normalizedAgents = agents.map(
      ({ externalId, platformId, ...agent }) => ({
        ...agent,
        platformId: platformId ?? externalId,
      }),
    );
    const response = await this.request<BatchCreateResult, LoginErrorResponse>(
      "/agents/batch",
      {
        method: "POST",
        body: JSON.stringify({
          agents: normalizedAgents,
          applyPolicies: policies,
        }),
      },
    );

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    const result = response.data;
    return {
      ...result,
      created: result.created.map(parseAgentIdentity),
    };
  }

  /**
   * Privy-style alias for homogeneous server-wallet batch creation.
   * `externalId` maps to the immutable per-tenant wallet `platformId`.
   */
  async createWalletsBatch(
    wallets: WalletBatchSpec[],
    policies?: PolicyRule[],
  ): Promise<WalletBatchCreateResult> {
    const response = await this.request<
      WalletBatchCreateResult,
      LoginErrorResponse
    >("/wallets/batch", {
      method: "POST",
      body: JSON.stringify({ wallets, applyPolicies: policies }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    const result = response.data;
    return {
      ...result,
      created: result.created.map(parseAgentIdentity),
    };
  }

  /**
   * Pre-generate encrypted wallets that can later be claimed by end users.
   * Claim tokens are returned once; the login service stores only token hashes.
   */
  async createPregeneratedUserWallets(input: {
    count?: number;
    namePrefix?: string;
    policies?: PolicyRule[];
    claimExpiresInSeconds?: number;
  }): Promise<PregeneratedUserWalletCreateResult> {
    const response = await this.request<
      PregeneratedUserWalletCreateResult,
      LoginErrorResponse
    >("/agents/pregenerated", {
      method: "POST",
      body: JSON.stringify({
        count: input.count,
        namePrefix: input.namePrefix,
        applyPolicies: input.policies,
        claimExpiresInSeconds: input.claimExpiresInSeconds,
      }),
    });

    if (!response.ok) {
      throw new LoginApiError(response.error, response.status, response.data);
    }

    return {
      ...response.data,
      wallets: response.data.wallets.map((wallet) => ({
        ...wallet,
        agent: parseAgentIdentity(wallet.agent),
      })),
    };
  }

  private async request<TSuccess, TFailure = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<ApiRequestResult<TSuccess, TFailure>> {
    const { response, payload } = await this.fetchJson<
      ApiResponse<TSuccess | TFailure>
    >(path, init);

    if (!payload.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload.error ?? `Request failed with status ${response.status}`,
        data: payload.data as TFailure | undefined,
      };
    }

    if (typeof payload.data === "undefined") {
      return { ok: true, status: response.status, data: undefined as TSuccess };
    }

    return {
      ok: true,
      status: response.status,
      data: payload.data as TSuccess,
    };
  }

  private buildHeaders(headers?: HeadersInit): Headers {
    const merged = new Headers(headers);

    if (!merged.has("Content-Type")) {
      merged.set("Content-Type", "application/json");
    }
    if (!merged.has("Accept")) {
      merged.set("Accept", "application/json");
    }
    if (this.platformKey) {
      merged.set("X-Steward-Platform-Key", this.platformKey);
    } else if (this.bearerToken) {
      merged.set("Authorization", `Bearer ${this.bearerToken}`);
    } else if (this.appId && this.appSecret) {
      merged.set(
        "Authorization",
        `Basic ${btoa(`${this.appId}:${this.appSecret}`)}`,
      );
      merged.set("X-Steward-App-Id", this.appId);
    } else if (this.apiKey) {
      merged.set("X-Steward-Key", this.apiKey);
    }
    if (this.tenantId) {
      merged.set("X-Steward-Tenant", this.tenantId);
    }

    return merged;
  }

  private async buildRequestHeaders(
    path: string,
    init: RequestInit,
  ): Promise<Headers> {
    const headers = this.buildHeaders(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (!this.requestSigningSecret || !isSensitiveMutatingRequest(path, method))
      return headers;

    if (!headers.has("X-Steward-Request-Timestamp")) {
      headers.set(
        "X-Steward-Request-Timestamp",
        String(Math.floor(Date.now() / 1000)),
      );
    }
    if (!headers.has("Idempotency-Key")) {
      headers.set("Idempotency-Key", randomIdempotencyKey());
    }
    if (this.requestSigningKeyId && !headers.has("X-Steward-Signing-Key-Id")) {
      headers.set("X-Steward-Signing-Key-Id", this.requestSigningKeyId);
    }

    const body = typeof init.body === "string" ? init.body : "";
    const bodyHash = await sha256Hex(body);
    const authHash = await sha256Hex(headers.get("Authorization") ?? "");
    const apiKeyHash = await sha256Hex(headers.get("X-Steward-Key") ?? "");
    const platformKeyHash = await sha256Hex(
      headers.get("X-Steward-Platform-Key") ?? "",
    );
    const signerIdHash = await sha256Hex(
      headers.get("X-Steward-Signer-Id") ?? "",
    );
    const signerSecretHash = await sha256Hex(
      headers.get("X-Steward-Signer-Secret") ?? "",
    );
    const quorumIdHash = await sha256Hex(
      headers.get("X-Steward-Key-Quorum-Id") ?? "",
    );
    const quorumCredentialsHash = await sha256Hex(
      headers.get("X-Steward-Key-Quorum-Credentials") ?? "",
    );
    const canonical = [
      "steward-request-signature-v1",
      method,
      path,
      headers.get("X-Steward-Tenant") ?? "",
      authHash,
      apiKeyHash,
      platformKeyHash,
      signerIdHash,
      signerSecretHash,
      quorumIdHash,
      quorumCredentialsHash,
      headers.get("X-Steward-Request-Timestamp") ?? "",
      headers.get("X-Steward-Request-Expires-At") ?? "",
      headers.get("Idempotency-Key") ?? "",
      bodyHash,
    ].join("\n");
    headers.set(
      "X-Steward-Signature",
      `v1=${await hmacSha256Hex(this.requestSigningSecret, canonical)}`,
    );
    return headers;
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit,
  ): Promise<{ response: Response; payload: T }> {
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.requestTimeoutMs;
    const callerSignal = init.signal;
    let timedOut = false;
    let callerCancelled = callerSignal?.aborted ?? false;
    const cancelFromCaller = () => {
      callerCancelled = true;
      controller.abort();
    };
    callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      if (callerCancelled)
        throw new DOMException("Request cancelled", "AbortError");
      const headers = await this.buildRequestHeaders(path, init);
      if (controller.signal.aborted)
        throw new DOMException("Request aborted", "AbortError");
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      const payload = await this.parseJson<T>(response, controller.signal);
      if (Date.now() >= deadlineAt) {
        timedOut = true;
        controller.abort();
        throw new DOMException("Request deadline elapsed", "AbortError");
      }
      return { response, payload };
    } catch (error) {
      if (timedOut) throw new LoginApiError("login API request timed out", 0);
      if (callerCancelled)
        throw new LoginApiError("login API request was cancelled", 0);
      if (error instanceof LoginApiError) throw error;
      throw new LoginApiError("Network request failed", 0);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  private async parseJson<T>(
    response: Response,
    signal: AbortSignal,
  ): Promise<T> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (
        Number.isFinite(parsedLength) &&
        parsedLength > this.maxResponseBodyBytes
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new LoginApiError(
          "login API response exceeded the configured size limit",
          response.status,
        );
      }
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await this.readResponseChunk(reader, signal);
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > this.maxResponseBodyBytes) {
            void reader.cancel().catch(() => undefined);
            throw new LoginApiError(
              "login API response exceeded the configured size limit",
              response.status,
            );
          }
          chunks.push(value);
        }
      } finally {
        if (signal.aborted) void reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          // An abort may leave a hostile/custom stream's read pending. The
          // controller and cancel above still ensure this request stops waiting.
        }
      }
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(body);

    if (!text) {
      return { ok: response.ok } as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LoginApiError(
        "Received invalid JSON from login API",
        response.status,
      );
    }
  }

  private async readResponseChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<
    { done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
  > {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private isPendingApproval(
    data:
      | LoginPendingApproval
      | LoginBroadcastOutcomeUnknown
      | LoginErrorResponse
      | undefined,
  ): data is LoginPendingApproval {
    return (
      typeof data !== "undefined" &&
      "status" in data &&
      data.status === "pending_approval"
    );
  }

  private isBroadcastOutcomeUnknown(
    data:
      | LoginPendingApproval
      | LoginBroadcastOutcomeUnknown
      | LoginErrorResponse
      | undefined,
  ): data is LoginBroadcastOutcomeUnknown {
    return (
      typeof data !== "undefined" &&
      "code" in data &&
      data.code === "external_broadcast_outcome_unknown" &&
      "reconciliationRequired" in data &&
      data.reconciliationRequired === true &&
      "txHash" in data &&
      typeof data.txHash === "string" &&
      "txId" in data &&
      typeof data.txId === "string"
    );
  }
}
