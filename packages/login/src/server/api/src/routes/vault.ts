/**
 * Vault routes — transaction signing, approval/rejection, history, key import,
 * multi-wallet addresses, RPC passthrough, Solana signing, EIP-712 typed data.
 *
 * Mount: app.route("/vault", vaultRoutes)
 */

import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { logger } from "@elizaos/logger";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import {
  executionAuthorizationNonces,
  tenantConfigs as tenantConfigsTable,
  users,
  userTenants,
  withTenantAuditedTransaction,
} from "../../../db/src/index.ts";
import { recordAggregationEvent } from "../../../redis/src/index.ts";
import {
  canonicalJsonStringify,
  ExecutionPayloadNormalizationError,
  type PolicyResult,
  rawSigningChainSupport,
  redactedThrownDiagnostics,
  type TenantAuthAbuseConfig,
  toCaip2,
} from "../../../shared/src/index.ts";
import {
  assertSolanaPriorityFeeWithinCap,
  BackendBindingMismatchError,
  type DerivedSolanaPolicyFields,
  deriveSolanaPolicyFields,
  detectSolanaPolicyConflicts,
  ENTRY_POINT_V07,
  type ExportPrivateKeyResult,
  ExternalBroadcastOutcomeUnknownError,
  GovernedVault,
  GovernedVaultError,
  getUserOperationHash,
  isVaultSigningFrozenError,
  packUserOperation,
  parseSolanaTransaction,
  readEip7702Delegation,
  SolanaBroadcastNotSubmittedError,
  type UnpackedUserOperationFields,
} from "../../../vault/src/index.ts";
import {
  enforceRateLimit,
  recordVaultSpend,
} from "../middleware/redis-enforcement";
import { type AuditEventInput, writeAuditEvent } from "../services/audit";
import {
  type ApiResponse,
  type AppVariables,
  agentKeyQuorums,
  agentSigners,
  approvalQueue,
  db,
  ensureAgentForTenant,
  extractRpcErrorMessage,
  getScopedPolicySet,
  getTransactionStats,
  isNonEmptyString,
  isRpcError,
  isValidAddress,
  isValidAgentId,
  isValidAnyAddress,
  isValidSolanaAddress,
  loadAggregationsForPolicies,
  loadConditionSetsForPolicies,
  policyEngine,
  priceOracle,
  type RpcRequest,
  type RpcResponse,
  requireAgentAccess,
  requireTenantLevel,
  type SignRequest,
  type SignTypedDataRequest,
  safeJsonParse,
  sanitizeErrorMessage,
  setNoStoreHeaders,
  toSignRequest,
  toTxRecord,
  transactions,
  vault,
} from "../services/context";
import {
  consumeExecutionAuthorization,
  executionPayloadDigestForEvmSign,
  mintExecutionAuthorization,
  policyRevisionHashForPolicySet,
} from "../services/execution-authorization";
import {
  recordSponsoredGasEvent,
  reserveSponsoredGasEvent,
  resolveGasSponsorshipRequest,
} from "../services/gas-sponsorship";
import { plaintextKeyExportResponseGateError } from "../services/key-export-plaintext-gate";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import { verifySignerCredential } from "../services/signer-credentials";
import { dispatchWebhook } from "../services/webhook-dispatch";
import {
  decryptImportSessionJson,
  encryptImportSessionJson,
  getImportSessionBackend,
} from "./auth";

export const vaultRoutes = new Hono<{ Variables: AppVariables }>();

vaultRoutes.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  await next();
});

/**
 * Maps a vault signing-freeze error to HTTP 423 Locked. The freeze gate lives at
 * the lowest signing chokepoint (before key decryption) inside the vault, so any
 * signing handler that awaits a `vault.sign*` call can surface a frozen state
 * here. Returns null for any other error so the caller falls through to its
 * normal error handling.
 */
function frozenSigningResponse(
  c: Context<{ Variables: AppVariables }>,
  error: unknown,
): Response | null {
  if (!isVaultSigningFrozenError(error)) return null;
  return c.json<ApiResponse<{ code: string; scopeType: string }>>(
    {
      ok: false,
      error: error.message,
      data: { code: error.code, scopeType: error.scopeType },
    },
    423,
  );
}

async function writeVaultAudit(
  c: Context<{ Variables: AppVariables }>,
  event: Omit<AuditEventInput, "ipAddress" | "userAgent" | "requestId">,
): Promise<void> {
  await writeAuditEvent({
    ...event,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
}

async function writeOutcomeUnknownAudit(
  c: Context<{ Variables: AppVariables }>,
  event: Omit<AuditEventInput, "ipAddress" | "userAgent" | "requestId">,
): Promise<void> {
  try {
    await writeVaultAudit(c, event);
  } catch (error) {
    // The deterministic hash and outcome_unknown row are already durable. An
    // audit sink failure must never replace the non-retryable 202 response with
    // a generic 500 that could induce a fresh broadcast.
    logger.error(
      {
        details: [
          "[vault] Failed to append outcome_unknown audit",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:vault] error",
    );
  }
}
// ─── Unsafe-signing opt-in flags (read LIVE, not captured at module-init) ──────
//
// Each accessor reads its env var on every call instead of freezing the value
// when this module first loads. In production the relevant env vars are fixed
// before this module is imported, so a live read returns exactly what a captured
// `const` would — behavior is identical. Reading live matters only for the api
// test suite, which runs all ~135 files in ONE `bun test` process: Bun shares
// the module registry, so a captured const would freeze whichever file imported
// vault.ts first and ignore every later file's beforeAll/afterAll flag toggles.
// Live reads let each file exercise BOTH the opt-in path and the fail-closed
// default within the single process.
//
// Fail-closed by construction: anything other than the exact string "true"
// (unset, "false", "1", etc.) yields false, i.e. signing disabled.
const allowPrivateKeyExport = (): boolean =>
  process.env.STEWARD_ALLOW_KEY_EXPORT !== "false" &&
  process.env.STEWARD_ALLOW_PRIVATE_KEY_EXPORT === "true";
const allowVaultPrivateKeyExport = (): boolean =>
  process.env.STEWARD_ALLOW_VAULT_PRIVATE_KEY_EXPORT === "true";
const allowUnsafeMessageSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_MESSAGE_SIGNING === "true";
const allowVaultUnsafeMessageSigning = (): boolean =>
  process.env.STEWARD_ALLOW_VAULT_UNSAFE_MESSAGE_SIGNING === "true";
// Audited opt-in for UNCONSTRAINED EIP-712 typed-data signing (no `typed-data`
// policy required). Both flags must be set. Normally typed-data signing is
// authorized per-agent by a `typed-data` policy instead; this is the
// break-glass equivalent of the message-signing flags.
const allowUnsafeTypedDataSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_TYPED_DATA_SIGNING === "true";
const allowVaultUnsafeTypedDataSigning = (): boolean =>
  process.env.STEWARD_ALLOW_VAULT_UNSAFE_TYPED_DATA_SIGNING === "true";
const allowUnsafeRawSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_RAW_SIGNING === "true";
const allowVaultUnsafeRawSigning = (): boolean =>
  process.env.STEWARD_ALLOW_VAULT_UNSAFE_RAW_SIGNING === "true";
const allowUnsafeContractCallSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_CONTRACT_CALL_SIGNING === "true";
const allowUnsafeUserOperationSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_USER_OPERATION_SIGNING === "true";
const allowUnsafeAuthorizationSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_AUTHORIZATION_SIGNING === "true";
/**
 * Blind-signing opt-in for Solana. When false (default), the sign-solana route
 * refuses any transaction whose instructions cannot all be confidently decoded
 * into policy fields (unknown program ids, lookup-table-loaded accounts, etc.).
 * Set to "true" ONLY for audited compatibility flows where the caller accepts
 * that policy controls cannot be enforced against the transaction's real effects.
 */
const allowUnsafeSolanaBlindSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_SOLANA_BLIND_SIGNING === "true";
const allowPrivateKeyImport = (): boolean =>
  process.env.STEWARD_ALLOW_PRIVATE_KEY_IMPORT === "true";
const allowVaultPrivateKeyImport = (): boolean =>
  process.env.STEWARD_ALLOW_VAULT_PRIVATE_KEY_IMPORT === "true";
const VAULT_RPC_ALLOWLIST = new Set(
  (
    process.env.STEWARD_VAULT_RPC_ALLOWLIST ??
    "eth_chainId,eth_blockNumber,eth_getBalance"
  )
    .split(",")
    .map((method) => method.trim())
    .filter(Boolean),
);
const MAX_VAULT_HISTORY_LIMIT = 200;
const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = 78;
const MAX_UINT64_DECIMAL = "18446744073709551615";
const MAX_UINT64_DECIMAL_DIGITS = 20;
const MAX_QUORUM_CREDENTIALS = 32;
const MAX_BITCOIN_PSBT_BASE64_LENGTH = 1_000_000;
const DEFAULT_MAX_BITCOIN_PSBT_FEE_SATS = 100_000n;
const DEFAULT_MFA_MAX_AGE_MS = 5 * 60_000;
const ENCRYPTED_IMPORT_SESSION_TTL_MS = 10 * 60_000;
const ENCRYPTED_IMPORT_MAX_CIPHERTEXT_BYTES = 4096;

type EncryptedImportSession = {
  id: string;
  tenantId: string;
  agentId: string;
  chain: "evm" | "solana";
  createdBy: string | null;
  privateKey: string;
  publicKey: string;
  createdAt: number;
  expiresAt: number;
};

type TenantMfaPolicyConfig = {
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
};

type TenantAuthAbuseConfigWithMfa = TenantAuthAbuseConfig & {
  mfa?: TenantMfaPolicyConfig;
};

function userOperationPolicyModelAvailable(): boolean {
  return false;
}

function authorizationPolicyModelAvailable(): boolean {
  return false;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (padded.length % 4)) % 4;
    const binary = atob(`${padded}${"=".repeat(paddingLength)}`);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function exportKeyDerBase64Url(key: KeyObject, type: "spki" | "pkcs8"): string {
  return base64UrlEncode(key.export({ type, format: "der" }) as Uint8Array);
}

function encryptedImportSessionId(): string {
  return `wimp_${base64UrlEncode(randomBytes(24))}`;
}

function encryptedImportSessionStoreKey(id: string): string {
  return `vault-agent:${id}`;
}

function parseStoredEncryptedImportSession(
  raw: string | null,
): EncryptedImportSession | null {
  if (!raw) return null;
  try {
    const parsed =
      decryptImportSessionJson<Partial<EncryptedImportSession>>(raw);
    const createdAt = parsed.createdAt;
    const expiresAt = parsed.expiresAt;
    if (
      !isNonEmptyString(parsed.id) ||
      !isNonEmptyString(parsed.tenantId) ||
      !isNonEmptyString(parsed.agentId) ||
      (parsed.chain !== "evm" && parsed.chain !== "solana") ||
      !isNonEmptyString(parsed.privateKey) ||
      !isNonEmptyString(parsed.publicKey) ||
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt)
    ) {
      return null;
    }
    return {
      id: parsed.id,
      tenantId: parsed.tenantId,
      agentId: parsed.agentId,
      chain: parsed.chain,
      createdBy: typeof parsed.createdBy === "string" ? parsed.createdBy : null,
      privateKey: parsed.privateKey,
      publicKey: parsed.publicKey,
      createdAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

async function createEncryptedImportSession(input: {
  tenantId: string;
  agentId: string;
  chain: "evm" | "solana";
  createdBy: string | null;
}): Promise<EncryptedImportSession> {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const now = Date.now();
  const session: EncryptedImportSession = {
    id: encryptedImportSessionId(),
    tenantId: input.tenantId,
    agentId: input.agentId,
    chain: input.chain,
    createdBy: input.createdBy,
    publicKey: exportKeyDerBase64Url(publicKey, "spki"),
    privateKey: exportKeyDerBase64Url(privateKey, "pkcs8"),
    createdAt: now,
    expiresAt: now + ENCRYPTED_IMPORT_SESSION_TTL_MS,
  };
  await getImportSessionBackend().set(
    encryptedImportSessionStoreKey(session.id),
    encryptImportSessionJson(session),
    ENCRYPTED_IMPORT_SESSION_TTL_MS,
  );
  return session;
}

async function takeEncryptedImportSession(
  id: unknown,
  tenantId: string,
  agentId: string,
): Promise<EncryptedImportSession | string> {
  if (!isNonEmptyString(id)) return "importSessionId is required";
  const key = encryptedImportSessionStoreKey(id);
  const session = parseStoredEncryptedImportSession(
    await getImportSessionBackend().get(key),
  );
  if (!session) return "Encrypted import session is invalid or expired";
  if (session.tenantId !== tenantId || session.agentId !== agentId) {
    return "Encrypted import session does not match this tenant or agent";
  }
  if (session.expiresAt <= Date.now()) {
    return "Encrypted import session is invalid or expired";
  }
  const consumed = parseStoredEncryptedImportSession(
    await getImportSessionBackend().consume(key),
  );
  if (
    !consumed ||
    consumed.tenantId !== tenantId ||
    consumed.agentId !== agentId ||
    consumed.expiresAt <= Date.now()
  ) {
    return "Encrypted import session is invalid or expired";
  }
  return consumed;
}

function decryptEncryptedImportPrivateKey(
  session: EncryptedImportSession,
  payload: {
    ephemeralPublicKey?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
    tag?: unknown;
  },
): string | null {
  if (
    !isNonEmptyString(payload.ephemeralPublicKey) ||
    !isNonEmptyString(payload.iv) ||
    !isNonEmptyString(payload.ciphertext) ||
    !isNonEmptyString(payload.tag)
  ) {
    return null;
  }
  const ephemeralPublicKeyDer = base64UrlDecode(payload.ephemeralPublicKey);
  const iv = base64UrlDecode(payload.iv);
  const ciphertext = base64UrlDecode(payload.ciphertext);
  const tag = base64UrlDecode(payload.tag);
  if (!ephemeralPublicKeyDer || !iv || !ciphertext || !tag) return null;
  if (iv.length !== 12 || tag.length !== 16) return null;
  if (
    ciphertext.length === 0 ||
    ciphertext.length > ENCRYPTED_IMPORT_MAX_CIPHERTEXT_BYTES
  ) {
    return null;
  }
  const privateKeyDer = base64UrlDecode(session.privateKey);
  if (!privateKeyDer) return null;

  const clientPublicKey = createPublicKey({
    key: ephemeralPublicKeyDer as never,
    type: "spki",
    format: "der",
  });
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: privateKeyDer as never,
      type: "pkcs8",
      format: "der",
    }),
    publicKey: clientPublicKey,
  });
  const info = new TextEncoder().encode(
    `steward:vault-import:v1:${session.tenantId}:${session.agentId}:${session.chain}:${session.id}`,
  );
  const derivedKey = hkdfSync(
    "sha256",
    sharedSecret,
    new Uint8Array(),
    info,
    32,
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derivedKey as never,
    iv as never,
  );
  decipher.setAAD(new TextEncoder().encode(session.id));
  decipher.setAuthTag(tag as never);
  const first = decipher.update(ciphertext);
  const final = decipher.final();
  const plaintextBytes = new Uint8Array(first.length + final.length);
  plaintextBytes.set(first, 0);
  plaintextBytes.set(final, first.length);
  return new TextDecoder().decode(plaintextBytes);
}

function parseListLimit(value: string | undefined, fallback = 100): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_VAULT_HISTORY_LIMIT);
}

function parseListOffset(value: string | undefined): number {
  const parsed = value ? Number(value) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 100_000);
}

function isUint256DecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT256_DECIMAL_DIGITS) return false;
  return (
    normalized.length < MAX_UINT256_DECIMAL_DIGITS ||
    normalized <= MAX_UINT256_DECIMAL
  );
}

function isUint64DecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT64_DECIMAL_DIGITS) return false;
  return (
    normalized.length < MAX_UINT64_DECIMAL_DIGITS ||
    normalized <= MAX_UINT64_DECIMAL
  );
}

type TransferActionInput = {
  to?: unknown;
  token?: unknown;
  value?: unknown;
  amountWei?: unknown;
  chainId?: unknown;
  broadcast?: unknown;
  referenceId?: unknown;
  sponsor?: unknown;
};

type SendCallsActionInput = {
  calls?: unknown;
  chainId?: unknown;
  broadcast?: unknown;
  referenceId?: unknown;
  sponsor?: unknown;
};

type ParsedSendCall = {
  to: string;
  value: string;
  data?: string;
};

function isSolanaActionChain(chainId: number): boolean {
  return chainId === 101 || chainId === 102;
}

function parseReferenceId(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

function parseTransferActionInput(body: TransferActionInput): {
  to: string;
  token: "native" | string;
  value: string;
  chainId: number;
  broadcast: boolean;
  referenceId?: string;
  sponsor: boolean;
} | null {
  const value = typeof body.value === "string" ? body.value : body.amountWei;
  const token =
    body.token === undefined || body.token === null || body.token === ""
      ? "native"
      : body.token;
  const chainId =
    typeof body.chainId === "number" && Number.isInteger(body.chainId)
      ? body.chainId
      : parseInt(process.env.CHAIN_ID || "8453", 10);
  const referenceId = parseReferenceId(body.referenceId);
  const isSolanaTransfer = isSolanaActionChain(chainId);

  if (
    !isNonEmptyString(body.to) ||
    (isSolanaTransfer
      ? !isValidSolanaAddress(body.to)
      : !isValidAddress(body.to))
  ) {
    return null;
  }
  if (
    token !== "native" &&
    (!isNonEmptyString(token) ||
      (isSolanaTransfer
        ? !isValidSolanaAddress(token)
        : !isValidAddress(token)))
  ) {
    return null;
  }
  if (!isNonEmptyString(value) || !isUint256DecimalString(value)) return null;
  if (isSolanaTransfer && token !== "native" && !isUint64DecimalString(value))
    return null;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (referenceId === null) return null;

  return {
    to: body.to,
    token,
    value,
    chainId,
    broadcast: body.broadcast !== false,
    referenceId,
    sponsor: body.sponsor === true,
  };
}

function parseSendCallsActionInput(body: SendCallsActionInput):
  | {
      calls: ParsedSendCall[];
      chainId: number;
      broadcast: boolean;
      totalValue: string;
      referenceId?: string;
      sponsor: boolean;
    }
  | string {
  if (!Array.isArray(body.calls) || body.calls.length === 0) {
    return "calls must be a non-empty array";
  }
  if (body.calls.length > 25) {
    return "calls must contain at most 25 entries";
  }

  const chainId =
    typeof body.chainId === "number" && Number.isInteger(body.chainId)
      ? body.chainId
      : parseInt(process.env.CHAIN_ID || "8453", 10);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    return "chainId must be a positive integer";
  const referenceId = parseReferenceId(body.referenceId);
  if (referenceId === null)
    return "referenceId must be a non-empty string up to 128 characters";

  let totalValue = 0n;
  const calls: ParsedSendCall[] = [];
  for (const [index, rawCall] of body.calls.entries()) {
    if (!rawCall || typeof rawCall !== "object")
      return `calls[${index}] must be an object`;
    const call = rawCall as Record<string, unknown>;
    if (!isNonEmptyString(call.to) || !isValidAddress(call.to)) {
      return `calls[${index}].to must be an EVM address`;
    }
    const value = call.value === undefined ? "0" : call.value;
    if (!isNonEmptyString(value) || !isUint256DecimalString(value)) {
      return `calls[${index}].value must be a uint256 wei string`;
    }
    const data = call.data;
    if (data !== undefined && !isHex(data)) {
      return `calls[${index}].data must be hex`;
    }
    totalValue += BigInt(value);
    calls.push({
      to: call.to,
      value,
      data: data === "0x" || data === undefined ? undefined : data,
    });
  }

  return {
    calls,
    chainId,
    broadcast: body.broadcast !== false,
    totalValue: totalValue.toString(),
    referenceId,
    sponsor: body.sponsor === true,
  };
}

function transferActionResponse(input: {
  actionId: string;
  status:
    | "pending_approval"
    | "rejected"
    | "signed"
    | "broadcast"
    | "confirmed"
    | "failed"
    | "outcome_unknown";
  chainId: number;
  to: string;
  value: string;
  token: "native" | string;
  txHash?: string;
  signedTx?: string;
  sponsorship?: Record<string, unknown>;
  policyResults?: unknown;
}) {
  return {
    id: input.actionId,
    type: "transfer" as const,
    status: input.status,
    chainId: input.chainId,
    to: input.to,
    value: input.value,
    token: input.token,
    txHash: input.txHash,
    signedTx: input.signedTx,
    sponsorship: input.sponsorship,
    policyResults: input.policyResults,
  };
}

function transferActionPayload(input: {
  token: "native" | string;
  recipient: string;
  amount: string;
  broadcast: boolean;
  referenceId?: string | null;
  sponsorship?: Record<string, unknown>;
}) {
  return {
    type: "transfer",
    token: input.token,
    recipient: input.recipient,
    amount: input.amount,
    broadcast: input.broadcast,
    ...(input.referenceId ? { referenceId: input.referenceId } : {}),
    ...(input.sponsorship ? { sponsorship: input.sponsorship } : {}),
  };
}

function sendCallsActionPayload(input: {
  calls: ParsedSendCall[];
  broadcast: boolean;
  totalValue: string;
  referenceId?: string;
  sponsorship?: Record<string, unknown>;
}) {
  return {
    type: "send_calls",
    calls: input.calls,
    broadcast: input.broadcast,
    totalValue: input.totalValue,
    ...(input.referenceId ? { referenceId: input.referenceId } : {}),
    ...(input.sponsorship ? { sponsorship: input.sponsorship } : {}),
  };
}

function transactionActionPayload(input: {
  broadcast: boolean;
  referenceId?: string | null;
  nonce?: number | null;
  gasLimit?: string | null;
  venue?: string | null;
  walletAddress?: string | null;
}) {
  return {
    type: "transaction",
    broadcast: input.broadcast,
    ...(input.referenceId ? { referenceId: input.referenceId } : {}),
    ...(input.nonce !== undefined && input.nonce !== null
      ? { nonce: input.nonce }
      : {}),
    ...(input.gasLimit ? { gasLimit: input.gasLimit } : {}),
    ...(input.venue ? { venue: input.venue } : {}),
    ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}),
  };
}

function getTransferActionPayload(payload: unknown): {
  type: "transfer";
  token: string;
  recipient?: string;
  amount?: string;
  broadcast: boolean;
  referenceId?: string;
  sponsorship?: Record<string, unknown>;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (value.type !== "transfer") return null;
  return {
    type: "transfer",
    token: typeof value.token === "string" ? value.token : "native",
    recipient:
      typeof value.recipient === "string" ? value.recipient : undefined,
    amount: typeof value.amount === "string" ? value.amount : undefined,
    broadcast: value.broadcast !== false,
    referenceId: actionReferenceId(value) ?? undefined,
    sponsorship:
      value.sponsorship && typeof value.sponsorship === "object"
        ? (value.sponsorship as Record<string, unknown>)
        : undefined,
  };
}

async function recordSponsoredActionIfNeeded(input: {
  sponsorship: Record<string, unknown> | undefined;
  tenantId: string;
  agentId: string;
  txId: string;
  chainId: number;
  caip2?: string;
  txHash?: string;
  actionType: string;
  status?:
    | "pending"
    | "rejected"
    | "failed"
    | "reserved"
    | "signed"
    | "submitted";
}) {
  if (!input.sponsorship || input.sponsorship.sponsored !== true) return;
  if (input.status === "pending" || input.status === "rejected") {
    return;
  }
  const provider = input.sponsorship.provider;
  const mode = input.sponsorship.mode;
  if (typeof provider !== "string" || typeof mode !== "string") return;
  const estimatedUsd =
    typeof input.sponsorship.estimatedUsd === "number"
      ? input.sponsorship.estimatedUsd
      : undefined;
  if (input.status === "reserved") {
    if (estimatedUsd === undefined)
      return "Gas sponsorship estimate is unavailable";
    return reserveSponsoredGasEvent({
      tenantId: input.tenantId,
      agentId: input.agentId,
      txId: input.txId,
      chainFamily: "evm",
      chainId: input.chainId,
      caip2: input.caip2,
      provider,
      mode,
      reservedUsd: estimatedUsd,
      metadata: { actionType: input.actionType },
    });
  }
  await recordSponsoredGasEvent({
    tenantId: input.tenantId,
    agentId: input.agentId,
    txId: input.txId,
    chainFamily: "evm",
    chainId: input.chainId,
    caip2: input.caip2,
    provider,
    mode,
    status: input.status ?? (input.txHash ? "submitted" : "reserved"),
    reservedUsd: input.status === "failed" ? 0 : estimatedUsd,
    actualUsd: input.status === "failed" ? 0 : undefined,
    txHash: input.txHash,
    metadata: { actionType: input.actionType },
  });
}

function transferResponseStatus(
  status: string,
):
  | "pending_approval"
  | "rejected"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "outcome_unknown" {
  if (status === "pending") return "pending_approval";
  if (status === "rejected") return "rejected";
  if (status === "broadcast") return "broadcast";
  if (status === "confirmed") return "confirmed";
  if (status === "failed") return "failed";
  if (status === "outcome_unknown") return "outcome_unknown";
  return "signed";
}

function transferActionResponseFromTransaction(
  row: typeof transactions.$inferSelect,
) {
  const payload = getTransferActionPayload(row.actionPayload);
  return transferActionResponse({
    actionId: row.id,
    status: transferResponseStatus(row.status),
    chainId: row.chainId,
    to: payload?.recipient ?? row.toAddress,
    value: payload?.amount ?? row.value,
    token: payload?.token ?? "native",
    txHash: row.txHash ?? undefined,
    sponsorship: payload?.sponsorship,
    policyResults: row.policyResults ?? undefined,
  });
}

async function findActionByReferenceId(
  agentId: string,
  actionType: string,
  referenceId: string | undefined,
) {
  if (!referenceId) return null;
  const [existing] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        eq(transactions.actionType, actionType),
        sql`(${transactions.actionPayload}->>'referenceId' = ${referenceId} or ${transactions.actionPayload}->>'reference_id' = ${referenceId})`,
      ),
    )
    .limit(1);
  return existing ?? null;
}

function requireBroadcastActionIdempotency(
  c: Context<{ Variables: AppVariables }>,
  broadcast: boolean,
  actionLabel: string,
): Response | null {
  if (!broadcast) return null;
  const key = c.req.header("Idempotency-Key");
  if (isNonEmptyString(key) && /^[\x21-\x7e]{8,255}$/.test(key)) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: key
        ? "Invalid Idempotency-Key header"
        : `${actionLabel} require an Idempotency-Key header`,
    },
    400,
  );
}

function getSendCallsActionPayload(payload: unknown): {
  type: "send_calls";
  broadcast: boolean;
  totalValue?: string;
  referenceId?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (value.type !== "send_calls") return null;
  return {
    type: "send_calls",
    broadcast: value.broadcast !== false,
    totalValue:
      typeof value.totalValue === "string" ? value.totalValue : undefined,
    referenceId: actionReferenceId(value) ?? undefined,
  };
}

/**
 * Raised when a stored transaction action contains a present field with the
 * wrong type or range. The approval replay path converts it into a fail-closed
 * 409 and a malformed_transaction_action_payload audit.
 */
class TransactionActionPayloadValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "TransactionActionPayloadValidationError";
  }
}

/**
 * STRICT validator for a stored `transaction` action payload.
 *
 * Returns null ONLY when the payload is not a transaction-typed action (so
 * transfer/send_calls actions flow past unaffected). For a transaction-typed
 * payload every present optional field is validated to its exact contract and a
 * violation THROWS TransactionActionPayloadValidationError rather than being
 * silently coerced/dropped. This keeps the replay digest an honest reflection
 * of the approved caller intent.
 */
function getTransactionActionPayload(payload: unknown): {
  type: "transaction";
  broadcast: boolean;
  referenceId?: string;
  nonce?: number;
  gasLimit?: string;
  venue?: string;
  walletAddress?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (value.type !== "transaction") return null;

  // broadcast is required; an ambiguous value must never imply execution.
  if (typeof value.broadcast !== "boolean") {
    throw new TransactionActionPayloadValidationError(
      "transaction action payload 'broadcast' must be a boolean",
      "broadcast",
    );
  }

  // nonce is optional, but a present value (including null) must be a
  // non-negative safe integer. Object.hasOwn distinguishes absence from an
  // adversarial present-null value.
  let nonce: number | undefined;
  if (Object.hasOwn(value, "nonce")) {
    if (
      typeof value.nonce !== "number" ||
      !Number.isSafeInteger(value.nonce) ||
      value.nonce < 0
    ) {
      throw new TransactionActionPayloadValidationError(
        "transaction action payload 'nonce' must be a non-negative safe integer",
        "nonce",
      );
    }
    nonce = value.nonce;
  }

  // gasLimit is optional, but a present value (including null) must be a
  // decimal uint string such as "65000".
  let gasLimit: string | undefined;
  if (Object.hasOwn(value, "gasLimit")) {
    if (!isUint256DecimalString(value.gasLimit)) {
      throw new TransactionActionPayloadValidationError(
        "transaction action payload 'gasLimit' must be a decimal uint string",
        "gasLimit",
      );
    }
    gasLimit = value.gasLimit;
  }

  // venue and walletAddress are optional, but present values must be strings.
  let venue: string | undefined;
  if (Object.hasOwn(value, "venue")) {
    if (typeof value.venue !== "string") {
      throw new TransactionActionPayloadValidationError(
        "transaction action payload 'venue' must be a string",
        "venue",
      );
    }
    venue = value.venue;
  }

  let walletAddress: string | undefined;
  if (Object.hasOwn(value, "walletAddress")) {
    if (typeof value.walletAddress !== "string") {
      throw new TransactionActionPayloadValidationError(
        "transaction action payload 'walletAddress' must be a string",
        "walletAddress",
      );
    }
    walletAddress = value.walletAddress;
  }

  return {
    type: "transaction",
    broadcast: value.broadcast,
    referenceId: actionReferenceId(value) ?? undefined,
    nonce,
    gasLimit,
    venue,
    walletAddress,
  };
}

type TransactionLifecycleEventType =
  | "transaction.broadcasted"
  | "transaction.confirmed"
  | "transaction.execution_reverted"
  | "transaction.replaced"
  | "transaction.failed"
  | "transaction.provider_error"
  | "transaction.still_pending";

type WalletFundsEventType = "wallet.funds_deposited" | "wallet.funds_withdrawn";

type TransactionLifecycleUpdateEventType =
  | TransactionLifecycleEventType
  | WalletFundsEventType;

const TRANSACTION_LIFECYCLE_EVENTS =
  new Set<TransactionLifecycleUpdateEventType>([
    "transaction.broadcasted",
    "transaction.confirmed",
    "transaction.execution_reverted",
    "transaction.replaced",
    "transaction.failed",
    "transaction.provider_error",
    "transaction.still_pending",
    "wallet.funds_deposited",
    "wallet.funds_withdrawn",
  ]);

function isTransactionLifecycleEvent(
  value: unknown,
): value is TransactionLifecycleUpdateEventType {
  return (
    typeof value === "string" &&
    TRANSACTION_LIFECYCLE_EVENTS.has(
      value as TransactionLifecycleUpdateEventType,
    )
  );
}

function dispatchTransactionLifecycleWebhook(
  tenantId: string,
  agentId: string,
  type: TransactionLifecycleEventType,
  payload: {
    txId: string;
    txHash?: string | null;
    previousTxHash?: string | null;
    replacementTxHash?: string | null;
    chainId?: number;
    status?: string;
    reason?: string;
    error?: string;
    provider?: string;
    blockNumber?: string | number;
    confirmations?: number;
    referenceId?: string | null;
    transactionRequest?: Record<string, unknown> | null;
  },
): void {
  const caip2 = payload.chainId
    ? (toCaip2(payload.chainId) ?? `eip155:${payload.chainId}`)
    : undefined;
  dispatchWebhook(tenantId, agentId, type, {
    txId: payload.txId,
    wallet_id: agentId,
    transaction_id: payload.txId,
    ...(payload.txHash ? { txHash: payload.txHash } : {}),
    ...(payload.txHash ? { transaction_hash: payload.txHash } : {}),
    ...(payload.previousTxHash
      ? { previousTxHash: payload.previousTxHash }
      : {}),
    ...(payload.replacementTxHash
      ? { replacementTxHash: payload.replacementTxHash }
      : {}),
    ...(payload.chainId ? { chainId: payload.chainId } : {}),
    ...(caip2 ? { caip2 } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.blockNumber !== undefined
      ? { blockNumber: payload.blockNumber }
      : {}),
    ...(payload.confirmations !== undefined
      ? { confirmations: payload.confirmations }
      : {}),
    ...(payload.referenceId ? { reference_id: payload.referenceId } : {}),
    ...(payload.transactionRequest
      ? { transaction_request: payload.transactionRequest }
      : {}),
  });
}

function dispatchWalletFundsWebhook(
  tenantId: string,
  agentId: string,
  type: WalletFundsEventType,
  row: typeof transactions.$inferSelect,
  payload: {
    txHash?: string | null;
    walletAddress?: string | null;
    amount?: string | null;
    asset?: Record<string, unknown> | null;
    sender?: string | null;
    recipient?: string | null;
    blockNumber?: string | number;
    confirmations?: number;
    referenceId?: string | null;
  },
): void {
  const caip2 = toCaip2(row.chainId) ?? `eip155:${row.chainId}`;
  const walletAddress = payload.walletAddress ?? null;
  const defaultSender =
    type === "wallet.funds_withdrawn" ? walletAddress : undefined;
  const defaultRecipient =
    type === "wallet.funds_deposited" ? walletAddress : row.toAddress;
  dispatchWebhook(tenantId, agentId, type, {
    wallet_id: agentId,
    transaction_id: row.id,
    ...(payload.txHash
      ? { txHash: payload.txHash, transaction_hash: payload.txHash }
      : {}),
    caip2,
    asset: payload.asset ?? { type: "native-token", address: null },
    amount: payload.amount ?? row.value,
    ...((payload.sender ?? defaultSender)
      ? { sender: payload.sender ?? defaultSender }
      : {}),
    ...((payload.recipient ?? defaultRecipient)
      ? { recipient: payload.recipient ?? defaultRecipient }
      : {}),
    ...(payload.blockNumber !== undefined
      ? { block: { number: payload.blockNumber } }
      : {}),
    ...(payload.confirmations !== undefined
      ? { confirmations: payload.confirmations }
      : {}),
    ...(payload.referenceId ? { reference_id: payload.referenceId } : {}),
  });
}

function actionReferenceId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const referenceId = value.referenceId ?? value.reference_id;
  return typeof referenceId === "string" && referenceId.trim()
    ? referenceId
    : null;
}

function intentActionType(actionType: string | null | undefined): string {
  if (actionType === "transfer") return "wallet_action.transfer";
  if (actionType === "send_calls") return "wallet_action.send_calls";
  if (actionType === "user_operation") return "user_operation";
  if (actionType === "authorization") return "eip7702_authorization";
  return "transaction";
}

function dispatchIntentWebhook(
  tenantId: string,
  agentId: string,
  type:
    | "intent.created"
    | "intent.authorized"
    | "intent.executed"
    | "intent.failed"
    | "intent.rejected",
  payload: {
    intentId: string;
    actionType?: string | null;
    status: "pending" | "authorized" | "executed" | "failed" | "rejected";
    txHash?: string;
    signedTx?: string;
    error?: string;
    reason?: string;
    referenceId?: string | null;
    policyResults?: unknown;
  },
): void {
  dispatchWebhook(tenantId, agentId, type, {
    intent_id: payload.intentId,
    txId: payload.intentId,
    transaction_id: payload.intentId,
    wallet_id: agentId,
    action_type: intentActionType(payload.actionType),
    status: payload.status,
    ...(payload.txHash
      ? { txHash: payload.txHash, transaction_hash: payload.txHash }
      : {}),
    ...(payload.signedTx ? { signed_tx: payload.signedTx } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.referenceId ? { reference_id: payload.referenceId } : {}),
    ...(payload.policyResults ? { policy_results: payload.policyResults } : {}),
  });
}

function transactionRequestPayload(
  row: typeof transactions.$inferSelect,
): Record<string, unknown> {
  return {
    to: row.toAddress,
    value: row.value,
    data: row.data ?? "0x",
    chainId: row.chainId,
    ...(row.txHash ? { transaction_hash: row.txHash } : {}),
  };
}

function userOperationEventPayload(
  agentId: string,
  row: typeof transactions.$inferSelect,
  payload: {
    txHash?: string | null;
    status: "completed" | "failed";
    error?: string;
    blockNumber?: string | number;
    confirmations?: number;
  },
): Record<string, unknown> | null {
  if (row.actionType !== "user_operation" || !row.actionPayload) return null;
  const actionPayload = row.actionPayload as Record<string, unknown>;
  const userOperationHash = actionPayload.userOperationHash;
  if (typeof userOperationHash !== "string" || !userOperationHash) return null;
  const caip2 = toCaip2(row.chainId) ?? `eip155:${row.chainId}`;
  return {
    wallet_id: agentId,
    transaction_id: row.id,
    user_operation_hash: userOperationHash,
    caip2,
    status: payload.status,
    ...(typeof actionPayload.entryPoint === "string"
      ? { entry_point: actionPayload.entryPoint }
      : {}),
    ...(typeof actionPayload.sender === "string"
      ? { sender: actionPayload.sender }
      : {}),
    ...(payload.txHash ? { transaction_hash: payload.txHash } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.blockNumber !== undefined
      ? { blockNumber: payload.blockNumber }
      : {}),
    ...(payload.confirmations !== undefined
      ? { confirmations: payload.confirmations }
      : {}),
  };
}

function toTransactionResponse(row: typeof transactions.$inferSelect) {
  return {
    ...toTxRecord(row),
    actionType: row.actionType ?? null,
    actionPayload: row.actionPayload ?? null,
  };
}

function hasCalldata(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim().toLowerCase() !== "0x"
  );
}

function executionAuthorizationErrorResponse(
  c: Context<{ Variables: AppVariables }>,
  error: unknown,
): Response | null {
  if (!(error instanceof GovernedVaultError)) return null;
  const status = error.code === "authorization_rejected" ? 403 : 500;
  return c.json<ApiResponse>({ ok: false, error: error.message }, status);
}

function externalBroadcastOutcomeUnknownResponse(
  c: Context<{ Variables: AppVariables }>,
  error: unknown,
  txId?: string,
): Response | null {
  if (!(error instanceof ExternalBroadcastOutcomeUnknownError)) return null;
  return c.json<
    ApiResponse<{
      code: string;
      txId?: string;
      txHash: string;
      reconciliationRequired: true;
    }>
  >(
    {
      ok: false,
      error:
        "Broadcast outcome is unknown; reconcile the transaction hash before retrying",
      data: {
        code: error.code,
        ...(txId ? { txId } : {}),
        txHash: error.transactionHash,
        reconciliationRequired: true,
      },
    },
    202,
  );
}

// Fail-closed handler for the TOCTOU backend-binding guard.
//
// `BackendBindingMismatchError` is thrown at the vault signing boundary
// (Vault.signTransaction) AFTER the gateway authorization has been minted and
// consumed, when the wallet's custody backend has flipped from the
// gateway-supported "local-vault" to "third-party-custody" between the gateway's
// resolveExecutionBackend precheck and the raw sign. It is NOT a
// GovernedVaultError, so without this explicit handler it would fall through to
// the generic 500 path with no specific audit. Here we write a dedicated
// rejection audit event (matching the vault.execution_authorization.rejected
// taxonomy, reason `backend_binding_mismatch`) and return the same 409
// fail-closed shape the earlier gateway precheck uses, so the two custody-
// mismatch rejection points are indistinguishable to the caller.
//
// Returns null (does NOT swallow) for any other error so the outer catch keeps
// its existing handling for GovernedVaultError / RPC / generic failures.
async function backendBindingMismatchResponse(
  c: Context<{ Variables: AppVariables }>,
  error: unknown,
  context: {
    tenantId: string;
    agentId: string;
    txId?: string;
    authorizationId?: string;
    chainId?: number;
  },
): Promise<Response | null> {
  if (!(error instanceof BackendBindingMismatchError)) return null;
  await writeVaultAudit(c, {
    tenantId: context.tenantId,
    actorType: "agent",
    actorId: context.agentId,
    action: "vault.execution_authorization.rejected",
    resourceType: context.authorizationId
      ? "execution_authorization"
      : "transaction",
    resourceId: context.authorizationId ?? context.txId ?? context.agentId,
    metadata: {
      agentId: context.agentId,
      reason: error.code,
      expectedBackend: error.expectedBackend,
      resolvedBackend: error.resolvedBackend,
      ...(context.txId ? { txId: context.txId } : {}),
      ...(context.authorizationId
        ? { authorizationId: context.authorizationId }
        : {}),
      ...(context.chainId !== undefined ? { chainId: context.chainId } : {}),
    },
  });
  return c.json<ApiResponse<{ code: string }>>(
    {
      ok: false,
      error:
        error.code === "backend_identity_mismatch"
          ? "The external custody provider, key, or address changed after authorization. Resubmit the transaction."
          : "The wallet custody backend changed after authorization. Resubmit the transaction.",
      data: { code: error.code },
    },
    409,
  );
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function encodeErc20TransferCalldata(
  recipient: string,
  amount: string,
): string {
  const normalizedRecipient = recipient.toLowerCase().replace(/^0x/, "");
  const encodedRecipient = normalizedRecipient.padStart(64, "0");
  const encodedAmount = BigInt(amount).toString(16).padStart(64, "0");
  return `0xa9059cbb${encodedRecipient}${encodedAmount}`;
}

function erc20TransferPolicyPrecheck(
  policySet: Array<{
    id: string;
    type: string;
    enabled: boolean;
    config: unknown;
  }>,
  token: string,
): PolicyResult | null {
  const selector = "0xa9059cbb";
  const target = token.toLowerCase();
  for (const policy of policySet) {
    if (policy.type !== "contract-allowlist" || !policy.enabled) continue;
    const config = policy.config;
    if (!config || typeof config !== "object" || !("contracts" in config))
      continue;
    const contracts = (config as { contracts?: unknown }).contracts;
    if (!Array.isArray(contracts)) continue;
    for (const entry of contracts) {
      if (!entry || typeof entry !== "object") continue;
      const contract = entry as {
        address?: unknown;
        selectors?: unknown;
        constraints?: unknown;
      };
      if (
        typeof contract.address !== "string" ||
        contract.address.toLowerCase() !== target
      ) {
        continue;
      }
      if (
        !Array.isArray(contract.selectors) ||
        !contract.selectors.some(
          (allowed) =>
            typeof allowed === "string" && allowed.toLowerCase() === selector,
        )
      ) {
        continue;
      }
      const constraints =
        contract.constraints && typeof contract.constraints === "object"
          ? (contract.constraints as Record<string, unknown>)
          : {};
      const constraint =
        constraints[selector] ?? constraints[selector.toUpperCase()];
      if (!constraint || typeof constraint !== "object") {
        return {
          policyId: policy.id,
          type: policy.type,
          passed: false,
          reason:
            "ERC20 transfer selector requires recipient and maxAmount constraints",
        };
      }
      const typedConstraint = constraint as Record<string, unknown>;
      const hasRecipientConstraint =
        Array.isArray(typedConstraint.recipientAllowlist) ||
        Array.isArray(typedConstraint.recipientBlocklist);
      if (
        typeof typedConstraint.maxAmount !== "string" ||
        !hasRecipientConstraint
      ) {
        return {
          policyId: policy.id,
          type: policy.type,
          passed: false,
          reason:
            "ERC20 transfer selector requires recipient and maxAmount constraints",
        };
      }
      return null;
    }
  }
  return {
    policyId: "erc20-transfer-contract-allowlist-required",
    type: "contract-allowlist",
    passed: false,
    reason:
      "ERC20 transfer actions require an enabled contract-allowlist policy for the token transfer selector",
  };
}

function splTransferPolicyPrecheck(
  policySet: Array<{
    id: string;
    type: string;
    enabled: boolean;
    config: unknown;
  }>,
  recipient: string,
  mint: string,
): PolicyResult | null {
  for (const policy of policySet) {
    if (policy.type !== "approved-addresses" || !policy.enabled) continue;
    const config = policy.config;
    if (!config || typeof config !== "object") continue;
    const typedConfig = config as { addresses?: unknown; mode?: unknown };
    if (
      typedConfig.mode !== "whitelist" ||
      !Array.isArray(typedConfig.addresses)
    )
      continue;
    const addresses = typedConfig.addresses.filter(
      (address): address is string => typeof address === "string",
    );
    if (addresses.includes(recipient) && addresses.includes(mint)) {
      return null;
    }
  }
  return {
    policyId: "spl-transfer-mint-recipient-allowlist-required",
    type: "approved-addresses",
    passed: false,
    reason:
      "SPL transfer actions require an enabled approved-addresses whitelist policy containing both the recipient and token mint",
  };
}

function isBytes32Hex(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isBitcoinPsbtBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BITCOIN_PSBT_BASE64_LENGTH &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function maxBitcoinPsbtFeeSats(): bigint {
  const configured = process.env.STEWARD_MAX_BITCOIN_PSBT_FEE_SATS;
  if (configured && /^\d+$/.test(configured)) return BigInt(configured);
  return DEFAULT_MAX_BITCOIN_PSBT_FEE_SATS;
}

/** Positive uint64 decimal string (piconero). */
function isPiconeroAmountString(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{1,20}$/.test(value)) return false;
  const amount = BigInt(value);
  return amount > 0n && amount <= 2n ** 64n - 1n;
}

function parseBigIntString(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (!isUint256DecimalString(value)) return null;
  return BigInt(value);
}

function parseUserOperation(
  body: unknown,
): UnpackedUserOperationFields | string {
  if (!body || typeof body !== "object") return "userOperation is required";
  const value = body as Record<string, unknown>;
  if (!isValidAddress(value.sender))
    return "userOperation.sender must be an Ethereum address";
  if (!isHex(value.callData)) return "userOperation.callData must be hex";
  if (value.initCode !== undefined && !isHex(value.initCode)) {
    return "userOperation.initCode must be hex";
  }
  if (value.paymasterAndData !== undefined && !isHex(value.paymasterAndData)) {
    return "userOperation.paymasterAndData must be hex";
  }

  const nonce = parseBigIntString(value.nonce);
  const verificationGasLimit = parseBigIntString(value.verificationGasLimit);
  const callGasLimit = parseBigIntString(value.callGasLimit);
  const preVerificationGas = parseBigIntString(value.preVerificationGas);
  const maxPriorityFeePerGas = parseBigIntString(value.maxPriorityFeePerGas);
  const maxFeePerGas = parseBigIntString(value.maxFeePerGas);
  if (
    nonce === null ||
    verificationGasLimit === null ||
    callGasLimit === null ||
    preVerificationGas === null ||
    maxPriorityFeePerGas === null ||
    maxFeePerGas === null
  ) {
    return "userOperation gas, fee, and nonce fields must be non-negative decimal strings";
  }

  return {
    sender: value.sender as `0x${string}`,
    nonce,
    initCode: (value.initCode as `0x${string}` | undefined) ?? "0x",
    callData: value.callData,
    verificationGasLimit,
    callGasLimit,
    preVerificationGas,
    maxPriorityFeePerGas,
    maxFeePerGas,
    paymasterAndData:
      (value.paymasterAndData as `0x${string}` | undefined) ?? "0x",
  };
}

function looksLikeAuthMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("wants you to sign in with your ethereum account") ||
    normalized.includes("sign-in with ethereum") ||
    normalized.includes("siwe") ||
    normalized.includes("permit(") ||
    normalized.includes("permit2")
  );
}

function hasRecentSessionMfa(
  c: Context<{ Variables: AppVariables }>,
  maxAgeMs = DEFAULT_MFA_MAX_AGE_MS,
) {
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), maxAgeMs);
}

function hasTenantAdminSession(
  c: Context<{ Variables: AppVariables }>,
): boolean {
  const role = c.get("tenantRole");
  return (
    c.get("authType") === "session-jwt" &&
    (role === "owner" || role === "admin")
  );
}

async function hasCurrentTenantAdminMembership(
  tenantId: string,
  userId: string | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const [membership] = await db
    .select({ role: userTenants.role, deactivatedAt: users.deactivatedAt })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(
      and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
    );
  return (
    (membership?.role === "owner" || membership?.role === "admin") &&
    membership.deactivatedAt === null
  );
}

type ApprovalPrincipal = {
  type: "user" | "signer" | "quorum" | "agent";
  id: string;
};

function approvalPrincipal(
  c: Context<{ Variables: AppVariables }>,
  agentId: string,
  auth?: SignerAuthorization,
): ApprovalPrincipal {
  if (auth?.authMode === "signer") return { type: "signer", id: auth.signerId };
  if (auth?.authMode === "quorum") return { type: "quorum", id: auth.quorumId };

  const userId = c.get("userId");
  const authType = c.get("authType");
  if (
    typeof userId === "string" &&
    (authType === "session-jwt" || authType === "dashboard-jwt")
  ) {
    return { type: "user", id: userId };
  }

  return { type: "agent", id: agentId };
}

function approvalQueueValues(
  c: Context<{ Variables: AppVariables }>,
  agentId: string,
  txId: string,
  auth?: SignerAuthorization,
) {
  const principal = approvalPrincipal(c, agentId, auth);
  return {
    id: crypto.randomUUID(),
    txId,
    agentId,
    status: "pending" as const,
    requestedByType: principal.type,
    requestedById: principal.id,
  };
}

function isSameApprovalPrincipal(
  row: { requestedByType: string | null; requestedById: string | null },
  principal: ApprovalPrincipal,
): boolean {
  return (
    row.requestedByType === principal.type && row.requestedById === principal.id
  );
}

async function readTenantMfaPolicy(
  tenantId: string,
): Promise<TenantMfaPolicyConfig> {
  const [row] = await db
    .select({ authAbuseConfig: tenantConfigsTable.authAbuseConfig })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));
  return (
    (row?.authAbuseConfig as TenantAuthAbuseConfigWithMfa | undefined)?.mfa ??
    {}
  );
}

function tenantMfaMaxAgeMs(
  policy: TenantMfaPolicyConfig,
  action?: keyof NonNullable<TenantMfaPolicyConfig["requireFor"]>,
): number {
  const seconds = action
    ? (policy.maxAgeFor?.[action] ?? policy.maxAgeSeconds)
    : policy.maxAgeSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(30, Math.min(3600, Math.floor(seconds))) * 1000
    : DEFAULT_MFA_MAX_AGE_MS;
}

function tenantMfaRequiredFor(
  policy: TenantMfaPolicyConfig,
  action: keyof NonNullable<TenantMfaPolicyConfig["requireFor"]>,
): boolean {
  return policy.requireFor?.[action] !== false;
}

function tenantMfaDisabledFor(
  policy: TenantMfaPolicyConfig,
  action: keyof NonNullable<TenantMfaPolicyConfig["disableFor"]>,
): boolean {
  return policy.disableFor?.[action] === true;
}

async function hasRecentTenantSessionMfa(
  c: Context<{ Variables: AppVariables }>,
  tenantId: string,
  action?: keyof NonNullable<TenantMfaPolicyConfig["requireFor"]>,
): Promise<boolean> {
  const policy = await readTenantMfaPolicy(tenantId);
  if (action && !tenantMfaRequiredFor(policy, action)) return true;
  return hasRecentSessionMfa(c, tenantMfaMaxAgeMs(policy, action));
}

function signerHasPermission(
  permissions: readonly string[],
  required: string,
): boolean {
  const family = required.includes("_")
    ? `${required.split("_")[0]}:*`
    : `${required}:*`;
  const aliases =
    required === "wallet_action_transfer"
      ? ["transfer"]
      : required === "wallet_action_send_calls"
        ? ["send_calls"]
        : [];
  return (
    permissions.includes("*") ||
    (required.startsWith("sign_") && permissions.includes("sign:*")) ||
    permissions.includes(required) ||
    aliases.some((permission) => permissions.includes(permission)) ||
    permissions.includes(family)
  );
}

type SignerAuthorization =
  | { authMode: "admin"; signerId: string | null }
  | { authMode: "signer"; signerId: string }
  | { authMode: "quorum"; quorumId: string; memberSignerIds: string[] };

const SIGNER_AUTH_REQUIRED_ERROR =
  "Signing requires owner/admin MFA (owner or admin session with recent MFA), or signer-bound X-Steward-Signer-Id and X-Steward-Signer-Secret headers";

function signerAuthAuditMetadata(
  auth: SignerAuthorization,
): Record<string, unknown> {
  if (auth.authMode === "quorum") {
    return {
      authMode: "quorum",
      quorumId: auth.quorumId,
      memberSignerIds: auth.memberSignerIds,
    };
  }
  return {
    authMode: auth.authMode,
    signerId: auth.signerId,
  };
}

function applySignerPolicyScope(
  c: Context<{ Variables: AppVariables }>,
  policyIds: readonly string[],
): void {
  const scopedPolicyIds = [
    ...new Set(policyIds.filter((id) => typeof id === "string" && id)),
  ];
  if (scopedPolicyIds.length > 0) {
    c.set("agentPolicyIds", scopedPolicyIds);
  }
}

async function requireSignerPermission(
  c: Context<{ Variables: AppVariables }>,
  tenantId: string,
  agentId: string,
  requiredPermission: string,
): Promise<
  { ok: true; auth: SignerAuthorization } | { ok: false; response: Response }
> {
  const mfaPolicy = await readTenantMfaPolicy(tenantId);
  const vaultSigningRequiresMfa = tenantMfaRequiredFor(
    mfaPolicy,
    "vaultSigning",
  );
  if (hasTenantAdminSession(c)) {
    if (
      !vaultSigningRequiresMfa ||
      hasRecentSessionMfa(c, tenantMfaMaxAgeMs(mfaPolicy, "vaultSigning"))
    ) {
      return {
        ok: true,
        auth: { authMode: "admin", signerId: c.get("userId") ?? null },
      };
    }
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Signing requires recent MFA verification" },
        403,
      ),
    };
  }

  const signerId = c.req.header("x-steward-signer-id")?.trim();
  const signerSecret = c.req.header("x-steward-signer-secret");
  const quorumId = c.req.header("x-steward-key-quorum-id")?.trim();
  if (quorumId) {
    if (mfaPolicy.allowKeyQuorumAutomation === false) {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          {
            ok: false,
            error: "Tenant MFA policy disables key quorum automation",
          },
          403,
        ),
      };
    }
    const credentialsHeader = c.req.header("x-steward-key-quorum-credentials");
    if (!credentialsHeader) {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
          403,
        ),
      };
    }

    let credentials: Array<{ signerId: string; signerSecret: string }>;
    try {
      const parsed = JSON.parse(credentialsHeader) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        parsed.length > MAX_QUORUM_CREDENTIALS
      ) {
        throw new Error("invalid quorum credential count");
      }
      credentials = parsed.map((credential) => {
        if (!credential || typeof credential !== "object") {
          throw new Error("invalid quorum credential");
        }
        const value = credential as Record<string, unknown>;
        if (typeof value.signerId !== "string" || !value.signerId.trim()) {
          throw new Error("invalid quorum signer id");
        }
        if (typeof value.signerSecret !== "string" || !value.signerSecret) {
          throw new Error("invalid quorum signer secret");
        }
        return {
          signerId: value.signerId.trim(),
          signerSecret: value.signerSecret,
        };
      });
    } catch {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          {
            ok: false,
            error: "Invalid X-Steward-Key-Quorum-Credentials header",
          },
          400,
        ),
      };
    }

    const uniqueSignerIds = [
      ...new Set(credentials.map((credential) => credential.signerId)),
    ];
    if (uniqueSignerIds.length !== credentials.length) {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          {
            ok: false,
            error: "Key quorum credentials must use unique signer ids",
          },
          400,
        ),
      };
    }

    const [quorum] = await db
      .select()
      .from(agentKeyQuorums)
      .where(
        and(
          eq(agentKeyQuorums.id, quorumId),
          eq(agentKeyQuorums.tenantId, tenantId),
          eq(agentKeyQuorums.agentId, agentId),
        ),
      );
    if (!quorum || quorum.status !== "active") {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
          403,
        ),
      };
    }
    if (!signerHasPermission(quorum.permissions, requiredPermission)) {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
          403,
        ),
      };
    }

    const memberSet = new Set(quorum.memberSignerIds);
    if (uniqueSignerIds.some((id) => !memberSet.has(id))) {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
          403,
        ),
      };
    }
    if (uniqueSignerIds.length < quorum.threshold) {
      return {
        ok: false,
        response: c.json<ApiResponse>(
          { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
          403,
        ),
      };
    }

    const rows = await db
      .select()
      .from(agentSigners)
      .where(
        and(
          eq(agentSigners.tenantId, tenantId),
          eq(agentSigners.agentId, agentId),
        ),
      );
    const signersById = new Map(rows.map((row) => [row.id, row]));
    const now = new Date();
    const scopedPolicyIds: string[] = [];
    for (const credential of credentials) {
      const signer = signersById.get(credential.signerId);
      const credentialHash =
        signer?.metadata && typeof signer.metadata.credentialHash === "string"
          ? signer.metadata.credentialHash
          : null;
      if (
        !signer ||
        signer.status !== "active" ||
        !credentialHash ||
        !(await verifySignerCredential(credential.signerSecret, credentialHash))
      ) {
        return {
          ok: false,
          response: c.json<ApiResponse>(
            { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
            403,
          ),
        };
      }
      if (!signerHasPermission(signer.permissions, requiredPermission)) {
        return {
          ok: false,
          response: c.json<ApiResponse>(
            { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
            403,
          ),
        };
      }
      scopedPolicyIds.push(...signer.policyIds);
      await db
        .update(agentSigners)
        .set({
          metadata: {
            ...signer.metadata,
            credentialLastUsedAt: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(eq(agentSigners.id, signer.id));
    }
    applySignerPolicyScope(c, scopedPolicyIds);

    return {
      ok: true,
      auth: {
        authMode: "quorum",
        quorumId: quorum.id,
        memberSignerIds: uniqueSignerIds,
      },
    };
  }

  if (!signerId || !signerSecret) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        {
          ok: false,
          error: SIGNER_AUTH_REQUIRED_ERROR,
        },
        403,
      ),
    };
  }

  if (mfaPolicy.allowDelegatedSignerAutomation === false) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        {
          ok: false,
          error: "Tenant MFA policy disables delegated signer automation",
        },
        403,
      ),
    };
  }

  const [signer] = await db
    .select()
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    );
  const credentialHash =
    signer?.metadata && typeof signer.metadata.credentialHash === "string"
      ? signer.metadata.credentialHash
      : null;

  if (
    !signer ||
    signer.status !== "active" ||
    !credentialHash ||
    !(await verifySignerCredential(signerSecret, credentialHash))
  ) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
        403,
      ),
    };
  }
  if (!signerHasPermission(signer.permissions, requiredPermission)) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: SIGNER_AUTH_REQUIRED_ERROR },
        403,
      ),
    };
  }

  await db
    .update(agentSigners)
    .set({
      metadata: {
        ...signer.metadata,
        credentialLastUsedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(agentSigners.id, signer.id));

  applySignerPolicyScope(c, signer.policyIds);

  return { ok: true, auth: { authMode: "signer", signerId: signer.id } };
}

async function withAgentSpendLock<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (
    process.env.STEWARD_DB_MODE === "pglite" ||
    process.env.STEWARD_PGLITE_MEMORY === "true"
  ) {
    return fn();
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${agentId}, 0))`,
    );
    return fn();
  });
}

async function nativeTransferGasAccountingGuard(
  c: Context<{ Variables: AppVariables }>,
  to: string,
  chainId: number,
  gasLimit: unknown,
): Promise<Response | null> {
  if (!isValidAddress(to)) return null;
  if (gasLimit !== undefined) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Native transfers cannot set gasLimit because gas spend is not policy-accounted",
      },
      403,
    );
  }

  let codeResponse: Awaited<ReturnType<typeof vault.rpcPassthrough>>;
  try {
    codeResponse = await vault.rpcPassthrough({
      method: "eth_getCode",
      params: [to, "latest"],
      chainId,
    });
  } catch {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Native transfers cannot be signed until recipient contract code is verified",
      },
      502,
    );
  }
  if (codeResponse.error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Native transfers cannot be signed until recipient contract code is verified",
      },
      502,
    );
  }
  if (
    typeof codeResponse.result !== "string" ||
    !/^0x[0-9a-fA-F]*$/.test(codeResponse.result)
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Recipient contract code lookup returned an invalid response",
      },
      502,
    );
  }
  if (codeResponse.result !== "0x") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Native transfers to contract recipients are disabled because gas spend is not policy-accounted",
      },
      403,
    );
  }
  return null;
}

// ─── Sign transaction (EVM) ───────────────────────────────────────────────────

vaultRoutes.post("/:agentId/sign", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_transaction",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const request =
    await safeJsonParse<Omit<SignRequest, "agentId" | "tenantId">>(c);
  if (!request) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isNonEmptyString(request.to)) {
    return c.json<ApiResponse>(
      { ok: false, error: "'to' address is required" },
      400,
    );
  }
  if (!isValidAnyAddress(request.to)) {
    const errMsg = request.to.startsWith("0x")
      ? "'to' must be a valid Ethereum address (0x + 40 hex chars)"
      : "'to' must be a valid Ethereum address (0x + 40 hex chars) or a valid Solana address (base58, 32–44 chars)";
    return c.json<ApiResponse>({ ok: false, error: errMsg }, 400);
  }
  if (request.value === undefined || request.value === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' is required (wei amount as string)" },
      400,
    );
  }
  if (
    !isNonEmptyString(request.value) ||
    !isUint256DecimalString(request.value)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' must be a uint256 wei string" },
      400,
    );
  }
  if (hasCalldata(request.data) && !allowUnsafeContractCallSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Contract calldata signing is disabled unless selector-specific policy extraction is configured",
      },
      403,
    );
  }

  const resolvedChainId =
    request.chainId || parseInt(process.env.CHAIN_ID || "8453", 10);
  if (!hasCalldata(request.data)) {
    const gasGuard = await nativeTransferGasAccountingGuard(
      c,
      request.to,
      resolvedChainId,
      request.gasLimit,
    );
    if (gasGuard) return gasGuard;
  }
  const signRequest: SignRequest = {
    tenantId,
    agentId,
    to: request.to,
    value: request.value,
    data: request.data,
    chainId: resolvedChainId,
    nonce: request.nonce,
    gasLimit: request.gasLimit,
    broadcast: request.broadcast,
    venue: request.venue,
    walletAddress: request.walletAddress,
  };
  const shouldBroadcast = signRequest.broadcast !== false;
  if (shouldBroadcast && !isNonEmptyString(c.req.header("Idempotency-Key"))) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Broadcast signing requires an Idempotency-Key header",
      },
      428,
    );
  }

  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);
  const isEvmSignRequest = resolvedChainId !== 101 && resolvedChainId !== 102;
  const executionPayloadDigest = isEvmSignRequest
    ? executionPayloadDigestForEvmSign(signRequest)
    : null;
  const executionPolicyRevisionHash = isEvmSignRequest
    ? policyRevisionHashForPolicySet(policySet)
    : null;

  let executionTarget: Awaited<
    ReturnType<typeof vault.resolveExecutionTarget>
  > = {
    backend: "local-vault",
  };
  if (isEvmSignRequest) {
    executionTarget = await vault.resolveExecutionTarget({
      tenantId,
      agentId,
      chainId: signRequest.chainId,
      venue: signRequest.venue,
      walletAddress: signRequest.walletAddress,
    });
  }

  // ── Redis rate-limit check (before policy evaluation) ──────────────────────
  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  // Set rate limit headers on success too
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers)) {
      c.header(key, value);
    }
  }

  return withAgentSpendLock(agentId, async () => {
    const stats = await getTransactionStats(agentId, signRequest.chainId);

    // Authoritative cumulative aggregates (Redis-sourced) for any aggregation
    // policies on this agent. Loaded INSIDE the per-agent spend lock so the
    // snapshot the evaluator sees is consistent with the recordAggregationEvent
    // write we make on commit below — concurrent signs cannot race a cap.
    // Fail-closed: snapshots that cannot be sourced are omitted from the lookup,
    // which makes the evaluator deny that aggregation condition.
    const aggregations = await loadAggregationsForPolicies(
      policySet,
      signRequest,
    );

    const evaluation = await policyEngine.evaluate(policySet, {
      request: signRequest,
      recentTxCount1h: stats.recentTxCount1h,
      recentTxCount24h: stats.recentTxCount24h,
      spentToday: stats.spentToday,
      spentThisWeek: stats.spentThisWeek,
      additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
      additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
      priceOracle,
      conditionSets,
      aggregations,
    });

    if (!evaluation.approved) {
      const txId = crypto.randomUUID();

      if (evaluation.requiresManualApproval) {
        await db.transaction(async (tx) => {
          await tx.insert(transactions).values({
            id: txId,
            agentId,
            status: "pending",
            toAddress: signRequest.to,
            value: signRequest.value,
            data: signRequest.data,
            chainId: signRequest.chainId,
            executionPayloadDigest,
            executionPolicyRevisionHash,
            executionBackend: executionTarget.backend,
            executionBackendIdentityDigest:
              executionTarget.backendIdentityDigest,
            policyResults: evaluation.results,
            actionPayload: transactionActionPayload({
              broadcast: signRequest.broadcast !== false,
              nonce: signRequest.nonce,
              gasLimit: signRequest.gasLimit,
              venue: signRequest.venue,
              walletAddress: signRequest.walletAddress,
            }),
          });
          await tx
            .insert(approvalQueue)
            .values(
              approvalQueueValues(c, agentId, txId, signerAuthorization.auth),
            );
        });

        await writeVaultAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: "vault.sign.queued_for_approval",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            chainId: signRequest.chainId,
            to: signRequest.to,
            value: signRequest.value,
            ...signerAuthAuditMetadata(signerAuthorization.auth),
            policyResults: evaluation.results,
          },
        });

        dispatchWebhook(tenantId, agentId, "approval_required", {
          txId,
          results: evaluation.results,
        });
        dispatchIntentWebhook(tenantId, agentId, "intent.created", {
          intentId: txId,
          status: "pending",
          policyResults: evaluation.results,
        });

        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Transaction requires manual approval",
            data: {
              txId,
              results: evaluation.results,
              status: "pending_approval",
            },
          },
          202,
        );
      }

      await db.insert(transactions).values({
        id: txId,
        agentId,
        status: "rejected",
        toAddress: signRequest.to,
        value: signRequest.value,
        data: signRequest.data,
        chainId: signRequest.chainId,
        executionPayloadDigest,
        executionPolicyRevisionHash,
        policyResults: evaluation.results,
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.rejected_by_policy",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          to: signRequest.to,
          value: signRequest.value,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          venue: signRequest.venue,
          walletAddress: signRequest.walletAddress,
          policyResults: evaluation.results,
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_rejected", {
        txId,
        results: evaluation.results,
      });

      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction rejected by policy",
          data: { txId, results: evaluation.results },
        },
        403,
      );
    }

    const idempotencyKey = c.req.header("Idempotency-Key");
    if (isEvmSignRequest && idempotencyKey && executionPayloadDigest) {
      const [priorAuthorization] = await db
        .select({
          requestId: executionAuthorizationNonces.requestId,
          payloadDigest: executionAuthorizationNonces.payloadDigest,
        })
        .from(executionAuthorizationNonces)
        .where(
          and(
            eq(executionAuthorizationNonces.tenantId, tenantId),
            eq(executionAuthorizationNonces.agentId, agentId),
            eq(executionAuthorizationNonces.idempotencyKey, idempotencyKey),
          ),
        )
        .orderBy(desc(executionAuthorizationNonces.issuedAt))
        .limit(1);
      if (priorAuthorization) {
        if (priorAuthorization.payloadDigest !== executionPayloadDigest) {
          return c.json<ApiResponse>(
            {
              ok: false,
              error:
                "Idempotency-Key was already used for a different transaction",
            },
            409,
          );
        }
        const [priorTransaction] = await db
          .select({ status: transactions.status, txHash: transactions.txHash })
          .from(transactions)
          .where(
            and(
              eq(transactions.id, priorAuthorization.requestId),
              eq(transactions.agentId, agentId),
            ),
          );
        if (
          priorTransaction?.status === "outcome_unknown" &&
          priorTransaction.txHash
        ) {
          const response = externalBroadcastOutcomeUnknownResponse(
            c,
            new ExternalBroadcastOutcomeUnknownError(priorTransaction.txHash),
            priorAuthorization.requestId,
          );
          if (!response)
            throw new Error(
              "invariant: outcome_unknown response was not constructed",
            );
          return response;
        }
        if (
          priorTransaction?.txHash &&
          (priorTransaction.status === "broadcast" ||
            priorTransaction.status === "confirmed")
        ) {
          return c.json<ApiResponse<{ txId: string; txHash: string }>>({
            ok: true,
            data: {
              txId: priorAuthorization.requestId,
              txHash: priorTransaction.txHash,
            },
          });
        }
        return c.json<ApiResponse>(
          {
            ok: false,
            error:
              "Transaction execution is already recorded; inspect its status before retrying",
            data: {
              txId: priorAuthorization.requestId,
              status: priorTransaction?.status,
            },
          },
          409,
        );
      }
    }

    const executionTxId = crypto.randomUUID();
    try {
      const txId = executionTxId;
      const txStatus: "broadcast" | "signed" = shouldBroadcast
        ? "broadcast"
        : "signed";
      const executionAuthorization =
        isEvmSignRequest && executionPayloadDigest
          ? await mintExecutionAuthorization({
              requestId: txId,
              tenantId,
              agentId,
              capability: "wallet.sign_transaction",
              payloadDigest: executionPayloadDigest,
              backend: executionTarget.backend,
              backendIdentityDigest: executionTarget.backendIdentityDigest,
              policyRevisionHash: executionPolicyRevisionHash ?? undefined,
              idempotencyKey: idempotencyKey ?? undefined,
            })
          : null;
      if (executionAuthorization && executionPayloadDigest) {
        await writeVaultAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: "vault.execution_authorization.minted",
          resourceType: "execution_authorization",
          resourceId: executionAuthorization.id,
          metadata: {
            txId,
            payloadDigest: executionPayloadDigest,
            policyRevisionHash: executionPolicyRevisionHash,
            backend: executionTarget.backend,
            backendIdentityDigest: executionTarget.backendIdentityDigest,
            expiresAt: executionAuthorization.expiresAt,
          },
        });
      }

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.authorized",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: resolvedChainId,
          to: signRequest.to,
          value: signRequest.value,
          broadcast: shouldBroadcast,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });
      const result =
        executionAuthorization && executionPayloadDigest
          ? await new GovernedVault(vault, async (authorization, expected) => {
              try {
                await consumeExecutionAuthorization(authorization, expected);
                await writeVaultAudit(c, {
                  tenantId,
                  actorType: "agent",
                  actorId: agentId,
                  action: "vault.execution_authorization.consumed",
                  resourceType: "execution_authorization",
                  resourceId: authorization.id,
                  metadata: {
                    txId,
                    payloadDigest: expected.payloadDigest,
                    capability: expected.capability,
                    backend: expected.backend,
                  },
                });
                // Stage the governed intent after authorization consumption but
                // before the raw signer can perform external I/O. This exact
                // row is the durable recovery anchor if the provider returns a
                // hash and Vault.recordSignedTransaction subsequently fails.
                await db.insert(transactions).values({
                  id: txId,
                  agentId,
                  status: "approved",
                  toAddress: signRequest.to,
                  value: signRequest.value,
                  data: signRequest.data,
                  chainId: resolvedChainId,
                  executionPayloadDigest,
                  executionPolicyRevisionHash,
                  executionBackend: executionTarget.backend,
                  executionBackendIdentityDigest:
                    executionTarget.backendIdentityDigest,
                  policyResults: evaluation.results,
                  actionPayload: transactionActionPayload({
                    broadcast: shouldBroadcast,
                    nonce: signRequest.nonce,
                    gasLimit: signRequest.gasLimit,
                    venue: signRequest.venue,
                    walletAddress: signRequest.walletAddress,
                  }),
                });
              } catch (error) {
                await writeVaultAudit(c, {
                  tenantId,
                  actorType: "agent",
                  actorId: agentId,
                  action: "vault.execution_authorization.rejected",
                  resourceType: "execution_authorization",
                  resourceId: authorization.id,
                  metadata: {
                    txId,
                    payloadDigest: expected.payloadDigest,
                    ...redactedThrownDiagnostics(error),
                  },
                });
                throw error;
              }
            }).signTransactionAuthorized(signRequest, {
              txId,
              policyResults: evaluation.results,
              status: txStatus,
              executionAuthorization,
              executionPayloadDigest,
            })
          : await (async () => {
              // Defense-in-depth: every primary EVM sign request has a non-null
              // executionPayloadDigest and therefore mints+consumes an
              // authorization above. The raw fallback exists ONLY for the
              // non-EVM (Solana) chain family. An EVM request reaching here is an
              // invariant violation (fail-open), not a signable request.
              if (isEvmSignRequest) {
                throw new Error(
                  "invariant: primary EVM sign reached raw signer without gateway authorization",
                );
              }
              return vault.signTransaction(signRequest, {
                txId,
                policyResults: evaluation.results,
                status: txStatus,
              });
            })();

      await db
        .update(transactions)
        .set({
          status: txStatus,
          txHash: shouldBroadcast ? result : undefined,
          executionPayloadDigest,
          executionPolicyRevisionHash,
          policyResults: evaluation.results,
          signedAt: new Date(),
        })
        .where(eq(transactions.id, txId));

      // ── Record spend in Redis (fire-and-forget) ──────────────────────────────
      recordVaultSpend(
        agentId,
        tenantId,
        signRequest.value,
        resolvedChainId,
      ).catch((err) =>
        logger.error(
          {
            details: [
              "[vault] Failed to record spend",
              redactedThrownDiagnostics(err),
            ],
          },
          "[Login:vault] error",
        ),
      );

      // ── Record the authoritative aggregation event ───────────────────────────
      // AWAITED (unlike recordVaultSpend) and still inside the per-agent spend
      // lock, so the next request's loadAggregationsForPolicies snapshot already
      // includes this contribution — cumulative caps cannot be raced past the
      // threshold by overlapping signs. The tx is already committed/broadcast at
      // this point, so a record failure cannot retroactively fail the request;
      // we log it loudly (an undercounted aggregate is a known residual risk of
      // any post-commit counter, bounded by the spend lock's serialization).
      try {
        await recordAggregationEvent({
          agentId,
          valueRaw: signRequest.value,
          to: signRequest.to,
          chainId: resolvedChainId,
        });
      } catch (err) {
        logger.error(
          {
            details: [
              "[vault] Failed to record aggregation event",
              redactedThrownDiagnostics(err),
            ],
          },
          "[Login:vault] error",
        );
      }

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: resolvedChainId,
          to: signRequest.to,
          value: signRequest.value,
          broadcast: shouldBroadcast,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          txHash: shouldBroadcast ? result : undefined,
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_signed", {
        txId,
        txHash: shouldBroadcast ? result : undefined,
      });
      if (shouldBroadcast) {
        dispatchTransactionLifecycleWebhook(
          tenantId,
          agentId,
          "transaction.broadcasted",
          {
            txId,
            txHash: result,
            chainId: resolvedChainId,
            status: "broadcast",
          },
        );
      }

      if (shouldBroadcast) {
        return c.json<ApiResponse<{ txId: string; txHash: string }>>({
          ok: true,
          data: { txId, txHash: result },
        });
      }

      return c.json<ApiResponse<{ txId: string; signedTx: string }>>({
        ok: true,
        data: { txId, signedTx: result },
      });
    } catch (e: unknown) {
      const frozen = frozenSigningResponse(c, e);
      if (frozen) return frozen;
      const bindingMismatch = await backendBindingMismatchResponse(c, e, {
        tenantId,
        agentId,
        chainId: resolvedChainId,
      });
      if (bindingMismatch) return bindingMismatch;
      const authorizationError = executionAuthorizationErrorResponse(c, e);
      if (authorizationError) return authorizationError;
      const outcomeUnknown = externalBroadcastOutcomeUnknownResponse(
        c,
        e,
        executionTxId,
      );
      if (outcomeUnknown) {
        // This is also the fallback for a failed Vault.recordSignedTransaction
        // write. Preserve the irreversible hash on the pre-staged intent before
        // returning the typed 202 response.
        try {
          await db
            .update(transactions)
            .set({
              status: "outcome_unknown",
              txHash:
                e instanceof ExternalBroadcastOutcomeUnknownError
                  ? e.transactionHash
                  : undefined,
              signedAt: new Date(),
            })
            .where(
              and(
                eq(transactions.id, executionTxId),
                eq(transactions.agentId, agentId),
              ),
            );
        } catch {
          // The awaited pre-broadcast checkpoint is already durable. Do not
          // replace the non-retryable result with a generic 500 merely because
          // this redundant bookkeeping write is temporarily unavailable.
          logger.error(
            {
              details: [
                "[vault] Failed to refresh durable outcome_unknown transaction state",
              ],
            },
            "[Login:vault] error",
          );
        }

        // A lost response may still represent real spend. Account for it
        // conservatively before releasing the per-agent spend lock.
        recordVaultSpend(
          agentId,
          tenantId,
          signRequest.value,
          resolvedChainId,
        ).catch((err) =>
          logger.error(
            {
              details: [
                "[vault] Failed to record ambiguous spend",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          ),
        );
        try {
          await recordAggregationEvent({
            agentId,
            valueRaw: signRequest.value,
            to: signRequest.to,
            chainId: resolvedChainId,
          });
        } catch (err) {
          logger.error(
            {
              details: [
                "[vault] Failed to record ambiguous aggregation event",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          );
        }
        const outcomeUnknownTransactionHash =
          e instanceof ExternalBroadcastOutcomeUnknownError
            ? e.transactionHash
            : null;
        await writeOutcomeUnknownAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: "vault.broadcast.outcome_unknown",
          resourceType: "transaction",
          resourceId: executionTxId,
          metadata: {
            agentId,
            txId: executionTxId,
            txHash: outcomeUnknownTransactionHash,
            chainId: resolvedChainId,
          },
        });
        return outcomeUnknown;
      }
      await db
        .update(transactions)
        .set({ status: "failed" })
        .where(
          and(
            eq(transactions.id, executionTxId),
            eq(transactions.agentId, agentId),
          ),
        );
      const requestId = c.get("requestId") || "unknown";
      logger.error(
        {
          details: [
            `[${requestId}] Sign transaction failed for agent ${agentId}`,
          ],
        },
        "[Login:vault] error",
      );

      dispatchWebhook(tenantId, agentId, "tx_failed", {
        error: "Transaction signing failed",
        requestId,
      });

      if (isRpcError(e)) {
        return c.json<ApiResponse>(
          { ok: false, error: extractRpcErrorMessage(e) },
          502,
        );
      }
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(e) },
        500,
      );
    }
  });
});

// ─── Privy-style transfer actions ────────────────────────────────────────────

vaultRoutes.post("/:agentId/actions/transfer/quote", async (c) => {
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Transfer actions require owner or admin session with recent MFA",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const body = await safeJsonParse<TransferActionInput>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const transfer = parseTransferActionInput(body);
  if (!transfer) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "'to' must be an EVM address or a Solana address on chainId 101/102, optional 'token' must be 'native', an EVM token address, or a Solana token mint on chainId 101/102, and 'value'/'amountWei' must be a base-unit integer string",
      },
      400,
    );
  }

  const quoteId = crypto.randomUUID();
  return c.json<
    ApiResponse<{
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
    }>
  >({
    ok: true,
    data: {
      quoteId,
      type: "transfer",
      chainId: transfer.chainId,
      from: agent.walletAddress,
      to: transfer.to,
      value: transfer.value,
      token: transfer.token,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      request: transfer,
    },
  });
});

vaultRoutes.post("/:agentId/actions/send-calls", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "wallet_action_send_calls",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const body = await safeJsonParse<SendCallsActionInput>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const parsed = parseSendCallsActionInput(body);
  if (typeof parsed === "string") {
    return c.json<ApiResponse>({ ok: false, error: parsed }, 400);
  }
  const sponsorship = await resolveGasSponsorshipRequest({
    tenantId,
    agentId,
    chainId: parsed.chainId,
    caip2: toCaip2(parsed.chainId),
    sponsor: parsed.sponsor,
  });
  if (sponsorship.requested && !sponsorship.sponsored) {
    const status: 403 | 501 | 503 =
      sponsorship.status === 501 ? 501 : sponsorship.status === 503 ? 503 : 403;
    return c.json<ApiResponse>({ ok: false, error: sponsorship.error }, status);
  }
  const sponsorshipPayload =
    sponsorship.requested && sponsorship.sponsored
      ? {
          requested: true,
          sponsored: true,
          provider: sponsorship.provider,
          mode: sponsorship.mode,
          estimatedUsd: sponsorship.estimatedUsd,
        }
      : parsed.sponsor
        ? { requested: true, sponsored: false }
        : undefined;
  if (
    parsed.calls.some((call) => hasCalldata(call.data)) &&
    !allowUnsafeContractCallSigning()
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Batch call calldata signing is disabled unless selector-specific policy extraction is configured",
      },
      403,
    );
  }
  const idempotencyResponse = requireBroadcastActionIdempotency(
    c,
    parsed.broadcast,
    "Broadcast send-calls actions",
  );
  if (idempotencyResponse) return idempotencyResponse;
  const existingAction = await findActionByReferenceId(
    agentId,
    "send_calls",
    parsed.referenceId,
  );
  if (existingAction) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "referenceId has already been used for this action type",
        data: { actionId: existingAction.id, status: existingAction.status },
      },
      409,
    );
  }

  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);
  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers)) {
      c.header(key, value);
    }
  }

  return withAgentSpendLock(agentId, async () => {
    const lockedExistingAction = await findActionByReferenceId(
      agentId,
      "send_calls",
      parsed.referenceId,
    );
    if (lockedExistingAction) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "referenceId has already been used for this action type",
          data: {
            actionId: lockedExistingAction.id,
            status: lockedExistingAction.status,
          },
        },
        409,
      );
    }

    const stats = await getTransactionStats(agentId, parsed.chainId);
    let runningSpentToday = stats.spentToday;
    let runningSpentThisWeek = stats.spentThisWeek;
    const evaluations = [];
    for (const call of parsed.calls) {
      const request: SignRequest = {
        tenantId,
        agentId,
        to: call.to,
        value: call.value,
        data: call.data,
        chainId: parsed.chainId,
        broadcast: parsed.broadcast,
      };
      evaluations.push(
        await policyEngine.evaluate(policySet, {
          request,
          recentTxCount1h: stats.recentTxCount1h,
          recentTxCount24h: stats.recentTxCount24h,
          spentToday: runningSpentToday,
          spentThisWeek: runningSpentThisWeek,
          additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
          additionalUsdSpentThisWeekMicros:
            stats.additionalUsdSpentThisWeekMicros,
          priceOracle,
          conditionSets,
        }),
      );
      const callValue = BigInt(call.value);
      runningSpentToday += callValue;
      runningSpentThisWeek += callValue;
    }

    const requiresManualApproval = evaluations.some(
      (evaluation) => evaluation.requiresManualApproval,
    );
    const approved = evaluations.every((evaluation) => evaluation.approved);
    const policyResults = evaluations.flatMap((evaluation, index) =>
      evaluation.results.map((result) => ({ ...result, callIndex: index })),
    );
    const actionId = crypto.randomUUID();
    const payload = sendCallsActionPayload({
      calls: parsed.calls,
      broadcast: parsed.broadcast,
      totalValue: parsed.totalValue,
      referenceId: parsed.referenceId,
      sponsorship: sponsorshipPayload,
    });

    if (!approved) {
      const status = requiresManualApproval ? "pending" : "rejected";
      await db.insert(transactions).values({
        id: actionId,
        agentId,
        status,
        toAddress: parsed.calls[0].to,
        value: parsed.totalValue,
        data: JSON.stringify(parsed.calls),
        chainId: parsed.chainId,
        actionType: "send_calls",
        actionPayload: payload,
        policyResults,
      });
      if (requiresManualApproval) {
        await db
          .insert(approvalQueue)
          .values(
            approvalQueueValues(c, agentId, actionId, signerAuthorization.auth),
          );
      }
      await recordSponsoredActionIfNeeded({
        sponsorship: sponsorshipPayload,
        tenantId,
        agentId,
        txId: actionId,
        chainId: parsed.chainId,
        caip2: toCaip2(parsed.chainId),
        actionType: "send_calls",
        status: requiresManualApproval ? "pending" : "rejected",
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: requiresManualApproval
          ? "wallet_action.send_calls.queued_for_approval"
          : "wallet_action.send_calls.rejected",
        resourceType: "wallet_action",
        resourceId: actionId,
        metadata: {
          chainId: parsed.chainId,
          callCount: parsed.calls.length,
          totalValue: parsed.totalValue,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults,
        },
      });
      dispatchWebhook(
        tenantId,
        agentId,
        requiresManualApproval
          ? "wallet_action.send_calls.created"
          : "wallet_action.send_calls.rejected",
        { actionId, results: policyResults },
      );
      if (requiresManualApproval) {
        dispatchIntentWebhook(tenantId, agentId, "intent.created", {
          intentId: actionId,
          actionType: "send_calls",
          status: "pending",
          referenceId: parsed.referenceId,
          policyResults,
        });
      }

      return c.json<ApiResponse>(
        {
          ok: requiresManualApproval,
          error: requiresManualApproval
            ? undefined
            : "Batch calls rejected by policy",
          data: {
            id: actionId,
            type: "send_calls",
            status: requiresManualApproval ? "pending_approval" : "rejected",
            chainId: parsed.chainId,
            calls: parsed.calls,
            totalValue: parsed.totalValue,
            sponsorship: sponsorshipPayload,
            policyResults,
          },
        },
        requiresManualApproval ? 202 : 403,
      );
    }

    await db.insert(transactions).values({
      id: actionId,
      agentId,
      status: "pending",
      toAddress: parsed.calls[0].to,
      value: parsed.totalValue,
      data: JSON.stringify(parsed.calls),
      chainId: parsed.chainId,
      actionType: "send_calls",
      actionPayload: payload,
      policyResults,
    });
    await db
      .insert(approvalQueue)
      .values(
        approvalQueueValues(c, agentId, actionId, signerAuthorization.auth),
      );
    await recordSponsoredActionIfNeeded({
      sponsorship: sponsorshipPayload,
      tenantId,
      agentId,
      txId: actionId,
      chainId: parsed.chainId,
      caip2: toCaip2(parsed.chainId),
      actionType: "send_calls",
      status: "pending",
    });
    await writeVaultAudit(c, {
      tenantId,
      actorType: "agent",
      actorId: agentId,
      action: "wallet_action.send_calls.queued_for_approval",
      resourceType: "wallet_action",
      resourceId: actionId,
      metadata: {
        chainId: parsed.chainId,
        callCount: parsed.calls.length,
        totalValue: parsed.totalValue,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        policyResults,
      },
    });
    dispatchWebhook(tenantId, agentId, "wallet_action.send_calls.created", {
      actionId,
      results: policyResults,
    });
    dispatchIntentWebhook(tenantId, agentId, "intent.created", {
      intentId: actionId,
      actionType: "send_calls",
      status: "pending",
      referenceId: parsed.referenceId,
      policyResults,
    });

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          id: actionId,
          type: "send_calls",
          status: "pending_approval",
          chainId: parsed.chainId,
          calls: parsed.calls,
          totalValue: parsed.totalValue,
          sponsorship: sponsorshipPayload,
          policyResults,
        },
      },
      202,
    );
  });
});

vaultRoutes.post("/:agentId/actions/transfer", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "wallet_action_transfer",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const body = await safeJsonParse<TransferActionInput>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const transfer = parseTransferActionInput(body);
  if (!transfer) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "'to' must be an EVM address or a Solana address on chainId 101/102, optional 'token' must be 'native' for Solana or 'native'/EVM token address for EVM, and 'value'/'amountWei' must be a uint256 base-unit string",
      },
      400,
    );
  }
  if (transfer.sponsor === true && transfer.broadcast === false) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Gas sponsorship requires broadcast=true because signed-only actions do not spend sponsored gas",
      },
      400,
    );
  }
  const sponsorship = await resolveGasSponsorshipRequest({
    tenantId,
    agentId,
    chainId: transfer.chainId,
    caip2: toCaip2(transfer.chainId),
    sponsor: transfer.sponsor,
  });
  if (sponsorship.requested && !sponsorship.sponsored) {
    const status: 403 | 501 | 503 =
      sponsorship.status === 501 ? 501 : sponsorship.status === 503 ? 503 : 403;
    return c.json<ApiResponse>({ ok: false, error: sponsorship.error }, status);
  }
  const sponsorshipPayload =
    sponsorship.requested && sponsorship.sponsored
      ? {
          requested: true,
          sponsored: true,
          provider: sponsorship.provider,
          mode: sponsorship.mode,
          estimatedUsd: sponsorship.estimatedUsd,
        }
      : transfer.sponsor
        ? { requested: true, sponsored: false }
        : undefined;
  const idempotencyResponse = requireBroadcastActionIdempotency(
    c,
    transfer.broadcast,
    "Broadcast transfer actions",
  );
  if (idempotencyResponse) return idempotencyResponse;
  const existingAction = await findActionByReferenceId(
    agentId,
    "transfer",
    transfer.referenceId,
  );
  if (existingAction) {
    return c.json<ApiResponse>({
      ok:
        existingAction.status !== "rejected" &&
        existingAction.status !== "failed",
      error:
        existingAction.status === "rejected"
          ? "Transfer rejected by policy"
          : existingAction.status === "failed"
            ? "Transfer failed"
            : undefined,
      data: transferActionResponseFromTransaction(existingAction),
    });
  }

  const isTokenTransfer = transfer.token !== "native";
  const isSolanaTransfer = isSolanaActionChain(transfer.chainId);
  const isSolanaTokenTransfer = isSolanaTransfer && isTokenTransfer;
  let solanaTokenTransaction:
    | Awaited<ReturnType<typeof vault.buildSolanaSplTransferTransaction>>
    | undefined;
  if (!isTokenTransfer) {
    const gasGuard = await nativeTransferGasAccountingGuard(
      c,
      transfer.to,
      transfer.chainId,
      undefined,
    );
    if (gasGuard) return gasGuard;
  } else if (isSolanaTokenTransfer) {
    try {
      solanaTokenTransaction = await vault.buildSolanaSplTransferTransaction({
        tenantId,
        agentId,
        to: transfer.to,
        token: transfer.token,
        value: transfer.value,
        chainId: transfer.chainId,
      });
    } catch (error) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: sanitizeErrorMessage(error) || "Failed to build SPL transfer",
        },
        422,
      );
    }
  }
  const signRequest: SignRequest = {
    tenantId,
    agentId,
    to:
      isTokenTransfer && !isSolanaTokenTransfer ? transfer.token : transfer.to,
    value: isTokenTransfer && !isSolanaTokenTransfer ? "0" : transfer.value,
    data: isTokenTransfer
      ? isSolanaTokenTransfer
        ? solanaTokenTransaction?.transaction
        : encodeErc20TransferCalldata(transfer.to, transfer.value)
      : undefined,
    chainId: transfer.chainId,
    gasLimit: isTokenTransfer && !isSolanaTokenTransfer ? "65000" : undefined,
    broadcast: transfer.broadcast,
  };
  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);

  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers)) {
      c.header(key, value);
    }
  }

  return withAgentSpendLock(agentId, async () => {
    const lockedExistingAction = await findActionByReferenceId(
      agentId,
      "transfer",
      transfer.referenceId,
    );
    if (lockedExistingAction) {
      return c.json<ApiResponse>({
        ok:
          lockedExistingAction.status !== "rejected" &&
          lockedExistingAction.status !== "failed",
        error:
          lockedExistingAction.status === "rejected"
            ? "Transfer rejected by policy"
            : lockedExistingAction.status === "failed"
              ? "Transfer failed"
              : undefined,
        data: transferActionResponseFromTransaction(lockedExistingAction),
      });
    }

    const stats = await getTransactionStats(agentId, signRequest.chainId);
    const transferPrecheckFailure = isSolanaTokenTransfer
      ? splTransferPolicyPrecheck(policySet, transfer.to, transfer.token)
      : isTokenTransfer
        ? erc20TransferPolicyPrecheck(policySet, transfer.token)
        : null;
    const evaluation = transferPrecheckFailure
      ? {
          approved: false,
          requiresManualApproval: false,
          results: [transferPrecheckFailure],
        }
      : await policyEngine.evaluate(policySet, {
          request: signRequest,
          recentTxCount1h: stats.recentTxCount1h,
          recentTxCount24h: stats.recentTxCount24h,
          spentToday: stats.spentToday,
          spentThisWeek: stats.spentThisWeek,
          additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
          additionalUsdSpentThisWeekMicros:
            stats.additionalUsdSpentThisWeekMicros,
          priceOracle,
          conditionSets,
        });

    const actionId = crypto.randomUUID();
    if (!evaluation.approved) {
      const status = evaluation.requiresManualApproval ? "pending" : "rejected";
      await db.insert(transactions).values({
        id: actionId,
        agentId,
        status,
        toAddress: signRequest.to,
        value: signRequest.value,
        data: signRequest.data,
        chainId: signRequest.chainId,
        actionType: "transfer",
        actionPayload: transferActionPayload({
          token: transfer.token,
          recipient: transfer.to,
          amount: transfer.value,
          broadcast: signRequest.broadcast !== false,
          referenceId: transfer.referenceId,
          sponsorship: sponsorshipPayload,
        }),
        policyResults: evaluation.results,
      });
      if (evaluation.requiresManualApproval) {
        await db
          .insert(approvalQueue)
          .values(
            approvalQueueValues(c, agentId, actionId, signerAuthorization.auth),
          );
      }
      if (evaluation.requiresManualApproval) {
        const reservationError = await recordSponsoredActionIfNeeded({
          sponsorship: sponsorshipPayload,
          tenantId,
          agentId,
          txId: actionId,
          chainId: signRequest.chainId,
          caip2: toCaip2(signRequest.chainId),
          actionType: "transfer",
          status: "reserved",
        });
        if (typeof reservationError === "string") {
          await db.delete(transactions).where(eq(transactions.id, actionId));
          return c.json<ApiResponse>(
            { ok: false, error: reservationError },
            403,
          );
        }
      }

      try {
        await writeVaultAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: evaluation.requiresManualApproval
            ? "wallet_action.transfer.queued_for_approval"
            : "wallet_action.transfer.rejected",
          resourceType: "wallet_action",
          resourceId: actionId,
          metadata: {
            chainId: signRequest.chainId,
            to: transfer.to,
            value: transfer.value,
            token: transfer.token,
            ...signerAuthAuditMetadata(signerAuthorization.auth),
            policyResults: evaluation.results,
          },
        });
      } catch (error) {
        if (evaluation.requiresManualApproval) {
          await recordSponsoredActionIfNeeded({
            sponsorship: sponsorshipPayload,
            tenantId,
            agentId,
            txId: actionId,
            chainId: signRequest.chainId,
            caip2: toCaip2(signRequest.chainId),
            actionType: "transfer",
            status: "failed",
          });
        }
        await db.delete(transactions).where(eq(transactions.id, actionId));
        throw error;
      }
      dispatchWebhook(
        tenantId,
        agentId,
        evaluation.requiresManualApproval
          ? "wallet_action.transfer.created"
          : "wallet_action.transfer.rejected",
        { actionId, results: evaluation.results },
      );
      if (evaluation.requiresManualApproval) {
        dispatchIntentWebhook(tenantId, agentId, "intent.created", {
          intentId: actionId,
          actionType: "transfer",
          status: "pending",
          referenceId: transfer.referenceId,
          policyResults: evaluation.results,
        });
      }

      const response = transferActionResponse({
        actionId,
        status: evaluation.requiresManualApproval
          ? "pending_approval"
          : "rejected",
        chainId: signRequest.chainId,
        to: transfer.to,
        value: transfer.value,
        token: transfer.token,
        policyResults: evaluation.results,
        sponsorship: sponsorshipPayload,
      });
      return c.json<ApiResponse>(
        {
          ok: evaluation.requiresManualApproval,
          error: evaluation.requiresManualApproval
            ? undefined
            : "Transfer rejected by policy",
          data: response,
        },
        evaluation.requiresManualApproval ? 202 : 403,
      );
    }

    let completedResult: string | null = null;
    let completedStatus: "broadcast" | "signed" | null = null;
    try {
      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "wallet_action.transfer.authorized",
        resourceType: "wallet_action",
        resourceId: actionId,
        metadata: {
          chainId: signRequest.chainId,
          to: transfer.to,
          value: transfer.value,
          token: transfer.token,
          broadcast: transfer.broadcast,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });
      const reservationError = await recordSponsoredActionIfNeeded({
        sponsorship: sponsorshipPayload,
        tenantId,
        agentId,
        txId: actionId,
        chainId: signRequest.chainId,
        caip2: toCaip2(signRequest.chainId),
        actionType: "transfer",
        status: "reserved",
      });
      if (typeof reservationError === "string") {
        return c.json<ApiResponse>({ ok: false, error: reservationError }, 403);
      }
      let result: string;
      if (isSolanaTokenTransfer) {
        if (!signRequest.data) {
          throw new Error("SPL transfer transaction was not built");
        }
        await db.insert(transactions).values({
          id: actionId,
          agentId,
          status: "pending",
          toAddress: transfer.to,
          value: transfer.value,
          data: signRequest.data,
          chainId: transfer.chainId,
          actionType: "transfer",
          actionPayload: transferActionPayload({
            token: transfer.token,
            recipient: transfer.to,
            amount: transfer.value,
            broadcast: transfer.broadcast,
            referenceId: transfer.referenceId,
            sponsorship: sponsorshipPayload,
          }),
          policyResults: evaluation.results,
        });
        const signed = await vault.signSolanaTransaction({
          agentId,
          tenantId,
          transaction: signRequest.data,
          chainId: transfer.chainId,
          broadcast: transfer.broadcast,
          // SEC-163: SPL token transfers carry no vault-layer envelope (the
          // byte-level check only models native SOL transfers); the edge
          // policy evaluation above approved this transfer.
          allowBlindSign: true,
        });
        result = signed.signature;
      } else {
        result = await vault.signTransaction(signRequest, {
          txId: actionId,
          policyResults: evaluation.results,
          status: transfer.broadcast ? "broadcast" : "signed",
        });
      }
      const txStatus = transfer.broadcast ? "broadcast" : "signed";
      completedResult = result;
      completedStatus = txStatus;
      const signedTx = transfer.broadcast ? undefined : result;
      await db
        .update(transactions)
        .set({
          status: txStatus,
          txHash: transfer.broadcast ? result : undefined,
          actionType: "transfer",
          actionPayload: transferActionPayload({
            token: transfer.token,
            recipient: transfer.to,
            amount: transfer.value,
            broadcast: transfer.broadcast,
            referenceId: transfer.referenceId,
            sponsorship: sponsorshipPayload,
          }),
          policyResults: evaluation.results,
          signedAt: new Date(),
        })
        .where(eq(transactions.id, actionId));

      if (transfer.broadcast) {
        recordVaultSpend(
          agentId,
          tenantId,
          signRequest.value,
          signRequest.chainId,
        ).catch((err) =>
          logger.error(
            {
              details: [
                "[vault] Failed to record transfer action spend",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          ),
        );
      }
      await recordSponsoredActionIfNeeded({
        sponsorship: sponsorshipPayload,
        tenantId,
        agentId,
        txId: actionId,
        chainId: signRequest.chainId,
        caip2: toCaip2(signRequest.chainId),
        txHash: transfer.broadcast ? result : undefined,
        actionType: "transfer",
        status: transfer.broadcast ? "submitted" : "signed",
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "wallet_action.transfer.succeeded",
        resourceType: "wallet_action",
        resourceId: actionId,
        metadata: {
          chainId: signRequest.chainId,
          to: transfer.to,
          value: transfer.value,
          token: transfer.token,
          broadcast: transfer.broadcast,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          txHash: transfer.broadcast ? result : undefined,
        },
      });
      dispatchWebhook(tenantId, agentId, "wallet_action.transfer.succeeded", {
        actionId,
        txHash: transfer.broadcast ? result : undefined,
      });
      if (transfer.broadcast) {
        dispatchTransactionLifecycleWebhook(
          tenantId,
          agentId,
          "transaction.broadcasted",
          {
            txId: actionId,
            txHash: result,
            chainId: signRequest.chainId,
            status: "broadcast",
          },
        );
      }

      return c.json<ApiResponse>({
        ok: true,
        data: transferActionResponse({
          actionId,
          status: txStatus,
          chainId: signRequest.chainId,
          to: transfer.to,
          value: transfer.value,
          token: transfer.token,
          txHash: transfer.broadcast ? result : undefined,
          signedTx,
          sponsorship: sponsorshipPayload,
          policyResults: evaluation.results,
        }),
      });
    } catch (e: unknown) {
      const frozen = frozenSigningResponse(c, e);
      if (frozen) return frozen;
      if (completedResult && completedStatus) {
        await db
          .update(transactions)
          .set({
            status: completedStatus,
            txHash: transfer.broadcast ? completedResult : undefined,
            actionType: "transfer",
            actionPayload: transferActionPayload({
              token: transfer.token,
              recipient: transfer.to,
              amount: transfer.value,
              broadcast: transfer.broadcast,
              referenceId: transfer.referenceId,
              sponsorship: sponsorshipPayload,
            }),
            policyResults: evaluation.results,
            signedAt: new Date(),
          })
          .where(eq(transactions.id, actionId))
          .catch(() => null);

        return c.json<ApiResponse>({
          ok: true,
          data: transferActionResponse({
            actionId,
            status: completedStatus,
            chainId: signRequest.chainId,
            to: transfer.to,
            value: transfer.value,
            token: transfer.token,
            txHash: transfer.broadcast ? completedResult : undefined,
            signedTx: transfer.broadcast ? undefined : completedResult,
            sponsorship: sponsorshipPayload,
            policyResults: evaluation.results,
          }),
        });
      }
      await db.insert(transactions).values({
        id: actionId,
        agentId,
        status: "failed",
        toAddress: signRequest.to,
        value: signRequest.value,
        data: signRequest.data,
        chainId: signRequest.chainId,
        actionType: "transfer",
        actionPayload: transferActionPayload({
          token: transfer.token,
          recipient: transfer.to,
          amount: transfer.value,
          broadcast: signRequest.broadcast !== false,
          referenceId: transfer.referenceId,
          sponsorship: sponsorshipPayload,
        }),
        policyResults: evaluation.results,
      });
      await recordSponsoredActionIfNeeded({
        sponsorship: sponsorshipPayload,
        tenantId,
        agentId,
        txId: actionId,
        chainId: signRequest.chainId,
        caip2: toCaip2(signRequest.chainId),
        actionType: "transfer",
        status: "failed",
      });
      const error = isRpcError(e)
        ? extractRpcErrorMessage(e)
        : sanitizeErrorMessage(e);
      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "wallet_action.transfer.failed",
        resourceType: "wallet_action",
        resourceId: actionId,
        metadata: { error },
      });
      dispatchWebhook(tenantId, agentId, "wallet_action.transfer.failed", {
        actionId,
        error,
      });
      return c.json<ApiResponse>(
        { ok: false, error, data: { actionId } },
        isRpcError(e) ? 502 : 500,
      );
    }
  });
});

vaultRoutes.get("/:agentId/actions/:actionId", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Transaction lifecycle updates require owner or admin session with recent MFA",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const actionId = c.req.param("actionId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet action not found" },
      404,
    );

  const [row] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, actionId),
        eq(transactions.agentId, agentId),
        eq(transactions.actionType, "transfer"),
      ),
    );
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet action not found" },
      404,
    );
  const actionPayload = getTransferActionPayload(row.actionPayload);
  if (!actionPayload) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet action not found" },
      404,
    );
  }

  const status =
    row.status === "pending"
      ? "pending_approval"
      : row.status === "rejected"
        ? "rejected"
        : row.status === "broadcast"
          ? "broadcast"
          : row.status === "confirmed"
            ? "confirmed"
            : row.status === "failed"
              ? "failed"
              : row.status === "outcome_unknown"
                ? "outcome_unknown"
                : "signed";
  return c.json<ApiResponse>({
    ok: true,
    data: {
      id: row.id,
      type: "transfer",
      status,
      chainId: row.chainId,
      to: actionPayload.recipient ?? row.toAddress,
      value: actionPayload.amount ?? row.value,
      token: actionPayload.token,
      txHash: row.txHash ?? undefined,
      policyResults: row.policyResults,
      createdAt: row.createdAt.toISOString(),
      signedAt: row.signedAt?.toISOString(),
      confirmedAt: row.confirmedAt?.toISOString(),
    },
  });
});

// ─── Approve transaction ──────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/approve/:txId", async (c) => {
  if (!hasTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction approval requires owner or admin session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction approval requires recent MFA verification",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const actorId = c.get("userId") ?? tenantId;
  if (!(await hasCurrentTenantAdminMembership(tenantId, c.get("userId")))) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Transaction approval requires an active owner or admin tenant membership at review time",
      },
      403,
    );
  }
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const [transaction] = await db
    .select({
      transaction: transactions,
      approval: {
        requestedByType: approvalQueue.requestedByType,
        requestedById: approvalQueue.requestedById,
      },
    })
    .from(transactions)
    .innerJoin(
      approvalQueue,
      and(
        eq(approvalQueue.txId, transactions.id),
        eq(approvalQueue.agentId, transactions.agentId),
        eq(approvalQueue.status, "pending"),
      ),
    )
    .where(
      and(
        eq(transactions.id, txId),
        eq(transactions.agentId, agentId),
        eq(transactions.status, "pending"),
      ),
    );
  if (!transaction) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );
  }
  const pendingApproval = transaction.approval;
  const transactionRow = transaction.transaction;
  const approverPrincipal = approvalPrincipal(c, agentId);
  if (isSameApprovalPrincipal(pendingApproval, approverPrincipal)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Manual approval requires separation of duties from the requester",
      },
      403,
    );
  }

  const isSolana =
    transactionRow.chainId === 101 || transactionRow.chainId === 102;
  const transferPayload =
    transactionRow.actionType === "transfer"
      ? getTransferActionPayload(transactionRow.actionPayload)
      : null;
  const sendCallsPayload =
    transactionRow.actionType === "send_calls"
      ? getSendCallsActionPayload(transactionRow.actionPayload)
      : null;
  // Validate the stored transaction action payload strictly. A malformed present
  // field (wrong-type broadcast, string/float/negative/unsafe nonce, wrong-type
  // gasLimit/venue/walletAddress) THROWS here rather than being silently
  // coerced/dropped. We fail closed with a specific rejection audit and 409 so
  // no mutated intent can ever reach the replay digest / raw signer.
  let transactionPayload: ReturnType<typeof getTransactionActionPayload> = null;
  if (
    !transactionRow.actionType ||
    transactionRow.actionType === "transaction"
  ) {
    try {
      transactionPayload = getTransactionActionPayload(
        transactionRow.actionPayload,
      );
    } catch (error) {
      if (error instanceof TransactionActionPayloadValidationError) {
        const malformedField = error.field;
        await writeVaultAudit(c, {
          tenantId,
          actorType: "user",
          actorId,
          action: "vault.execution_authorization.rejected",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            agentId,
            reason: "malformed_transaction_action_payload",
            field: malformedField,
          },
        });
        return c.json<ApiResponse>(
          {
            ok: false,
            error:
              "This pending EVM approval has a malformed transaction action payload and cannot be replayed. Resubmit the transaction.",
          },
          409,
        );
      }
      throw error;
    }
  }
  const isSendCallsAction = sendCallsPayload !== null;
  if (
    transactionRow.actionType === "send_calls" ||
    transactionRow.actionType === "user_operation" ||
    transactionRow.actionType === "authorization"
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          transactionRow.actionType === "send_calls"
            ? "Approval execution for batch call actions is disabled until typed batch replay is implemented"
            : "Approval execution for unsafe account-abstraction actions is disabled until typed replay is implemented",
      },
      403,
    );
  }
  await writeVaultAudit(c, {
    tenantId,
    actorType: "user",
    actorId,
    action: transferPayload
      ? "wallet_action.transfer.approve.authorized"
      : isSendCallsAction
        ? "wallet_action.send_calls.approve.authorized"
        : "vault.approve.authorized",
    resourceType:
      transferPayload || isSendCallsAction ? "wallet_action" : "transaction",
    resourceId: txId,
    metadata: {
      agentId,
      chainId: transactionRow.chainId,
      to: transactionRow.toAddress,
      value: transactionRow.value,
      broadcast:
        transferPayload?.broadcast ??
        sendCallsPayload?.broadcast ??
        transactionPayload?.broadcast,
    },
  });

  return withAgentSpendLock(agentId, async () => {
    const resolvedAt = new Date();
    let irreversibleResult = false;
    let completedTxHash: string | null = null;
    try {
      const requestedBroadcast = transferPayload
        ? transferPayload.broadcast
        : sendCallsPayload
          ? sendCallsPayload.broadcast
          : transactionPayload
            ? transactionPayload.broadcast
            : true;
      const shouldBroadcast = requestedBroadcast !== false;
      const approvalSignRequest: SignRequest = {
        ...toSignRequest(transactionRow),
        tenantId,
        nonce: transactionPayload?.nonce,
        gasLimit:
          transferPayload &&
          transferPayload.token !== "native" &&
          transactionRow.data
            ? "65000"
            : transactionPayload?.gasLimit,
        broadcast: requestedBroadcast,
        venue: transactionPayload?.venue,
        walletAddress: transactionPayload?.walletAddress,
      };
      const currentPolicySet = await getScopedPolicySet(
        tenantId,
        agentId,
        c.get("agentPolicyIds"),
      );
      const currentExecutionPolicyRevisionHash =
        policyRevisionHashForPolicySet(currentPolicySet);
      // A row that is neither Solana, nor a transfer action, nor a send_calls
      // action would, on the EVM path, reach the raw Vault.signTransaction
      // fallback. Every such row is a raw-EVM-signing candidate and MUST be
      // proven to be a validated primary EVM approval (typed transaction action
      // payload + non-null stored digest + non-null stored policy revision +
      // digest match). If any invariant is absent/malformed we reject fail-closed
      // here and NEVER route to raw signing. This closes the legacy/null-digest
      // and malformed-actionPayload replay-fail-open holes.
      const isRawEvmSigningCandidate =
        !isSolana && transferPayload === null && !isSendCallsAction;
      const isPrimaryEvmApproval =
        isRawEvmSigningCandidate && transactionPayload !== null;

      const failClosed = async (
        reason: string,
        error: string,
        replayPayloadDigest: string | null,
        extraMetadata?: Record<string, unknown>,
      ) => {
        await writeVaultAudit(c, {
          tenantId,
          actorType: "user",
          actorId,
          action: "vault.execution_authorization.rejected",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            agentId,
            reason,
            hasTransactionActionPayload: transactionPayload !== null,
            hasStoredPayloadDigest:
              transactionRow.executionPayloadDigest !== null,
            hasStoredPolicyRevisionHash:
              transactionRow.executionPolicyRevisionHash !== null,
            storedPayloadDigest: transactionRow.executionPayloadDigest,
            replayPayloadDigest,
            ...extraMetadata,
          },
        });
        return c.json<ApiResponse>({ ok: false, error }, 409);
      };

      // Compute the replay digest inside a guarded block. The shared normalizer
      // throws ExecutionPayloadNormalizationError on any malformed numeric caller
      // field (e.g. an unsafe-integer nonce). Previously this threw BEFORE the
      // failClosed helper and the outer catch only handles GovernedVaultError, so
      // signing was prevented but no specific rejection audit was produced. We now
      // convert it into the same fail-closed 409 path with a specific reason.
      let approvalExecutionPayloadDigest: string | null = null;
      let approvalExecutionTarget: Awaited<
        ReturnType<typeof vault.resolveExecutionTarget>
      > = {
        backend: "local-vault",
      };
      if (isPrimaryEvmApproval) {
        try {
          approvalExecutionPayloadDigest =
            executionPayloadDigestForEvmSign(approvalSignRequest);
        } catch (error) {
          if (error instanceof ExecutionPayloadNormalizationError) {
            return failClosed(
              "malformed_transaction_action_payload",
              "This pending EVM approval has a malformed transaction action payload and cannot be replayed. Resubmit the transaction.",
              null,
              { field: error.field, error: error.message },
            );
          }
          throw error;
        }
      }

      if (isRawEvmSigningCandidate) {
        // 1. Require a valid typed transaction action payload. Missing or
        //    malformed action metadata must never fall through to raw signing.
        if (!isPrimaryEvmApproval) {
          return failClosed(
            "missing_or_malformed_transaction_action_payload",
            "This pending EVM approval lacks a valid typed transaction action payload and cannot be replayed. Resubmit the transaction.",
            approvalExecutionPayloadDigest,
          );
        }
        // 2. Require a non-null stored execution payload digest. Legacy/null-digest
        //    rows minted before the gateway must be resubmitted, never raw-signed.
        if (!transactionRow.executionPayloadDigest) {
          return failClosed(
            "missing_stored_execution_payload_digest",
            "This pending EVM approval predates execution-authorization binding (no stored payload digest) and cannot be replayed. Resubmit the transaction.",
            approvalExecutionPayloadDigest,
          );
        }
        // 3. Require a non-null stored execution policy revision hash. Binds the
        //    approval decision to the policy snapshot evaluated at queue time.
        if (!transactionRow.executionPolicyRevisionHash) {
          return failClosed(
            "missing_stored_execution_policy_revision_hash",
            "This pending EVM approval predates policy-revision binding (no stored policy revision hash) and cannot be replayed. Resubmit the transaction.",
            approvalExecutionPayloadDigest,
          );
        }
        // 4. Require the stored digest (from the immutable approval snapshot) to
        //    equal the digest recomputed from the replay request. This prevents
        //    any post-queue mutation of the approved caller intent.
        if (
          transactionRow.executionPayloadDigest !==
          approvalExecutionPayloadDigest
        ) {
          return failClosed(
            "stored_digest_mismatch",
            "Pending transaction digest no longer matches the replay request",
            approvalExecutionPayloadDigest,
          );
        }
        // 5. Re-resolve the exact custody provider/key/address identity at
        //    approval time and require it to match the immutable queued
        //    snapshot. The authorization minted below repeats this commitment,
        //    and raw signing performs one final fresh re-resolution.
        approvalExecutionTarget = await vault.resolveExecutionTarget({
          tenantId,
          agentId,
          chainId: approvalSignRequest.chainId,
          venue: approvalSignRequest.venue,
          walletAddress: approvalSignRequest.walletAddress,
        });
        // 0087 adds the custody commitment after payload/policy binding already
        // existed. A pre-0087 row with NULL backend can safely mean ONLY the
        // legacy local vault: external custody did not have a governed approval
        // path. Preserve those local approvals while still rejecting a NULL row
        // that now resolves to any external provider.
        const storedExecutionBackend =
          transactionRow.executionBackend ?? "local-vault";
        if (
          storedExecutionBackend !== approvalExecutionTarget.backend ||
          transactionRow.executionBackendIdentityDigest !==
            (approvalExecutionTarget.backendIdentityDigest ?? null)
        ) {
          return failClosed(
            "custody_identity_changed_since_approval_request",
            "The custody provider, key, or address changed after this approval was requested. Resubmit the transaction.",
            approvalExecutionPayloadDigest,
            {
              storedBackend: storedExecutionBackend,
              storedBackendIdentityDigest:
                transactionRow.executionBackendIdentityDigest,
              resolvedBackend: approvalExecutionTarget.backend,
              resolvedBackendIdentityDigest:
                approvalExecutionTarget.backendIdentityDigest,
            },
          );
        }
      }
      const currentRateLimitResult = await enforceRateLimit(
        agentId,
        currentPolicySet,
      );
      if (!currentRateLimitResult.allowed) {
        if (currentRateLimitResult.headers) {
          for (const [key, value] of Object.entries(
            currentRateLimitResult.headers,
          )) {
            c.header(key, value);
          }
        }
        return c.json<ApiResponse>(
          {
            ok: false,
            error: currentRateLimitResult.reason || "Rate limit exceeded",
          },
          429,
        );
      }
      if (currentRateLimitResult.headers) {
        for (const [key, value] of Object.entries(
          currentRateLimitResult.headers,
        )) {
          c.header(key, value);
        }
      }
      const currentConditionSets = await loadConditionSetsForPolicies(
        tenantId,
        currentPolicySet,
      );
      const stats = await getTransactionStats(
        agentId,
        approvalSignRequest.chainId,
      );
      const currentTransferPrecheckFailure =
        isSolana &&
        transferPayload !== null &&
        transferPayload.token !== "native" &&
        transactionRow.toAddress
          ? splTransferPolicyPrecheck(
              currentPolicySet,
              transactionRow.toAddress,
              transferPayload.token,
            )
          : null;
      const currentEvaluation = currentTransferPrecheckFailure
        ? {
            approved: false,
            requiresManualApproval: false,
            results: [currentTransferPrecheckFailure],
          }
        : await policyEngine.evaluate(currentPolicySet, {
            request: approvalSignRequest,
            recentTxCount1h: stats.recentTxCount1h,
            recentTxCount24h: stats.recentTxCount24h,
            spentToday: stats.spentToday,
            spentThisWeek: stats.spentThisWeek,
            additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
            additionalUsdSpentThisWeekMicros:
              stats.additionalUsdSpentThisWeekMicros,
            priceOracle,
            conditionSets: currentConditionSets,
          });

      if (
        !currentEvaluation.approved &&
        !currentEvaluation.requiresManualApproval
      ) {
        await db
          .update(transactions)
          .set({ status: "rejected", policyResults: currentEvaluation.results })
          .where(
            and(eq(transactions.id, txId), eq(transactions.agentId, agentId)),
          );
        await db
          .update(approvalQueue)
          .set({
            status: "rejected",
            resolvedAt,
            resolvedBy: `${approverPrincipal.type}:${approverPrincipal.id}`,
            resolvedByType: approverPrincipal.type,
            resolvedById: approverPrincipal.id,
          })
          .where(
            and(
              eq(approvalQueue.txId, txId),
              eq(approvalQueue.agentId, agentId),
              eq(approvalQueue.status, "pending"),
            ),
          );
        await writeVaultAudit(c, {
          tenantId,
          actorType: "user",
          actorId,
          action: "vault.approve.rejected_by_current_policy",
          resourceType:
            transferPayload || isSendCallsAction
              ? "wallet_action"
              : "transaction",
          resourceId: txId,
          metadata: {
            agentId,
            chainId: transactionRow.chainId,
            to: transactionRow.toAddress,
            value: transactionRow.value,
            policyResults: currentEvaluation.results,
          },
        });
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Pending transaction no longer satisfies current policy",
            data: { txId, results: currentEvaluation.results },
          },
          403,
        );
      }

      const claimResult = await db
        .update(approvalQueue)
        .set({
          status: "approved",
          resolvedAt,
          resolvedBy: `${approverPrincipal.type}:${approverPrincipal.id}`,
          resolvedByType: approverPrincipal.type,
          resolvedById: approverPrincipal.id,
        })
        .where(
          and(
            eq(approvalQueue.txId, txId),
            eq(approvalQueue.agentId, agentId),
            eq(approvalQueue.status, "pending"),
          ),
        )
        .returning();

      if (claimResult.length === 0) {
        return c.json<ApiResponse>(
          { ok: false, error: "Transaction already processed or not found" },
          409,
        );
      }
      if (
        transferPayload?.sponsorship?.sponsored === true &&
        !shouldBroadcast
      ) {
        await db
          .update(approvalQueue)
          .set({
            status: "pending",
            resolvedAt: null,
            resolvedBy: null,
            resolvedByType: null,
            resolvedById: null,
          })
          .where(
            and(
              eq(approvalQueue.txId, txId),
              eq(approvalQueue.agentId, agentId),
            ),
          );
        return c.json<ApiResponse>(
          {
            ok: false,
            error:
              "Gas sponsorship requires broadcast=true because signed-only actions do not spend sponsored gas",
          },
          400,
        );
      }
      if (transferPayload) {
        const reservationError = await recordSponsoredActionIfNeeded({
          sponsorship: transferPayload.sponsorship,
          tenantId,
          agentId,
          txId,
          chainId: transactionRow.chainId,
          caip2: toCaip2(transactionRow.chainId),
          actionType: "transfer",
          status: "reserved",
        });
        if (typeof reservationError === "string") {
          await db
            .update(approvalQueue)
            .set({
              status: "pending",
              resolvedAt: null,
              resolvedBy: null,
              resolvedByType: null,
              resolvedById: null,
            })
            .where(
              and(
                eq(approvalQueue.txId, txId),
                eq(approvalQueue.agentId, agentId),
              ),
            );
          return c.json<ApiResponse>(
            { ok: false, error: reservationError },
            403,
          );
        }
      }
      dispatchIntentWebhook(tenantId, agentId, "intent.authorized", {
        intentId: txId,
        actionType: transactionRow.actionType,
        status: "authorized",
        referenceId: actionReferenceId(transactionRow.actionPayload),
        policyResults: transactionRow.policyResults,
      });

      let txHash: string;

      if (isSolana) {
        if (!transactionRow.data) {
          throw new Error(
            "Solana transaction blob not found; cannot replay approval",
          );
        }
        const isSolanaTokenTransfer =
          transferPayload !== null && transferPayload.token !== "native";
        const result = await vault.signSolanaTransaction({
          agentId,
          tenantId,
          transaction: transactionRow.data,
          chainId: transactionRow.chainId,
          broadcast: shouldBroadcast,
          // SEC-163: token transfers have no vault-layer envelope — the
          // approval-queue policy grant above stands in for it (allowBlindSign);
          // native transfers keep the byte-level envelope assertion.
          ...(isSolanaTokenTransfer
            ? { allowBlindSign: true }
            : {
                expectedTo: transactionRow.toAddress,
                expectedValue: transactionRow.value,
              }),
        });
        txHash = result.signature;
        irreversibleResult = shouldBroadcast;
        if (shouldBroadcast) completedTxHash = txHash;
      } else {
        if (isPrimaryEvmApproval && approvalExecutionPayloadDigest) {
          const executionAuthorization = await mintExecutionAuthorization({
            requestId: txId,
            tenantId,
            agentId,
            capability: "wallet.sign_transaction",
            payloadDigest: approvalExecutionPayloadDigest,
            backend: approvalExecutionTarget.backend,
            backendIdentityDigest:
              approvalExecutionTarget.backendIdentityDigest,
            policyRevisionHash: currentExecutionPolicyRevisionHash,
            approvalId: txId,
            idempotencyKey: c.req.header("Idempotency-Key") ?? undefined,
          });
          await writeVaultAudit(c, {
            tenantId,
            actorType: "user",
            actorId,
            action: "vault.execution_authorization.minted",
            resourceType: "execution_authorization",
            resourceId: executionAuthorization.id,
            metadata: {
              txId,
              payloadDigest: approvalExecutionPayloadDigest,
              originalPayloadDigest: transactionRow.executionPayloadDigest,
              originalPolicyRevisionHash:
                transactionRow.executionPolicyRevisionHash,
              policyRevisionHash: currentExecutionPolicyRevisionHash,
              backend: approvalExecutionTarget.backend,
              backendIdentityDigest:
                approvalExecutionTarget.backendIdentityDigest,
              approvalId: txId,
              expiresAt: executionAuthorization.expiresAt,
            },
          });
          const governedVault = new GovernedVault(
            vault,
            async (authorization, expected) => {
              try {
                await consumeExecutionAuthorization(authorization, expected);
                await writeVaultAudit(c, {
                  tenantId,
                  actorType: "user",
                  actorId,
                  action: "vault.execution_authorization.consumed",
                  resourceType: "execution_authorization",
                  resourceId: authorization.id,
                  metadata: {
                    txId,
                    payloadDigest: expected.payloadDigest,
                    capability: expected.capability,
                    backend: expected.backend,
                  },
                });
              } catch (error) {
                await writeVaultAudit(c, {
                  tenantId,
                  actorType: "user",
                  actorId,
                  action: "vault.execution_authorization.rejected",
                  resourceType: "execution_authorization",
                  resourceId: authorization.id,
                  metadata: {
                    txId,
                    payloadDigest: expected.payloadDigest,
                    ...redactedThrownDiagnostics(error),
                  },
                });
                throw error;
              }
            },
          );
          txHash = await governedVault.signTransactionAuthorized(
            approvalSignRequest,
            {
              txId,
              policyResults: currentEvaluation.results,
              status: shouldBroadcast ? "broadcast" : "signed",
              executionAuthorization,
              executionPayloadDigest: approvalExecutionPayloadDigest,
            },
          );
        } else {
          // Defense-in-depth: the fail-closed gate above returns early for every
          // raw-EVM-signing candidate that is not a validated primary EVM
          // approval, so this raw fallback must only ever handle non-primary EVM
          // action surfaces (transfer). A raw-EVM-signing candidate reaching here
          // is an invariant violation, not a signable request.
          if (isRawEvmSigningCandidate) {
            throw new Error(
              "invariant: primary EVM approval reached raw signer without gateway authorization",
            );
          }
          txHash = await vault.signTransaction(approvalSignRequest, {
            txId,
            policyResults: currentEvaluation.results,
            status: shouldBroadcast ? "broadcast" : "signed",
          });
        }
        irreversibleResult = shouldBroadcast;
        if (shouldBroadcast) completedTxHash = txHash;
      }

      const nextStatus = transferPayload
        ? transferPayload.broadcast === false
          ? "signed"
          : "broadcast"
        : sendCallsPayload
          ? sendCallsPayload.broadcast === false
            ? "signed"
            : "broadcast"
          : transactionPayload?.broadcast === false
            ? "signed"
            : "broadcast";
      await db
        .update(transactions)
        .set({
          status: nextStatus,
          txHash: shouldBroadcast ? txHash : null,
          executionPayloadDigest:
            approvalExecutionPayloadDigest ??
            transactionRow.executionPayloadDigest,
          executionPolicyRevisionHash: isPrimaryEvmApproval
            ? currentExecutionPolicyRevisionHash
            : transactionRow.executionPolicyRevisionHash,
          policyResults: currentEvaluation.results,
          actionPayload: transferPayload
            ? transferActionPayload({
                token: transferPayload.token,
                recipient:
                  transferPayload.recipient ?? transactionRow.toAddress,
                amount: transferPayload.amount ?? transactionRow.value,
                broadcast: transferPayload.broadcast,
                referenceId: transferPayload.referenceId,
                sponsorship: transferPayload.sponsorship,
              })
            : transactionPayload
              ? transactionActionPayload({
                  broadcast: transactionPayload.broadcast,
                  referenceId: transactionPayload.referenceId,
                  nonce: transactionPayload.nonce,
                  gasLimit: transactionPayload.gasLimit,
                  venue: transactionPayload.venue,
                  walletAddress: transactionPayload.walletAddress,
                })
              : transactionRow.actionPayload,
          signedAt: resolvedAt,
        })
        .where(eq(transactions.id, txId));

      if (!isSolana && shouldBroadcast) {
        recordVaultSpend(
          agentId,
          tenantId,
          transactionRow.value,
          transactionRow.chainId,
        ).catch((err) =>
          logger.error(
            {
              details: [
                "[vault] Failed to record approved transaction spend",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          ),
        );
      }
      if (transferPayload) {
        await recordSponsoredActionIfNeeded({
          sponsorship: transferPayload.sponsorship,
          tenantId,
          agentId,
          txId,
          chainId: transactionRow.chainId,
          caip2: toCaip2(transactionRow.chainId),
          txHash: shouldBroadcast ? txHash : undefined,
          actionType: "transfer",
          status: shouldBroadcast ? "submitted" : "signed",
        });
      }

      await writeVaultAudit(c, {
        tenantId,
        actorType: "user",
        actorId,
        action: transferPayload
          ? "wallet_action.transfer.succeeded"
          : isSendCallsAction
            ? "wallet_action.send_calls.succeeded"
            : "vault.approve",
        resourceType:
          transferPayload || isSendCallsAction
            ? "wallet_action"
            : "transaction",
        resourceId: txId,
        metadata: {
          agentId,
          chainId: transactionRow.chainId,
          txHash: shouldBroadcast ? txHash : undefined,
          broadcast:
            transferPayload?.broadcast ??
            sendCallsPayload?.broadcast ??
            transactionPayload?.broadcast,
        },
      });

      if (transferPayload) {
        dispatchWebhook(tenantId, agentId, "wallet_action.transfer.succeeded", {
          actionId: txId,
          txHash: transferPayload.broadcast ? txHash : undefined,
        });
      } else if (isSendCallsAction) {
        dispatchWebhook(
          tenantId,
          agentId,
          "wallet_action.send_calls.succeeded",
          {
            actionId: txId,
            txHash: sendCallsPayload.broadcast ? txHash : undefined,
          },
        );
      } else {
        dispatchWebhook(tenantId, agentId, "tx_signed", {
          txId,
          txHash: shouldBroadcast ? txHash : undefined,
          signedTx: shouldBroadcast ? undefined : txHash,
        });
      }
      dispatchIntentWebhook(tenantId, agentId, "intent.executed", {
        intentId: txId,
        actionType: transactionRow.actionType,
        status: "executed",
        txHash: shouldBroadcast ? txHash : undefined,
        signedTx: shouldBroadcast ? undefined : txHash,
        referenceId: actionReferenceId(transactionRow.actionPayload),
        policyResults: transactionRow.policyResults,
      });
      if (shouldBroadcast) {
        dispatchTransactionLifecycleWebhook(
          tenantId,
          agentId,
          "transaction.broadcasted",
          {
            txId,
            txHash,
            chainId: transactionRow.chainId,
            status: "broadcast",
          },
        );
      }

      return c.json<
        ApiResponse<{ txId: string; txHash?: string; signedTx?: string }>
      >({
        ok: true,
        data: !shouldBroadcast ? { txId, signedTx: txHash } : { txId, txHash },
      });
    } catch (e: unknown) {
      if (e instanceof ExternalBroadcastOutcomeUnknownError) {
        irreversibleResult = true;
        completedTxHash = e.transactionHash;
      }
      const frozen = frozenSigningResponse(c, e);
      if (frozen) return frozen;
      const authorizationError = executionAuthorizationErrorResponse(c, e);
      const bindingMismatch = await backendBindingMismatchResponse(c, e, {
        tenantId,
        agentId,
        txId,
        chainId: transactionRow.chainId,
      });
      if (!irreversibleResult) {
        await db
          .update(approvalQueue)
          .set({
            status: "pending",
            resolvedAt: null,
            resolvedBy: null,
            resolvedByType: null,
            resolvedById: null,
          })
          .where(
            and(
              eq(approvalQueue.txId, txId),
              eq(approvalQueue.agentId, agentId),
            ),
          );
        if (transferPayload) {
          await recordSponsoredActionIfNeeded({
            sponsorship: transferPayload.sponsorship,
            tenantId,
            agentId,
            txId,
            chainId: transactionRow.chainId,
            caip2: toCaip2(transactionRow.chainId),
            actionType: "transfer",
            status: "failed",
          });
        }
      } else {
        try {
          await db
            .update(transactions)
            .set({
              status:
                e instanceof ExternalBroadcastOutcomeUnknownError
                  ? "outcome_unknown"
                  : "broadcast",
              txHash: completedTxHash ?? transactionRow.txHash ?? null,
              signedAt: resolvedAt,
            })
            .where(
              and(eq(transactions.id, txId), eq(transactions.agentId, agentId)),
            );
        } catch {
          // Approval execution already crossed the durable checkpoint. Keep
          // the approval terminal and preserve the typed response; reopening
          // here would permit a duplicate external broadcast.
          logger.error(
            {
              details: [
                "[vault] Failed to refresh approved irreversible transaction state",
              ],
            },
            "[Login:vault] error",
          );
        }
      }

      if (bindingMismatch) return bindingMismatch;
      if (authorizationError) return authorizationError;

      const outcomeUnknown = externalBroadcastOutcomeUnknownResponse(
        c,
        e,
        txId,
      );
      if (outcomeUnknown) {
        recordVaultSpend(
          agentId,
          tenantId,
          transactionRow.value,
          transactionRow.chainId,
        ).catch((err) =>
          logger.error(
            {
              details: [
                "[vault] Failed to record ambiguous approved spend",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          ),
        );
        try {
          await recordAggregationEvent({
            agentId,
            valueRaw: transactionRow.value,
            to: transactionRow.toAddress,
            chainId: transactionRow.chainId,
          });
        } catch (err) {
          logger.error(
            {
              details: [
                "[vault] Failed to record ambiguous approved aggregation event",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          );
        }
        await writeOutcomeUnknownAudit(c, {
          tenantId,
          actorType: "user",
          actorId,
          action: "vault.broadcast.outcome_unknown",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            agentId,
            txId,
            txHash: completedTxHash,
            chainId: transactionRow.chainId,
          },
        });
        return outcomeUnknown;
      }

      const requestId = c.get("requestId") || "unknown";
      const safeFailureMessage = "Transaction approval execution failed";
      logger.error(
        {
          details: [
            `[${requestId}] Approve transaction failed for agent ${agentId}, tx ${txId}`,
          ],
        },
        "[Login:vault] error",
      );

      if (irreversibleResult && completedTxHash) {
        logger.error(
          {
            details: [
              `[${requestId}] Approved transaction ${txId} broadcast before bookkeeping failed; returning broadcast result to prevent duplicate retry`,
            ],
          },
          "[Login:vault] error",
        );
        return c.json<ApiResponse<{ txId: string; txHash: string }>>({
          ok: true,
          data: { txId, txHash: completedTxHash },
        });
      }

      if (transactionRow.actionType === "send_calls") {
        dispatchWebhook(tenantId, agentId, "wallet_action.send_calls.failed", {
          actionId: txId,
          error: safeFailureMessage,
          requestId,
        });
      } else {
        dispatchWebhook(tenantId, agentId, "tx_failed", {
          txId,
          error: safeFailureMessage,
          requestId,
        });
      }
      dispatchIntentWebhook(tenantId, agentId, "intent.failed", {
        intentId: txId,
        actionType: transactionRow.actionType,
        status: "failed",
        error: safeFailureMessage,
        referenceId: actionReferenceId(transactionRow.actionPayload),
        policyResults: transactionRow.policyResults,
      });

      if (isRpcError(e)) {
        return c.json<ApiResponse>(
          { ok: false, error: extractRpcErrorMessage(e) },
          502,
        );
      }
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(e) },
        500,
      );
    }
  });
});

// ─── Reject transaction ───────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/reject/:txId", async (c) => {
  if (!hasTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejection requires owner or admin session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejection requires recent MFA verification",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const actorId = c.get("userId") ?? tenantId;
  const rejectorPrincipal = approvalPrincipal(c, agentId);
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  await writeVaultAudit(c, {
    tenantId,
    actorType: "user",
    actorId,
    action: "vault.reject.authorized",
    resourceType: "transaction",
    resourceId: txId,
    metadata: { agentId },
  });

  const [rejectedTransaction] = await db.transaction(async (tx) => {
    const rejectResult = await tx
      .update(approvalQueue)
      .set({
        status: "rejected",
        resolvedAt: new Date(),
        resolvedBy: `${rejectorPrincipal.type}:${rejectorPrincipal.id}`,
        resolvedByType: rejectorPrincipal.type,
        resolvedById: rejectorPrincipal.id,
      })
      .where(
        and(
          eq(approvalQueue.txId, txId),
          eq(approvalQueue.agentId, agentId),
          eq(approvalQueue.status, "pending"),
        ),
      )
      .returning();

    if (rejectResult.length === 0) return [];

    return tx
      .update(transactions)
      .set({ status: "rejected" })
      .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)))
      .returning({
        actionType: transactions.actionType,
        actionPayload: transactions.actionPayload,
        policyResults: transactions.policyResults,
      });
  });

  if (!rejectedTransaction) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction already processed or not found" },
      409,
    );
  }

  await writeVaultAudit(c, {
    tenantId,
    actorType: "user",
    actorId,
    action:
      rejectedTransaction?.actionType === "transfer"
        ? "wallet_action.transfer.rejected"
        : rejectedTransaction?.actionType === "send_calls"
          ? "wallet_action.send_calls.rejected"
          : "vault.reject",
    resourceType:
      rejectedTransaction?.actionType === "transfer" ||
      rejectedTransaction?.actionType === "send_calls"
        ? "wallet_action"
        : "transaction",
    resourceId: txId,
    metadata: { agentId },
  });

  if (rejectedTransaction?.actionType === "transfer") {
    dispatchWebhook(tenantId, agentId, "wallet_action.transfer.rejected", {
      actionId: txId,
    });
  } else if (rejectedTransaction?.actionType === "send_calls") {
    dispatchWebhook(tenantId, agentId, "wallet_action.send_calls.rejected", {
      actionId: txId,
    });
  }
  dispatchIntentWebhook(tenantId, agentId, "intent.rejected", {
    intentId: txId,
    actionType: rejectedTransaction?.actionType,
    status: "rejected",
    referenceId: actionReferenceId(rejectedTransaction?.actionPayload),
    policyResults: rejectedTransaction?.policyResults,
  });

  return c.json<ApiResponse>({ ok: true });
});

// ─── Pending approvals ────────────────────────────────────────────────────────

vaultRoutes.get("/:agentId/pending", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const pendingTransactions = await db
    .select({
      queueId: approvalQueue.id,
      status: approvalQueue.status,
      requestedAt: approvalQueue.requestedAt,
      transaction: transactions,
    })
    .from(approvalQueue)
    .innerJoin(transactions, eq(transactions.id, approvalQueue.txId))
    .where(
      and(
        eq(approvalQueue.agentId, agentId),
        eq(approvalQueue.status, "pending"),
        eq(transactions.agentId, agentId),
      ),
    )
    .orderBy(desc(approvalQueue.requestedAt))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({
    ok: true,
    data: {
      approvals: pendingTransactions.map((entry) => ({
        queueId: entry.queueId,
        status: entry.status,
        requestedAt: entry.requestedAt,
        transaction: toTxRecord(entry.transaction),
      })),
      limit,
      offset,
    },
  });
});

// ─── Transaction history ──────────────────────────────────────────────────────

vaultRoutes.get("/:agentId/history", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const history = await db
    .select()
    .from(transactions)
    .where(eq(transactions.agentId, agentId))
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({
    ok: true,
    data: { transactions: history.map(toTxRecord), limit, offset },
  });
});

vaultRoutes.get("/:agentId/transactions", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const status = c.req.query("status");
  const actionType = c.req.query("actionType");
  const txHash = c.req.query("txHash");
  const referenceId = parseReferenceId(
    c.req.query("referenceId") ?? c.req.query("reference_id"),
  );
  const allowedStatuses = new Set([
    "pending",
    "approved",
    "rejected",
    "signed",
    "broadcast",
    "confirmed",
    "failed",
    "outcome_unknown",
  ]);
  if (status && !allowedStatuses.has(status)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid transaction status filter" },
      400,
    );
  }
  if (referenceId === null) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "referenceId must be a non-empty string up to 128 characters",
      },
      400,
    );
  }

  const conditions: SQL[] = [eq(transactions.agentId, agentId)];
  if (status)
    conditions.push(
      eq(
        transactions.status,
        status as typeof transactions.$inferSelect.status,
      ),
    );
  if (actionType) conditions.push(eq(transactions.actionType, actionType));
  if (txHash) conditions.push(eq(transactions.txHash, txHash));
  if (referenceId) {
    conditions.push(
      sql`(${transactions.actionPayload}->>'referenceId' = ${referenceId} or ${transactions.actionPayload}->>'reference_id' = ${referenceId})`,
    );
  }

  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({
    ok: true,
    data: { transactions: rows.map(toTransactionResponse), limit, offset },
  });
});

vaultRoutes.get("/:agentId/transactions/:txId", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );
  }

  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)));

  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );

  return c.json<ApiResponse>({ ok: true, data: toTransactionResponse(row) });
});

vaultRoutes.post("/:agentId/transactions/:txId/lifecycle", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Transaction lifecycle updates require owner or admin session with recent MFA",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );
  }

  const body = await safeJsonParse<{
    type?: unknown;
    txHash?: unknown;
    replacementTxHash?: unknown;
    reason?: unknown;
    error?: unknown;
    provider?: unknown;
    blockNumber?: unknown;
    confirmations?: unknown;
    amount?: unknown;
    asset?: unknown;
    sender?: unknown;
    recipient?: unknown;
  }>(c);
  if (!isTransactionLifecycleEvent(body?.type)) {
    return c.json<ApiResponse>(
      { ok: false, error: "type must be a valid transaction lifecycle event" },
      400,
    );
  }

  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)));
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );

  const isBroadcastPromotion =
    body.type === "transaction.broadcasted" ||
    body.type === "transaction.confirmed" ||
    body.type === "transaction.replaced";
  if (
    (body.type === "transaction.broadcasted" ||
      body.type === "transaction.replaced") &&
    !["signed", "broadcast"].includes(row.status)
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Transaction must be signed or broadcast before this lifecycle event",
      },
      409,
    );
  }
  if (body.type === "transaction.confirmed" && row.status !== "broadcast") {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction must be broadcast before confirmation" },
      409,
    );
  }
  if (isBroadcastPromotion) {
    const [pendingApproval] = await db
      .select({ id: approvalQueue.id })
      .from(approvalQueue)
      .where(
        and(
          eq(approvalQueue.txId, txId),
          eq(approvalQueue.agentId, agentId),
          eq(approvalQueue.status, "pending"),
        ),
      );
    if (pendingApproval) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Pending approval must be resolved before lifecycle promotion",
        },
        409,
      );
    }
  }

  const txHash =
    typeof body.txHash === "string" && body.txHash.trim()
      ? body.txHash.trim()
      : null;
  const replacementTxHash =
    typeof body.replacementTxHash === "string" && body.replacementTxHash.trim()
      ? body.replacementTxHash.trim()
      : null;
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : undefined;
  const error =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : undefined;
  const provider =
    typeof body.provider === "string" && body.provider.trim()
      ? body.provider.trim()
      : undefined;
  const blockNumber =
    typeof body.blockNumber === "string" || typeof body.blockNumber === "number"
      ? body.blockNumber
      : undefined;
  const confirmations =
    typeof body.confirmations === "number" &&
    Number.isSafeInteger(body.confirmations)
      ? body.confirmations
      : undefined;
  const amount =
    typeof body.amount === "string" && body.amount.trim()
      ? body.amount.trim()
      : undefined;
  const asset =
    body.asset && typeof body.asset === "object" && !Array.isArray(body.asset)
      ? (body.asset as Record<string, unknown>)
      : undefined;
  const sender =
    typeof body.sender === "string" && body.sender.trim()
      ? body.sender.trim()
      : undefined;
  const recipient =
    typeof body.recipient === "string" && body.recipient.trim()
      ? body.recipient.trim()
      : undefined;

  const update: Partial<typeof transactions.$inferInsert> = {};
  let eventTxHash = txHash ?? row.txHash;
  let nextStatus = row.status;
  const now = new Date();

  switch (body.type) {
    case "transaction.broadcasted":
      if (!eventTxHash) {
        return c.json<ApiResponse>(
          { ok: false, error: "txHash is required" },
          400,
        );
      }
      update.status = "broadcast";
      update.txHash = eventTxHash;
      update.signedAt = row.signedAt ?? now;
      nextStatus = "broadcast";
      break;
    case "transaction.confirmed":
      if (txHash && row.txHash && txHash !== row.txHash) {
        return c.json<ApiResponse>(
          { ok: false, error: "txHash does not match transaction" },
          409,
        );
      }
      if (!eventTxHash) {
        return c.json<ApiResponse>(
          { ok: false, error: "txHash is required" },
          400,
        );
      }
      update.status = "confirmed";
      update.txHash = eventTxHash;
      update.confirmedAt = now;
      nextStatus = "confirmed";
      break;
    case "transaction.failed":
    case "transaction.provider_error":
    case "transaction.execution_reverted":
      update.status = "failed";
      if (txHash) update.txHash = txHash;
      nextStatus = "failed";
      break;
    case "transaction.replaced":
      if (!replacementTxHash) {
        return c.json<ApiResponse>(
          { ok: false, error: "replacementTxHash is required" },
          400,
        );
      }
      update.status = "broadcast";
      update.txHash = replacementTxHash;
      update.signedAt = row.signedAt ?? now;
      eventTxHash = replacementTxHash;
      nextStatus = "broadcast";
      break;
    case "transaction.still_pending":
      break;
    case "wallet.funds_deposited":
    case "wallet.funds_withdrawn":
      if (!eventTxHash) {
        return c.json<ApiResponse>(
          { ok: false, error: "txHash is required" },
          400,
        );
      }
      update.status = "confirmed";
      update.txHash = eventTxHash;
      update.confirmedAt = row.confirmedAt ?? now;
      nextStatus = "confirmed";
      break;
  }

  await writeVaultAudit(c, {
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? c.get("authType") ?? null,
    action: "transaction.lifecycle.authorized",
    resourceType: "transaction",
    resourceId: txId,
    metadata: {
      type: body.type,
      currentStatus: row.status,
      nextStatus,
      txHash: eventTxHash,
      previousTxHash:
        body.type === "transaction.replaced" ? row.txHash : undefined,
      replacementTxHash:
        body.type === "transaction.replaced" ? replacementTxHash : undefined,
      reason,
      error,
      provider,
      blockNumber,
      confirmations,
      amount,
      asset,
      sender,
      recipient,
    },
  });

  const [updated] =
    Object.keys(update).length > 0
      ? await db
          .update(transactions)
          .set(update)
          .where(
            and(eq(transactions.id, txId), eq(transactions.agentId, agentId)),
          )
          .returning()
      : [row];

  await writeVaultAudit(c, {
    tenantId,
    actorType: "agent",
    actorId: agentId,
    action: body.type,
    resourceType: "transaction",
    resourceId: txId,
    metadata: {
      txHash: eventTxHash,
      previousTxHash:
        body.type === "transaction.replaced" ? row.txHash : undefined,
      replacementTxHash:
        body.type === "transaction.replaced" ? replacementTxHash : undefined,
      status: nextStatus,
      reason,
      error,
      provider,
      blockNumber,
      confirmations,
      amount,
      asset,
      sender,
      recipient,
    },
  });

  if (
    body.type === "wallet.funds_deposited" ||
    body.type === "wallet.funds_withdrawn"
  ) {
    dispatchWalletFundsWebhook(tenantId, agentId, body.type, updated, {
      txHash: eventTxHash,
      walletAddress: agent.walletAddress,
      amount,
      asset,
      sender,
      recipient,
      blockNumber,
      confirmations,
      referenceId: actionReferenceId(row.actionPayload),
    });
  } else {
    dispatchTransactionLifecycleWebhook(tenantId, agentId, body.type, {
      txId,
      txHash: eventTxHash,
      previousTxHash:
        body.type === "transaction.replaced" ? row.txHash : undefined,
      replacementTxHash:
        body.type === "transaction.replaced" ? replacementTxHash : undefined,
      chainId: row.chainId,
      status: nextStatus,
      reason,
      error,
      provider,
      blockNumber,
      confirmations,
      referenceId: actionReferenceId(row.actionPayload),
      transactionRequest:
        body.type === "transaction.still_pending"
          ? transactionRequestPayload(row)
          : undefined,
    });
  }

  if (body.type === "transaction.confirmed") {
    const eventPayload = userOperationEventPayload(agentId, updated, {
      txHash: eventTxHash,
      status: "completed",
      blockNumber,
      confirmations,
    });
    if (eventPayload) {
      dispatchWebhook(
        tenantId,
        agentId,
        "user_operation.completed",
        eventPayload,
      );
    }
  } else if (
    body.type === "transaction.failed" ||
    body.type === "transaction.provider_error" ||
    body.type === "transaction.execution_reverted"
  ) {
    const eventPayload = userOperationEventPayload(agentId, updated, {
      txHash: eventTxHash,
      status: "failed",
      error,
      blockNumber,
      confirmations,
    });
    if (eventPayload) {
      dispatchWebhook(tenantId, agentId, "user_operation.failed", eventPayload);
    }
  }

  return c.json<ApiResponse>({
    ok: true,
    data: toTransactionResponse(updated),
  });
});

vaultRoutes.post("/:agentId/transactions/:txId/replace", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Transaction replacement requires owner or admin session with recent MFA",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );
  }

  const body = await safeJsonParse<{
    replacementTxHash?: unknown;
    reason?: unknown;
    provider?: unknown;
    blockNumber?: unknown;
    confirmations?: unknown;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const replacementTxHash =
    typeof body.replacementTxHash === "string" && body.replacementTxHash.trim()
      ? body.replacementTxHash.trim()
      : null;
  if (!replacementTxHash) {
    return c.json<ApiResponse>(
      { ok: false, error: "replacementTxHash is required" },
      400,
    );
  }

  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)));
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction not found" },
      404,
    );
  if (!["signed", "broadcast"].includes(row.status)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction must be signed or broadcast before replacement",
      },
      409,
    );
  }

  const [pendingApproval] = await db
    .select({ id: approvalQueue.id })
    .from(approvalQueue)
    .where(
      and(
        eq(approvalQueue.txId, txId),
        eq(approvalQueue.agentId, agentId),
        eq(approvalQueue.status, "pending"),
      ),
    );
  if (pendingApproval) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Pending approval must be resolved before replacement",
      },
      409,
    );
  }

  const reason =
    typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : undefined;
  const provider =
    typeof body?.provider === "string" && body.provider.trim()
      ? body.provider.trim()
      : undefined;
  const blockNumber =
    typeof body?.blockNumber === "string" ||
    typeof body?.blockNumber === "number"
      ? body.blockNumber
      : undefined;
  const confirmations =
    typeof body?.confirmations === "number" &&
    Number.isSafeInteger(body.confirmations)
      ? body.confirmations
      : undefined;
  const now = new Date();

  await writeVaultAudit(c, {
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? c.get("authType") ?? null,
    action: "transaction.replace.authorized",
    resourceType: "transaction",
    resourceId: txId,
    metadata: {
      currentStatus: row.status,
      nextStatus: "broadcast",
      previousTxHash: row.txHash,
      replacementTxHash,
      reason,
      provider,
      blockNumber,
      confirmations,
    },
  });

  const [updated] = await db
    .update(transactions)
    .set({
      status: "broadcast",
      txHash: replacementTxHash,
      signedAt: row.signedAt ?? now,
    })
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)))
    .returning();

  await writeVaultAudit(c, {
    tenantId,
    actorType: "agent",
    actorId: agentId,
    action: "transaction.replaced",
    resourceType: "transaction",
    resourceId: txId,
    metadata: {
      txHash: replacementTxHash,
      previousTxHash: row.txHash,
      replacementTxHash,
      status: "broadcast",
      reason,
      provider,
      blockNumber,
      confirmations,
    },
  });

  dispatchTransactionLifecycleWebhook(
    tenantId,
    agentId,
    "transaction.replaced",
    {
      txId,
      txHash: replacementTxHash,
      previousTxHash: row.txHash,
      replacementTxHash,
      chainId: row.chainId,
      status: "broadcast",
      reason,
      provider,
      blockNumber,
      confirmations,
      referenceId: actionReferenceId(row.actionPayload),
    },
  );

  return c.json<ApiResponse>({
    ok: true,
    data: toTransactionResponse(updated),
  });
});

// ─── EIP-712 Typed Data Signing ───────────────────────────────────────────────

// ─── Sign arbitrary message (personal_sign / eth_sign) ───────────────────────────────
//
// Used by server-to-server flows that need an off-chain signature from an
// agent (e.g. four.meme SIWE login). EVM uses viem's personal_sign over the
// UTF-8 bytes of the message. Solana uses Ed25519 over the message bytes.
//
// POST /vault/:agentId/sign-message
// body: { "message": "<string>" }
// resp: { ok: true, data: { signature: "0x..." } }
vaultRoutes.post("/:agentId/sign-message", async (c) => {
  if (!allowUnsafeMessageSigning() || !allowVaultUnsafeMessageSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Message signing is disabled because arbitrary signatures bypass transaction policy controls. Set STEWARD_ALLOW_UNSAFE_MESSAGE_SIGNING=true and STEWARD_ALLOW_VAULT_UNSAFE_MESSAGE_SIGNING=true only for audited compatibility flows.",
      },
      403,
    );
  }
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{ message: string }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (!isNonEmptyString(body.message)) {
    return c.json<ApiResponse>(
      { ok: false, error: "'message' is required" },
      400,
    );
  }
  if (looksLikeAuthMessage(body.message)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Refusing to sign authentication or permit-style messages",
      },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Message signing requires owner/admin session with recent MFA verification",
      },
      403,
    );
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_message",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? null,
      action: "vault.message.sign.authorized",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        messageLength: body.message.length,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        unsafeCompatibilityMode: true,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    const signature = await vault.signMessage(tenantId, agentId, body.message);
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? null,
      action: "vault.message.signed",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        messageLength: body.message.length,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        unsafeCompatibilityMode: true,
      },
    });
    setNoStoreHeaders(c);
    return c.json<ApiResponse>({ ok: true, data: { signature } });
  } catch (e) {
    const frozen = frozenSigningResponse(c, e);
    if (frozen) return frozen;
    logger.error(
      {
        details: [
          `[Vault] sign-message failed for ${tenantId}/${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── Sign raw EVM digest (secp256k1_sign) ────────────────────────────────────
//
// POST /vault/:agentId/sign-raw-hash
// body: { "hash": "0x<32-byte digest>", "referenceId"?: "caller-id" }
// resp: { ok: true, data: { signature, hash, walletAddress } }
vaultRoutes.post("/:agentId/sign-raw-hash", async (c) => {
  if (!allowUnsafeRawSigning() || !allowVaultUnsafeRawSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Raw secp256k1 signing is disabled because digest signatures bypass transaction and message policy controls. Set STEWARD_ALLOW_UNSAFE_RAW_SIGNING=true and STEWARD_ALLOW_VAULT_UNSAFE_RAW_SIGNING=true only for audited compatibility flows.",
      },
      403,
    );
  }
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Unsafe raw hash signing requires owner or admin session with recent MFA",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{ hash: string; referenceId?: string }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (!isBytes32Hex(body.hash)) {
    return c.json<ApiResponse>(
      { ok: false, error: "hash must be a 32-byte hex string" },
      400,
    );
  }
  if (body.referenceId !== undefined && !isNonEmptyString(body.referenceId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "referenceId must be a non-empty string" },
      400,
    );
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_raw_hash",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  try {
    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.raw_hash.sign.authorized",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        hash: body.hash,
        referenceId: body.referenceId ?? null,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        unsafeCompatibilityMode: true,
      },
    });

    const result = await vault.signRawHash(tenantId, agentId, body.hash);

    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.raw_hash.signed",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        hash: body.hash,
        referenceId: body.referenceId ?? null,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        walletAddress: result.walletAddress,
        unsafeCompatibilityMode: true,
      },
    });
    dispatchWebhook(tenantId, agentId, "wallet.raw_signature.created", {
      kind: "raw_hash",
      hash: body.hash,
      referenceId: body.referenceId ?? null,
      walletAddress: result.walletAddress,
    });

    setNoStoreHeaders(c);
    return c.json<ApiResponse>({ ok: true, data: result });
  } catch (e) {
    logger.error(
      {
        details: [
          `[Vault] sign-raw-hash failed for ${tenantId}/${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// POST /vault/:agentId/sign-raw-digest
// Cross-curve generalization of sign-raw-hash: signs an exactly-32-byte digest
// with the agent's secp256k1 (EVM) or ed25519 (Solana) key. `stark` fails closed.
// body: { "curve": "secp256k1"|"ed25519"|"stark", "payloadHex": "0x<32-byte>", "referenceId"?: "caller-id" }
// resp: { ok: true, data: { signature, curve, payloadHex, publicKey } }
//
// Shares the same audited env opt-in as sign-raw-hash because both produce raw
// signatures that bypass transaction/message policy controls. Fail-closed by
// default; auth gate fires before any parsing.
vaultRoutes.post("/:agentId/sign-raw-digest", async (c) => {
  if (!allowUnsafeRawSigning() || !allowVaultUnsafeRawSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Raw digest signing is disabled because digest signatures bypass transaction and message policy controls. Set STEWARD_ALLOW_UNSAFE_RAW_SIGNING=true and STEWARD_ALLOW_VAULT_UNSAFE_RAW_SIGNING=true only for audited compatibility flows.",
      },
      403,
    );
  }
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Unsafe raw digest signing requires owner or admin session with recent MFA",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    chain: string;
    curve: string;
    payloadHex: string;
    referenceId?: string;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (!isNonEmptyString(body.chain)) {
    return c.json<ApiResponse>({ ok: false, error: "chain is required" }, 400);
  }
  const chainSupport = rawSigningChainSupport(body.chain);
  if (!chainSupport) {
    return c.json<ApiResponse>(
      { ok: false, error: `Unsupported raw signing chain: ${body.chain}` },
      400,
    );
  }
  if (!chainSupport.supported) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `${body.chain} raw signing is not supported: ${chainSupport.unsupportedReason ?? "unsupported chain"}`,
      },
      400,
    );
  }
  if (chainSupport.capability !== "raw-digest") {
    // e.g. Monero: ed25519 keys but CLSAG ring signatures — a raw ed25519
    // digest signature would be meaningless/dangerous. Fail closed and point
    // at the dedicated transfer route.
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `${body.chain} does not support raw-digest signing; use the dedicated /vault/:agentId/${body.chain}/transfer route`,
      },
      400,
    );
  }
  if (body.curve !== "secp256k1" && body.curve !== "ed25519") {
    const error =
      body.curve === "stark"
        ? "stark curve raw signing is not supported: no vetted starknet signing library is installed"
        : "curve must be 'secp256k1' or 'ed25519'";
    return c.json<ApiResponse>({ ok: false, error }, 400);
  }
  if (body.curve !== chainSupport.curve) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `${body.chain} raw signing requires ${chainSupport.curve}, received ${body.curve}`,
      },
      400,
    );
  }
  if (!isBytes32Hex(body.payloadHex)) {
    return c.json<ApiResponse>(
      { ok: false, error: "payloadHex must be a 32-byte hex string" },
      400,
    );
  }
  if (body.referenceId !== undefined && !isNonEmptyString(body.referenceId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "referenceId must be a non-empty string" },
      400,
    );
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_raw_digest",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const hasRawSigningPolicy = policySet.some(
    (p) => p.enabled && p.type === "raw-signing-chain",
  );
  if (!hasRawSigningPolicy) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Raw digest signing requires a `raw-signing-chain` policy for this agent. Add one that explicitly allows the requested chain and curve.",
      },
      403,
    );
  }
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);
  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers))
        c.header(key, value);
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers))
      c.header(key, value);
  }
  const stats = await getTransactionStats(agentId, 0);
  const evaluation = await policyEngine.evaluate(policySet, {
    request: {
      agentId,
      tenantId,
      to: "0x0000000000000000000000000000000000000000",
      value: "0",
      chainId: 0,
      broadcast: false,
    },
    recentTxCount1h: stats.recentTxCount1h,
    recentTxCount24h: stats.recentTxCount24h,
    spentToday: stats.spentToday,
    spentThisWeek: stats.spentThisWeek,
    additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
    additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
    priceOracle,
    conditionSets,
    rawSigning: { chain: body.chain, curve: body.curve },
  });
  if (!evaluation.approved) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Raw digest signing rejected by policy",
        data: { policyResults: evaluation.results },
      },
      403,
    );
  }

  try {
    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.raw_digest.sign.authorized",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        chain: body.chain,
        curve: body.curve,
        payloadHex: body.payloadHex,
        referenceId: body.referenceId ?? null,
        policyResults: evaluation.results,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        unsafeCompatibilityMode: true,
      },
    });

    const result = await vault.signRawDigest(
      tenantId,
      agentId,
      body.curve,
      body.payloadHex,
    );

    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.raw_digest.signed",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        chain: body.chain,
        curve: result.curve,
        payloadHex: result.payloadHex,
        referenceId: body.referenceId ?? null,
        policyResults: evaluation.results,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        publicKey: result.publicKey,
        unsafeCompatibilityMode: true,
      },
    });
    dispatchWebhook(tenantId, agentId, "wallet.raw_signature.created", {
      kind: "raw_digest",
      chain: body.chain,
      curve: result.curve,
      payloadHex: result.payloadHex,
      referenceId: body.referenceId ?? null,
      publicKey: result.publicKey,
    });

    setNoStoreHeaders(c);
    return c.json<ApiResponse>({ ok: true, data: result });
  } catch (e) {
    logger.error(
      {
        details: [
          `[Vault] sign-raw-digest failed for ${tenantId}/${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

vaultRoutes.post("/:agentId/sign-typed-data", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_typed_data",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const body = await safeJsonParse<{
    domain: SignTypedDataRequest["domain"];
    types: SignTypedDataRequest["types"];
    primaryType: string;
    value: Record<string, unknown>;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!body.domain || typeof body.domain !== "object") {
    return c.json<ApiResponse>(
      { ok: false, error: "'domain' is required and must be an object" },
      400,
    );
  }
  if (!body.types || typeof body.types !== "object") {
    return c.json<ApiResponse>(
      { ok: false, error: "'types' is required and must be an object" },
      400,
    );
  }
  if (!isNonEmptyString(body.primaryType)) {
    return c.json<ApiResponse>(
      { ok: false, error: "'primaryType' is required" },
      400,
    );
  }
  if (!body.value || typeof body.value !== "object") {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' is required and must be an object" },
      400,
    );
  }

  const resolvedChainId =
    (typeof body.domain.chainId === "number" ? body.domain.chainId : 0) ||
    parseInt(process.env.CHAIN_ID || "8453", 10);
  // Use the EIP-712 domain's verifyingContract as the request `to` so that
  // destination-based policies (approved-addresses, condition-set, contract
  // allowlist) meaningfully gate the contract the typed data authorizes. Falls
  // back to the zero address when the domain has no (valid) verifyingContract.
  const verifyingContractTo =
    typeof body.domain.verifyingContract === "string" &&
    isValidAddress(body.domain.verifyingContract)
      ? body.domain.verifyingContract
      : "0x0000000000000000000000000000000000000000";
  const signRequest: SignRequest = {
    agentId,
    tenantId,
    to: verifyingContractTo,
    value: "0",
    chainId: resolvedChainId,
  };

  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);

  // ── Fail-closed gate ────────────────────────────────────────────────────────
  // EIP-712 typed-data signing produces off-chain signatures (permits, orders,
  // delegations) that can move funds without an on-chain transaction passing
  // through the vault's normal policy path. We therefore REFUSE it unless the
  // agent has an explicit `typed-data` policy authorizing (and constraining)
  // it, OR an audited env break-glass opt-in is set. When a `typed-data` policy
  // is present, the decoded payload below is evaluated against it.
  const hasTypedDataPolicy = policySet.some(
    (p) => p.enabled && p.type === "typed-data",
  );
  const typedDataEnvOptIn =
    allowUnsafeTypedDataSigning() && allowVaultUnsafeTypedDataSigning();
  if (!hasTypedDataPolicy && !typedDataEnvOptIn) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "EIP-712 typed-data signing requires a `typed-data` policy for this agent (to constrain the domain/primaryType/message). Add one, or set STEWARD_ALLOW_UNSAFE_TYPED_DATA_SIGNING=true and STEWARD_ALLOW_VAULT_UNSAFE_TYPED_DATA_SIGNING=true only for audited compatibility flows.",
      },
      403,
    );
  }

  const typedData = {
    domain: body.domain,
    types: body.types,
    primaryType: body.primaryType,
    value: body.value,
  };

  // ── Redis rate-limit check (typed data) ────────────────────────────────────
  const rlResult = await enforceRateLimit(agentId, policySet);
  if (!rlResult.allowed) {
    if (rlResult.headers) {
      for (const [key, value] of Object.entries(rlResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: rlResult.reason || "Rate limit exceeded" },
      429,
    );
  }

  const stats = await getTransactionStats(agentId, resolvedChainId);

  const evaluation = await policyEngine.evaluate(policySet, {
    request: signRequest,
    recentTxCount1h: stats.recentTxCount1h,
    recentTxCount24h: stats.recentTxCount24h,
    spentToday: stats.spentToday,
    spentThisWeek: stats.spentThisWeek,
    additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
    additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
    priceOracle,
    conditionSets,
    typedData,
  });

  if (!evaluation.approved) {
    const txId = crypto.randomUUID();

    if (evaluation.requiresManualApproval) {
      await db.transaction(async (tx) => {
        await tx.insert(transactions).values({
          id: txId,
          agentId,
          status: "pending",
          toAddress: signRequest.to,
          value: signRequest.value,
          chainId: signRequest.chainId,
          policyResults: evaluation.results,
        });
        await tx
          .insert(approvalQueue)
          .values(
            approvalQueueValues(c, agentId, txId, signerAuthorization.auth),
          );
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.typed_data.queued_for_approval",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          primaryType: body.primaryType,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });

      dispatchWebhook(tenantId, agentId, "approval_required", {
        txId,
        results: evaluation.results,
      });
      dispatchIntentWebhook(tenantId, agentId, "intent.created", {
        intentId: txId,
        status: "pending",
        policyResults: evaluation.results,
      });

      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction requires manual approval",
          data: {
            txId,
            results: evaluation.results,
            status: "pending_approval",
          },
        },
        202,
      );
    }

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "rejected",
      toAddress: signRequest.to,
      value: signRequest.value,
      chainId: signRequest.chainId,
      policyResults: evaluation.results,
    });

    await writeVaultAudit(c, {
      tenantId,
      actorType: "agent",
      actorId: agentId,
      action: "vault.sign.typed_data.rejected_by_policy",
      resourceType: "transaction",
      resourceId: txId,
      metadata: {
        chainId: signRequest.chainId,
        primaryType: body.primaryType,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        policyResults: evaluation.results,
      },
    });

    dispatchWebhook(tenantId, agentId, "tx_rejected", {
      txId,
      results: evaluation.results,
    });

    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejected by policy",
        data: { txId, results: evaluation.results },
      },
      403,
    );
  }

  const txId = crypto.randomUUID();

  try {
    await writeVaultAudit(c, {
      tenantId,
      actorType: "agent",
      actorId: agentId,
      action: "vault.sign.typed_data.authorized",
      resourceType: "transaction",
      resourceId: txId,
      metadata: {
        chainId: signRequest.chainId,
        primaryType: body.primaryType,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
        policyResults: evaluation.results,
      },
    });

    const signature = await vault.signTypedData({
      agentId,
      tenantId,
      domain: body.domain,
      types: body.types,
      primaryType: body.primaryType,
      value: body.value,
    });

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "signed",
      toAddress: signRequest.to,
      value: signRequest.value,
      chainId: signRequest.chainId,
      policyResults: evaluation.results,
      signedAt: new Date(),
    });

    await writeVaultAudit(c, {
      tenantId,
      actorType: "agent",
      actorId: agentId,
      action: "vault.sign.typed_data",
      resourceType: "transaction",
      resourceId: txId,
      metadata: {
        chainId: signRequest.chainId,
        primaryType: body.primaryType,
        ...signerAuthAuditMetadata(signerAuthorization.auth),
      },
    });

    dispatchWebhook(tenantId, agentId, "tx_signed", { txId });

    setNoStoreHeaders(c);
    return c.json<ApiResponse<{ signature: string; txId: string }>>({
      ok: true,
      data: { signature, txId },
    });
  } catch (e: unknown) {
    const frozen = frozenSigningResponse(c, e);
    if (frozen) return frozen;
    const requestId = c.get("requestId") || "unknown";
    const failureMessage = "Typed data signing failed";
    logger.error(
      {
        details: [
          `[${requestId}] Sign typed data failed for agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );

    dispatchWebhook(tenantId, agentId, "tx_failed", {
      txId,
      error: failureMessage,
      requestId,
    });

    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── ERC-4337 User Operation Signing ─────────────────────────────────────────

vaultRoutes.post("/:agentId/sign-user-operation", async (c) => {
  if (!allowUnsafeUserOperationSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User operation signing is disabled because policy fields cannot be trusted until callData decoding and sender ownership checks are implemented. Set STEWARD_ALLOW_UNSAFE_USER_OPERATION_SIGNING=true only for audited compatibility flows.",
      },
      403,
    );
  }

  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Unsafe user operation signing requires owner or admin session with recent MFA",
      },
      403,
    );
  }
  if (!userOperationPolicyModelAvailable()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User operation signing is disabled because policy fields cannot be trusted until callData decoding and sender ownership checks are implemented.",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_user_operation",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const body = await safeJsonParse<{
    userOperation?: unknown;
    entryPoint?: string;
    chainId?: number;
    to?: string;
    value?: string;
    referenceId?: unknown;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  const userOperation = parseUserOperation(body.userOperation);
  if (typeof userOperation === "string") {
    return c.json<ApiResponse>({ ok: false, error: userOperation }, 400);
  }
  if (body.entryPoint !== undefined && !isValidAddress(body.entryPoint)) {
    return c.json<ApiResponse>(
      { ok: false, error: "entryPoint must be an Ethereum address" },
      400,
    );
  }
  if (
    !Number.isSafeInteger(body.chainId) ||
    !body.chainId ||
    body.chainId <= 0
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "chainId is required and must be a positive integer",
      },
      400,
    );
  }
  if (!isNonEmptyString(body.to) || !isValidAddress(body.to)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "'to' is required for policy evaluation and must be an Ethereum address",
      },
      400,
    );
  }
  if (!isNonEmptyString(body.value) || !isUint256DecimalString(body.value)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "'value' is required for policy evaluation as a uint256 wei string",
      },
      400,
    );
  }
  const referenceId = parseReferenceId(body.referenceId);
  if (referenceId === null) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "referenceId must be a non-empty string up to 128 characters",
      },
      400,
    );
  }

  const signRequest: SignRequest = {
    agentId,
    tenantId,
    to: body.to,
    value: body.value,
    data: userOperation.callData,
    chainId: body.chainId,
    broadcast: false,
  };
  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);
  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers))
        c.header(key, value);
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers))
      c.header(key, value);
  }

  return withAgentSpendLock(agentId, async () => {
    const stats = await getTransactionStats(agentId, signRequest.chainId);
    const evaluation = await policyEngine.evaluate(policySet, {
      request: signRequest,
      recentTxCount1h: stats.recentTxCount1h,
      recentTxCount24h: stats.recentTxCount24h,
      spentToday: stats.spentToday,
      spentThisWeek: stats.spentThisWeek,
      additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
      additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
      priceOracle,
      conditionSets,
    });
    const txId = crypto.randomUUID();

    if (!evaluation.approved) {
      const status: "pending" | "rejected" = evaluation.requiresManualApproval
        ? "pending"
        : "rejected";
      const transactionRow = {
        id: txId,
        agentId,
        status,
        toAddress: signRequest.to,
        value: signRequest.value,
        data: signRequest.data,
        chainId: signRequest.chainId,
        policyResults: evaluation.results,
        actionType: "user_operation",
        actionPayload: {
          type: "user_operation",
          entryPoint: body.entryPoint ?? ENTRY_POINT_V07,
          sender: userOperation.sender,
          ...(referenceId ? { referenceId } : {}),
        },
      };

      if (evaluation.requiresManualApproval) {
        await db.transaction(async (tx) => {
          await tx.insert(transactions).values(transactionRow);
          await tx
            .insert(approvalQueue)
            .values(
              approvalQueueValues(c, agentId, txId, signerAuthorization.auth),
            );
        });
      } else {
        await db.insert(transactions).values(transactionRow);
      }

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: evaluation.requiresManualApproval
          ? "vault.sign.user_operation.queued_for_approval"
          : "vault.sign.user_operation.rejected_by_policy",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          to: signRequest.to,
          value: signRequest.value,
          sender: userOperation.sender,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });

      dispatchWebhook(
        tenantId,
        agentId,
        evaluation.requiresManualApproval ? "approval_required" : "tx_rejected",
        { txId, results: evaluation.results },
      );
      if (evaluation.requiresManualApproval) {
        dispatchIntentWebhook(tenantId, agentId, "intent.created", {
          intentId: txId,
          actionType: "user_operation",
          status: "pending",
          referenceId,
          policyResults: evaluation.results,
        });
      }

      return c.json<ApiResponse>(
        {
          ok: false,
          error: evaluation.requiresManualApproval
            ? "User operation requires manual approval"
            : "User operation rejected by policy",
          data: evaluation.requiresManualApproval
            ? { txId, results: evaluation.results, status: "pending_approval" }
            : { txId, results: evaluation.results },
        },
        evaluation.requiresManualApproval ? 202 : 403,
      );
    }

    try {
      await writeVaultAudit(c, {
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "vault.sign.user_operation.authorized",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          sender: userOperation.sender,
          entryPoint: body.entryPoint ?? ENTRY_POINT_V07,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          unsafeCompatibilityMode: true,
          policyResults: evaluation.results,
        },
      });
      const result = await vault.signUserOperation({
        agentId,
        tenantId,
        userOperation,
        entryPoint:
          (body.entryPoint as `0x${string}` | undefined) ?? ENTRY_POINT_V07,
        chainId: signRequest.chainId,
      });
      const userOperationHash = getUserOperationHash(
        packUserOperation(userOperation),
        result.entryPoint as `0x${string}`,
        result.chainId,
      );

      await db.insert(transactions).values({
        id: txId,
        agentId,
        status: "signed",
        toAddress: signRequest.to,
        value: signRequest.value,
        data: signRequest.data,
        chainId: signRequest.chainId,
        policyResults: evaluation.results,
        signedAt: new Date(),
        actionType: "user_operation",
        actionPayload: {
          type: "user_operation",
          entryPoint: result.entryPoint,
          sender: userOperation.sender,
          userOperationHash,
          ...(referenceId ? { referenceId } : {}),
        },
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "vault.sign.user_operation",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          sender: userOperation.sender,
          entryPoint: result.entryPoint,
          userOperationHash,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_signed", { txId });

      setNoStoreHeaders(c);
      setNoStoreHeaders(c);
      return c.json<
        ApiResponse<{
          signature: string;
          userOperationHash: string;
          entryPoint: string;
          chainId: number;
          txId: string;
        }>
      >({
        ok: true,
        data: { ...result, userOperationHash, txId },
      });
    } catch (e: unknown) {
      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.user_operation.failed",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          sender: userOperation.sender,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          ...redactedThrownDiagnostics(e),
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_failed", {
        txId,
        error: "Transaction failed",
        ...redactedThrownDiagnostics(e),
      });

      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(e) },
        500,
      );
    }
  });
});

// ─── EIP-7702 Authorization Signing ──────────────────────────────────────────

vaultRoutes.get("/:agentId/eip7702-delegation", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const chainId = Number(c.req.query("chainId"));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "chainId must be a positive integer" },
      400,
    );
  }

  if (!isValidAddress(agent.walletAddress)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "EIP-7702 delegation detection requires an EVM wallet address",
      },
      400,
    );
  }

  try {
    const status = await readEip7702Delegation({
      walletAddress: agent.walletAddress,
      chainId,
      getCode: async (address, blockTag) => {
        const codeResponse = await vault.rpcPassthrough({
          method: "eth_getCode",
          params: [address, blockTag],
          chainId,
        });
        if (codeResponse.error) {
          throw new Error("eth_getCode returned an RPC error");
        }
        return codeResponse.result;
      },
    });

    return c.json<ApiResponse<typeof status>>({ ok: true, data: status });
  } catch {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "EIP-7702 delegation status cannot be read until account code is verified",
      },
      502,
    );
  }
});

vaultRoutes.post("/:agentId/sign-authorization", async (c) => {
  if (!allowUnsafeAuthorizationSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "EIP-7702 authorization signing is disabled because delegation can bypass transaction policy controls. Set STEWARD_ALLOW_UNSAFE_AUTHORIZATION_SIGNING=true only for audited break-glass flows.",
      },
      403,
    );
  }

  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  if (!hasTenantAdminSession(c) || !hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Unsafe authorization signing requires owner or admin session with recent MFA",
      },
      403,
    );
  }
  if (!authorizationPolicyModelAvailable()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "EIP-7702 authorization signing is disabled because delegation can bypass transaction policy controls.",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_authorization",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const body = await safeJsonParse<{
    contractAddress?: string;
    chainId?: number;
    nonce?: number;
    referenceId?: unknown;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (!isValidAddress(body.contractAddress)) {
    return c.json<ApiResponse>(
      { ok: false, error: "contractAddress must be an Ethereum address" },
      400,
    );
  }
  if (
    typeof body.chainId !== "number" ||
    !Number.isSafeInteger(body.chainId) ||
    body.chainId <= 0
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "chainId must be a positive integer" },
      400,
    );
  }
  if (
    typeof body.nonce !== "number" ||
    !Number.isSafeInteger(body.nonce) ||
    body.nonce < 0
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "nonce must be a non-negative integer" },
      400,
    );
  }
  const referenceId = parseReferenceId(body.referenceId);
  if (referenceId === null) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "referenceId must be a non-empty string up to 128 characters",
      },
      400,
    );
  }
  const contractAddress = body.contractAddress as `0x${string}`;
  const chainId = body.chainId as number;
  const nonce = body.nonce as number;

  const signRequest: SignRequest = {
    agentId,
    tenantId,
    to: contractAddress,
    value: "0",
    chainId,
    broadcast: false,
  };
  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);
  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers))
        c.header(key, value);
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers))
      c.header(key, value);
  }

  return withAgentSpendLock(agentId, async () => {
    const stats = await getTransactionStats(agentId, signRequest.chainId);
    const evaluation = await policyEngine.evaluate(policySet, {
      request: signRequest,
      recentTxCount1h: stats.recentTxCount1h,
      recentTxCount24h: stats.recentTxCount24h,
      spentToday: stats.spentToday,
      spentThisWeek: stats.spentThisWeek,
      additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
      additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
      priceOracle,
      conditionSets,
    });
    const txId = crypto.randomUUID();

    if (!evaluation.approved) {
      const status: "pending" | "rejected" = evaluation.requiresManualApproval
        ? "pending"
        : "rejected";
      const transactionRow = {
        id: txId,
        agentId,
        status,
        toAddress: signRequest.to,
        value: signRequest.value,
        chainId: signRequest.chainId,
        policyResults: evaluation.results,
        actionType: "authorization",
        actionPayload: {
          type: "eip7702_authorization",
          contractAddress,
          nonce,
          ...(referenceId ? { referenceId } : {}),
        },
      };

      if (evaluation.requiresManualApproval) {
        await db.transaction(async (tx) => {
          await tx.insert(transactions).values(transactionRow);
          await tx
            .insert(approvalQueue)
            .values(
              approvalQueueValues(c, agentId, txId, signerAuthorization.auth),
            );
        });
      } else {
        await db.insert(transactions).values(transactionRow);
      }

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: evaluation.requiresManualApproval
          ? "vault.sign.authorization.queued_for_approval"
          : "vault.sign.authorization.rejected_by_policy",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          contractAddress,
          nonce,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });

      dispatchWebhook(
        tenantId,
        agentId,
        evaluation.requiresManualApproval ? "approval_required" : "tx_rejected",
        { txId, results: evaluation.results },
      );
      if (evaluation.requiresManualApproval) {
        dispatchIntentWebhook(tenantId, agentId, "intent.created", {
          intentId: txId,
          actionType: "authorization",
          status: "pending",
          referenceId,
          policyResults: evaluation.results,
        });
      }

      return c.json<ApiResponse>(
        {
          ok: false,
          error: evaluation.requiresManualApproval
            ? "Authorization requires manual approval"
            : "Authorization rejected by policy",
          data: evaluation.requiresManualApproval
            ? { txId, results: evaluation.results, status: "pending_approval" }
            : { txId, results: evaluation.results },
        },
        evaluation.requiresManualApproval ? 202 : 403,
      );
    }

    try {
      await writeVaultAudit(c, {
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "vault.sign.authorization.authorized",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          contractAddress,
          nonce,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          unsafeCompatibilityMode: true,
          policyResults: evaluation.results,
        },
      });
      const authorization = await vault.signAuthorization(tenantId, agentId, {
        contractAddress,
        chainId,
        nonce,
      });

      await db.insert(transactions).values({
        id: txId,
        agentId,
        status: "signed",
        toAddress: signRequest.to,
        value: signRequest.value,
        chainId: signRequest.chainId,
        policyResults: evaluation.results,
        signedAt: new Date(),
        actionType: "authorization",
        actionPayload: {
          type: "eip7702_authorization",
          contractAddress,
          nonce,
          ...(referenceId ? { referenceId } : {}),
        },
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "user",
        actorId: c.get("userId") ?? null,
        action: "vault.sign.authorization",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          contractAddress,
          nonce,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_signed", { txId });

      setNoStoreHeaders(c);
      return c.json<
        ApiResponse<{ authorization: typeof authorization; txId: string }>
      >({
        ok: true,
        data: { authorization, txId },
      });
    } catch (e: unknown) {
      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.authorization.failed",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId: signRequest.chainId,
          contractAddress,
          nonce,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          ...redactedThrownDiagnostics(e),
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_failed", {
        txId,
        error: "Transaction failed",
        ...redactedThrownDiagnostics(e),
      });

      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(e) },
        500,
      );
    }
  });
});

// ─── Solana Transaction Signing ───────────────────────────────────────────────

/**
 * Blind-signing fallback for Solana transactions that could NOT be fully decoded
 * into policy fields. Only reachable when STEWARD_ALLOW_UNSAFE_SOLANA_BLIND_SIGNING
 * is set. Policy is evaluated against the CALLER-SUPPLIED (unverifiable) envelope,
 * which is why this path is opt-in only — the platform cannot guarantee the signed
 * bytes match the envelope. The vault's single-transfer byte assertion is still
 * applied via expectedTo/expectedValue as a best-effort last line of defense
 * (it succeeds for single native transfers and throws for anything else).
 */
async function signSolanaBlind(
  c: Context<{ Variables: AppVariables }>,
  args: {
    agentId: string;
    tenantId: string;
    transaction: string;
    chainId: number;
    broadcast?: boolean;
    to: string;
    value: string;
    unparsedReason: string;
  },
): Promise<Response> {
  const { agentId, tenantId, chainId, to: toAddress, value: txValue } = args;
  const shouldBroadcast = args.broadcast !== false;
  const idempotencyResponse = requireBroadcastActionIdempotency(
    c,
    shouldBroadcast,
    "Broadcast Solana signing requests",
  );
  if (idempotencyResponse) return idempotencyResponse;

  const signRequest = {
    agentId,
    tenantId,
    to: toAddress,
    value: txValue,
    chainId,
  };
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_transaction",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);

  const rl = await enforceRateLimit(agentId, policySet);
  if (!rl.allowed) {
    if (rl.headers) {
      for (const [key, value] of Object.entries(rl.headers))
        c.header(key, value);
    }
    return c.json<ApiResponse>(
      { ok: false, error: rl.reason || "Rate limit exceeded" },
      429,
    );
  }

  // Same per-agent advisory spend lock as the parsed path: serialize eval+sign+
  // commit so concurrent blind-sign requests cannot race the spend cap.
  return withAgentSpendLock(agentId, async () => {
    const stats = await getTransactionStats(agentId, signRequest.chainId);
    const evaluation = await policyEngine.evaluate(policySet, {
      request: signRequest,
      recentTxCount1h: stats.recentTxCount1h,
      recentTxCount24h: stats.recentTxCount24h,
      spentToday: stats.spentToday,
      spentThisWeek: stats.spentThisWeek,
      additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
      additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
      priceOracle,
      conditionSets,
    });

    if (!evaluation.approved) {
      const txId = crypto.randomUUID();
      const manual = evaluation.requiresManualApproval;
      await db.insert(transactions).values({
        id: txId,
        agentId,
        status: manual ? "pending" : "rejected",
        toAddress,
        value: txValue,
        data: manual ? args.transaction : undefined,
        chainId,
        policyResults: evaluation.results,
      });
      if (manual) {
        await db
          .insert(approvalQueue)
          .values(
            approvalQueueValues(c, agentId, txId, signerAuthorization.auth),
          );
      }
      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: manual
          ? "vault.sign.solana.blind.queued_for_approval"
          : "vault.sign.solana.blind.rejected_by_policy",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId,
          to: toAddress,
          value: txValue,
          blindSigned: true,
          unparsedReason: args.unparsedReason,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });
      dispatchWebhook(
        tenantId,
        agentId,
        manual ? "approval_required" : "tx_rejected",
        {
          txId,
          results: evaluation.results,
        },
      );
      return c.json<ApiResponse>(
        {
          ok: false,
          error: manual
            ? "Transaction requires manual approval"
            : "Transaction rejected by policy",
          data: { txId, results: evaluation.results },
        },
        manual ? 202 : 403,
      );
    }

    const binding = createSolanaRecoveryBinding(c, {
      tenantId,
      agentId,
      transaction: args.transaction,
      chainId,
      toAddress,
      value: txValue,
      broadcastRequested: shouldBroadcast,
      blindSigned: true,
    });
    const { txId } = binding;
    let executionToken: string | null = null;
    let completedResult: {
      txId: string;
      signature: string;
      broadcast: boolean;
      chainId: number;
      caip2?: string;
    } | null = null;
    try {
      const staged = await stageSolanaRecoveryAnchor({
        agentId,
        transaction: args.transaction,
        chainId,
        toAddress,
        value: txValue,
        broadcastRequested: shouldBroadcast,
        blindSigned: true,
        policyResults: evaluation.results,
        binding,
      });
      if (!staged.executionToken) return solanaReplayResponse(c, staged.row);
      const ownerToken = staged.executionToken;
      executionToken = ownerToken;
      const result = await vault.signSolanaTransaction({
        agentId,
        tenantId,
        transaction: args.transaction,
        chainId,
        broadcast: args.broadcast,
        expectedTo: toAddress,
        expectedValue: txValue,
        onBroadcastPrepared: (checkpoint) =>
          checkpointSolanaBroadcastSubmission(
            txId,
            agentId,
            ownerToken,
            checkpoint,
          ),
      });
      completedResult = { txId, ...result };
      await finalizeSolanaRecoveryAnchor(txId, agentId, ownerToken, result);
      recordVaultSpend(agentId, tenantId, txValue, chainId).catch((err) =>
        logger.error(
          {
            details: [
              "[vault] Failed to record Solana spend",
              redactedThrownDiagnostics(err),
            ],
          },
          "[Login:vault] error",
        ),
      );
      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.solana.blind",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId,
          to: toAddress,
          value: txValue,
          blindSigned: true,
          unparsedReason: args.unparsedReason,
          broadcast: result.broadcast,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          signature: result.broadcast ? result.signature : undefined,
        },
      });
      dispatchWebhook(tenantId, agentId, "tx_signed", {
        txId,
        txHash: result.broadcast ? result.signature : undefined,
      });
      return c.json<
        ApiResponse<{
          txId: string;
          signature: string;
          broadcast: boolean;
          chainId: number;
          caip2?: string;
        }>
      >({ ok: true, data: { txId, ...result } });
    } catch (e: unknown) {
      const requestId = c.get("requestId") || "unknown";
      logger.error(
        {
          details: [
            `[${requestId}] Solana blind sign failed for agent ${agentId}`,
            redactedThrownDiagnostics(e),
          ],
        },
        "[Login:vault] error",
      );
      if (completedResult?.broadcast) {
        logger.error(
          {
            details: [
              `[${requestId}] Solana blind sign completed before bookkeeping failed for agent ${agentId}, tx ${txId}; returning completed result to prevent duplicate retry`,
            ],
          },
          "[Login:vault] error",
        );
        setNoStoreHeaders(c);
        return c.json<
          ApiResponse<{
            txId: string;
            signature: string;
            broadcast: boolean;
            chainId: number;
            caip2?: string;
          }>
        >({ ok: true, data: completedResult });
      }
      if (e instanceof SolanaIdempotencyConflictError) {
        return c.json<ApiResponse>({ ok: false, error: e.message }, 409);
      }
      if (e instanceof SolanaBroadcastNotSubmittedError) {
        await markSolanaBroadcastNotSubmitted(
          tenantId,
          txId,
          agentId,
          executionToken,
          e.transactionHash,
        );
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Solana RPC preflight rejected the transaction",
            data: { txId },
          },
          502,
        );
      }
      if (e instanceof ExternalBroadcastOutcomeUnknownError) {
        await preserveUnknownSolanaOutcome(
          txId,
          agentId,
          executionToken,
          e.transactionHash,
        );
        recordVaultSpend(agentId, tenantId, txValue, chainId).catch((err) =>
          logger.error(
            {
              details: [
                "[vault] Failed to record ambiguous Solana spend",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          ),
        );
        await writeOutcomeUnknownAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: "vault.sign.solana.blind.outcome_unknown",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            chainId,
            to: toAddress,
            value: txValue,
            blindSigned: true,
            signature: e.transactionHash,
          },
        });
        return externalBroadcastOutcomeUnknownResponse(c, e, txId) as Response;
      }
      await markSolanaRecoveryAnchorFailed(txId, agentId, executionToken);
      const frozen = frozenSigningResponse(c, e);
      if (frozen) return frozen;
      dispatchWebhook(tenantId, agentId, "tx_failed", {
        error: "Transaction failed",
        ...redactedThrownDiagnostics(e),
        requestId,
      });
      if (isRpcError(e)) {
        return c.json<ApiResponse>(
          { ok: false, error: extractRpcErrorMessage(e) },
          502,
        );
      }
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(e) },
        500,
      );
    }
  });
}

type SolanaSigningResult = {
  signature: string;
  broadcast: boolean;
  chainId: number;
  caip2?: string;
};

type SolanaRecoveryBinding = {
  txId: string;
  idempotencyKeyDigest?: string;
  requestDigest?: string;
};

const SOLANA_SIGNING_ATTEMPT_LEASE_MS = 2 * 60 * 1000;

class SolanaIdempotencyConflictError extends Error {
  constructor() {
    super(
      "Idempotency-Key was already used for a different Solana transaction",
    );
    this.name = "SolanaIdempotencyConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createSolanaRecoveryBinding(
  c: Context<{ Variables: AppVariables }>,
  input: {
    tenantId: string;
    agentId: string;
    transaction: string;
    chainId: number;
    toAddress: string;
    value: string;
    broadcastRequested: boolean;
    blindSigned: boolean;
  },
): SolanaRecoveryBinding {
  if (!input.broadcastRequested) return { txId: crypto.randomUUID() };
  const key = c.req.header("Idempotency-Key");
  if (!key) throw new Error("Idempotency-Key is required for Solana broadcast");
  const scope = `${input.tenantId}\0${input.agentId}\0${key}`;
  return {
    txId: `solana_${sha256(scope).slice(0, 56)}`,
    idempotencyKeyDigest: sha256(scope),
    requestDigest: sha256(
      canonicalJsonStringify({
        agentId: input.agentId,
        blindSigned: input.blindSigned,
        broadcast: true,
        chainId: input.chainId,
        tenantId: input.tenantId,
        toAddress: input.toAddress,
        transaction: input.transaction,
        value: input.value,
      }),
    ),
  };
}

type SolanaRecoveryRow = {
  id: string;
  agentId: string;
  status: string;
  txHash: string | null;
  chainId: number;
  actionPayload: unknown;
};

function readSolanaRecoveryMetadata(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function solanaReplayResponse(
  c: Context<{ Variables: AppVariables }>,
  row: SolanaRecoveryRow,
): Response {
  if (row.status === "approved") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "A matching Solana signing attempt is already in progress",
        data: { txId: row.id, status: "processing" },
      },
      409,
    );
  }
  if (row.status === "outcome_unknown" && row.txHash) {
    return externalBroadcastOutcomeUnknownResponse(
      c,
      new ExternalBroadcastOutcomeUnknownError(row.txHash),
      row.id,
    ) as Response;
  }
  if (
    (row.status === "broadcast" || row.status === "confirmed") &&
    row.txHash
  ) {
    return c.json<ApiResponse<SolanaSigningResult & { txId: string }>>({
      ok: true,
      data: {
        txId: row.id,
        signature: row.txHash,
        broadcast: true,
        chainId: row.chainId,
        caip2: toCaip2(row.chainId),
      },
    });
  }
  return c.json<ApiResponse>(
    {
      ok: false,
      error:
        "The prior Solana request did not complete; use a new Idempotency-Key",
      data: { txId: row.id, status: row.status },
    },
    409,
  );
}

async function stageSolanaRecoveryAnchor(input: {
  agentId: string;
  transaction: string;
  chainId: number;
  toAddress: string;
  value: string;
  broadcastRequested: boolean;
  blindSigned: boolean;
  policyResults: PolicyResult[];
  binding: SolanaRecoveryBinding;
}): Promise<{ row: SolanaRecoveryRow; executionToken: string | null }> {
  const executionToken = crypto.randomUUID();
  const attemptLeaseUntil = new Date(
    Date.now() + SOLANA_SIGNING_ATTEMPT_LEASE_MS,
  ).toISOString();
  const inserted = await db
    .insert(transactions)
    .values({
      id: input.binding.txId,
      agentId: input.agentId,
      status: "approved",
      toAddress: input.toAddress,
      value: input.value,
      data: input.transaction,
      chainId: input.chainId,
      actionType: "solana_transaction",
      actionPayload: {
        type: "solana_transaction",
        broadcast: input.broadcastRequested,
        blindSigned: input.blindSigned,
        recoveryAnchor: true,
        idempotencyKeyDigest: input.binding.idempotencyKeyDigest,
        requestDigest: input.binding.requestDigest,
        executionToken,
        attemptLeaseUntil,
      },
      policyResults: input.policyResults,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0])
    return { row: inserted[0] as SolanaRecoveryRow, executionToken };

  const [existing] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.binding.txId))
    .limit(1);
  const metadata = readSolanaRecoveryMetadata(existing?.actionPayload);
  if (
    !existing ||
    existing.agentId !== input.agentId ||
    metadata.type !== "solana_transaction" ||
    metadata.idempotencyKeyDigest !== input.binding.idempotencyKeyDigest ||
    metadata.requestDigest !== input.binding.requestDigest
  ) {
    throw new SolanaIdempotencyConflictError();
  }
  if (existing.status !== "approved") {
    return { row: existing as SolanaRecoveryRow, executionToken: null };
  }

  const priorLeaseUntil =
    typeof metadata.attemptLeaseUntil === "string"
      ? Date.parse(metadata.attemptLeaseUntil)
      : Number.NaN;
  if (Number.isFinite(priorLeaseUntil) && priorLeaseUntil > Date.now()) {
    return { row: existing as SolanaRecoveryRow, executionToken: null };
  }

  const priorToken =
    typeof metadata.executionToken === "string"
      ? metadata.executionToken
      : null;
  const tokenPredicate = priorToken
    ? sql`${transactions.actionPayload}->>'executionToken' = ${priorToken}`
    : sql`${transactions.actionPayload}->>'executionToken' is null`;
  const [takenOver] = await db
    .update(transactions)
    .set({
      actionPayload: { ...metadata, executionToken, attemptLeaseUntil },
    })
    .where(
      and(
        eq(transactions.id, input.binding.txId),
        eq(transactions.agentId, input.agentId),
        eq(transactions.status, "approved"),
        tokenPredicate,
      ),
    )
    .returning();
  if (takenOver) return { row: takenOver as SolanaRecoveryRow, executionToken };

  const [winner] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.binding.txId))
    .limit(1);
  return {
    row: (winner ?? existing) as SolanaRecoveryRow,
    executionToken: null,
  };
}

async function checkpointSolanaBroadcastSubmission(
  txId: string,
  agentId: string,
  executionToken: string,
  checkpoint: { signature: string; recentBlockhash: string },
): Promise<void> {
  const [existing] = await db
    .select({ actionPayload: transactions.actionPayload })
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)))
    .limit(1);
  const rows = await db
    .update(transactions)
    .set({
      status: "outcome_unknown",
      txHash: checkpoint.signature,
      signedAt: new Date(),
      actionPayload: {
        ...readSolanaRecoveryMetadata(existing?.actionPayload),
        recentBlockhash: checkpoint.recentBlockhash,
      },
    })
    .where(
      and(
        eq(transactions.id, txId),
        eq(transactions.agentId, agentId),
        eq(transactions.status, "approved"),
        sql`${transactions.actionPayload}->>'executionToken' = ${executionToken}`,
      ),
    )
    .returning({ id: transactions.id });
  if (rows.length !== 1) {
    throw new Error(
      "Solana recovery anchor was not available for broadcast checkpoint",
    );
  }
}

async function finalizeSolanaRecoveryAnchor(
  txId: string,
  agentId: string,
  executionToken: string,
  result: SolanaSigningResult,
): Promise<void> {
  const rows = await db
    .update(transactions)
    .set({
      status: result.broadcast ? "broadcast" : "signed",
      txHash: result.broadcast ? result.signature : null,
      signedAt: new Date(),
    })
    .where(
      and(
        eq(transactions.id, txId),
        eq(transactions.agentId, agentId),
        result.broadcast
          ? and(
              eq(transactions.status, "outcome_unknown"),
              eq(transactions.txHash, result.signature),
            )
          : eq(transactions.status, "approved"),
        sql`${transactions.actionPayload}->>'executionToken' = ${executionToken}`,
      ),
    )
    .returning({ id: transactions.id });
  if (rows.length !== 1) {
    throw new Error(
      "Solana recovery anchor was not available for finalization",
    );
  }
}

async function preserveUnknownSolanaOutcome(
  txId: string,
  agentId: string,
  executionToken: string | null,
  signature: string,
): Promise<void> {
  if (!executionToken) return;
  try {
    await db
      .update(transactions)
      .set({
        status: "outcome_unknown",
        txHash: signature,
        signedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.id, txId),
          eq(transactions.agentId, agentId),
          sql`${transactions.status} in ('approved', 'outcome_unknown')`,
          sql`${transactions.actionPayload}->>'executionToken' = ${executionToken}`,
        ),
      );
  } catch (error) {
    // The pre-sign approved row is already durable. Preserve the typed 202
    // response even when the database cannot enrich it with the known hash.
    logger.error(
      {
        details: [
          "[vault] Failed to persist ambiguous Solana broadcast hash",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:vault] error",
    );
  }
}

async function markSolanaRecoveryAnchorFailed(
  txId: string,
  agentId: string,
  executionToken: string | null,
): Promise<void> {
  if (!executionToken) return;
  try {
    await db
      .update(transactions)
      .set({ status: "failed" })
      .where(
        and(
          eq(transactions.id, txId),
          eq(transactions.agentId, agentId),
          eq(transactions.status, "approved"),
          sql`${transactions.actionPayload}->>'executionToken' = ${executionToken}`,
        ),
      );
  } catch (error) {
    logger.error(
      {
        details: [
          "[vault] Failed to mark Solana recovery anchor as failed",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:vault] error",
    );
  }
}

async function markSolanaBroadcastNotSubmitted(
  tenantId: string,
  txId: string,
  agentId: string,
  executionToken: string | null,
  signature: string,
): Promise<void> {
  if (!executionToken) return;
  await withTenantAuditedTransaction(
    tenantId,
    async (rawTx, appendRequiredAudit) => {
      const tx = rawTx as typeof db;
      const [updated] = await tx
        .update(transactions)
        .set({ status: "failed" })
        .where(
          and(
            eq(transactions.id, txId),
            eq(transactions.agentId, agentId),
            eq(transactions.status, "outcome_unknown"),
            eq(transactions.txHash, signature),
            sql`${transactions.actionPayload}->>'executionToken' = ${executionToken}`,
          ),
        )
        .returning({ id: transactions.id });
      if (!updated) return;
      await appendRequiredAudit({
        tenantId,
        actorType: "system",
        actorId: "solana-rpc-preflight",
        action: "vault.sign.solana.not_submitted",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          previousStatus: "outcome_unknown",
          status: "failed",
          signature,
        },
      });
    },
  );
}

vaultRoutes.post("/:agentId/sign-solana", async (c) => {
  // Serialized Solana signing is now enabled by default for transactions whose
  // instructions can be fully decoded into authoritative policy fields (see
  // parseSolanaTransaction below). Transactions that cannot be fully parsed are
  // rejected unless STEWARD_ALLOW_UNSAFE_SOLANA_BLIND_SIGNING is explicitly set.
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    transaction: string;
    chainId?: number;
    broadcast?: boolean;
    to?: string;
    value?: string;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const shouldBroadcast = body.broadcast !== false;
  const idempotencyResponse = requireBroadcastActionIdempotency(
    c,
    shouldBroadcast,
    "Broadcast Solana signing requests",
  );
  if (idempotencyResponse) return idempotencyResponse;

  if (!isNonEmptyString(body.transaction)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "'transaction' is required (base64-encoded serialized Solana transaction)",
      },
      400,
    );
  }

  // Caller-supplied 'to'/'value' are ADVISORY ONLY. The authoritative policy
  // fields are derived from the serialized transaction bytes below. We still
  // validate their shape if present so a malformed hint is rejected early.
  if (body.to !== undefined && body.to !== "") {
    if (!isValidSolanaAddress(body.to) && !isValidAddress(body.to)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "'to' must be a valid Solana address (base58, 32–44 chars) or Ethereum address",
        },
        400,
      );
    }
  }
  if (body.value !== undefined && body.value !== "") {
    if (!isUint256DecimalString(body.value)) {
      return c.json<ApiResponse>(
        { ok: false, error: "'value' must be a uint256 lamports string" },
        400,
      );
    }
  }

  const chainId = body.chainId ?? 101;
  if (!isSolanaActionChain(chainId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "'chainId' must be 101 (Solana mainnet) or 102 (Solana devnet)",
      },
      400,
    );
  }

  // ── Derive authoritative policy fields from the transaction bytes ───────────
  // This is the core spoof-resistance control: nothing the caller claims about
  // the transaction is trusted. We decode the real recipient(s), lamports, and
  // token transfers from the serialized message itself.
  let derived: DerivedSolanaPolicyFields;
  try {
    const summary = parseSolanaTransaction(body.transaction);
    try {
      assertSolanaPriorityFeeWithinCap(summary);
    } catch (feeErr) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            feeErr instanceof Error
              ? feeErr.message
              : "Solana priority fee exceeds cap",
        },
        422,
      );
    }
    derived = deriveSolanaPolicyFields(summary);
  } catch (parseErr) {
    // The payload could not even be deserialized into a transaction. Fail closed
    // unless blind-signing is explicitly opted into.
    if (!allowUnsafeSolanaBlindSigning()) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Solana transaction could not be decoded for policy evaluation and was rejected. Set STEWARD_ALLOW_UNSAFE_SOLANA_BLIND_SIGNING=true only for audited blind-signing flows.",
        },
        422,
      );
    }
    // Blind-signing path requires caller-supplied policy fields (legacy envelope).
    if (!body.to || !body.value || !isUint256DecimalString(body.value)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Blind Solana signing requires caller-supplied 'to' and uint256 'value' because the transaction could not be parsed",
        },
        400,
      );
    }
    return await signSolanaBlind(c, {
      agentId,
      tenantId,
      transaction: body.transaction,
      chainId,
      broadcast: body.broadcast,
      to: body.to,
      value: body.value,
      unparsedReason:
        parseErr instanceof Error
          ? parseErr.message
          : "undecodable transaction",
    });
  }

  // ── Fail-closed gate: any instruction we could not decode ───────────────────
  if (!derived.fullyParsed) {
    if (!allowUnsafeSolanaBlindSigning()) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Solana transaction contains instruction(s) that could not be verified against policy and was rejected (fail-closed). Set STEWARD_ALLOW_UNSAFE_SOLANA_BLIND_SIGNING=true only for audited blind-signing flows.",
          data: { unparsedReasons: derived.summary.unparsedReasons },
        },
        422,
      );
    }
    if (!body.to || !body.value || !isUint256DecimalString(body.value)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Blind Solana signing requires caller-supplied 'to' and uint256 'value' because the transaction is not fully parseable",
        },
        400,
      );
    }
    return await signSolanaBlind(c, {
      agentId,
      tenantId,
      transaction: body.transaction,
      chainId,
      broadcast: body.broadcast,
      to: body.to,
      value: body.value,
      unparsedReason: derived.summary.unparsedReasons.join("; "),
    });
  }

  // ── Spoof check: caller hints must not CONFLICT with the parsed truth ───────
  const conflicts = detectSolanaPolicyConflicts(derived, {
    to: body.to,
    value: body.value,
  });
  if (conflicts.length > 0) {
    await writeVaultAudit(c, {
      tenantId,
      actorType: "agent",
      actorId: agentId,
      action: "vault.sign.solana.rejected_spoofed_fields",
      resourceType: "transaction",
      resourceId: agentId,
      metadata: {
        chainId,
        callerTo: body.to,
        callerValue: body.value,
        derivedTo: derived.to,
        derivedValue: derived.value,
        conflicts,
      },
    });
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Caller-supplied policy fields conflict with the serialized transaction and were rejected",
        data: { conflicts },
      },
      422,
    );
  }

  // Authoritative recipient/value come from the parser, NOT from the caller.
  // For transactions with no derivable recipient (e.g. close-account only) we
  // fall back to the agent's own Solana address so policy still evaluates a
  // value of 0 against a stable, non-spoofable target.
  const toAddress =
    derived.to ?? agent.walletAddresses?.solana ?? agent.walletAddress;
  const txValue = derived.value;

  const signRequest = {
    agentId,
    tenantId,
    to: toAddress,
    value: txValue,
    chainId,
  };
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_transaction",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const policySet = await getScopedPolicySet(
    tenantId,
    agentId,
    c.get("agentPolicyIds"),
  );
  const conditionSets = await loadConditionSetsForPolicies(tenantId, policySet);

  // ── Redis rate-limit check (Solana) ────────────────────────────────────────
  const solRlResult = await enforceRateLimit(agentId, policySet);
  if (!solRlResult.allowed) {
    if (solRlResult.headers) {
      for (const [key, value] of Object.entries(solRlResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: solRlResult.reason || "Rate limit exceeded" },
      429,
    );
  }

  // Hold the per-agent advisory spend lock across policy evaluation, signing,
  // and the signed-transaction commit so concurrent Solana sign requests cannot
  // race the spend cap. Without it, two concurrent requests can both read the
  // same `spentToday`/`spentThisWeek`, each pass a spending-limit policy, and
  // both sign — overspending the cap. This mirrors the EVM sign/transfer/
  // user-operation/authorization paths, which all wrap eval+sign under the lock.
  return withAgentSpendLock(agentId, async () => {
    const stats = await getTransactionStats(agentId, chainId);

    const evaluation = await policyEngine.evaluate(policySet, {
      request: signRequest,
      recentTxCount1h: stats.recentTxCount1h,
      recentTxCount24h: stats.recentTxCount24h,
      spentToday: stats.spentToday,
      spentThisWeek: stats.spentThisWeek,
      additionalUsdSpentTodayMicros: stats.additionalUsdSpentTodayMicros,
      additionalUsdSpentThisWeekMicros: stats.additionalUsdSpentThisWeekMicros,
      priceOracle,
      conditionSets,
    });

    if (!evaluation.approved) {
      const txId = crypto.randomUUID();

      if (evaluation.requiresManualApproval) {
        await db.transaction(async (tx) => {
          await tx.insert(transactions).values({
            id: txId,
            agentId,
            status: "pending",
            toAddress,
            value: txValue,
            data: body.transaction,
            chainId,
            policyResults: evaluation.results,
          });
          await tx
            .insert(approvalQueue)
            .values(
              approvalQueueValues(c, agentId, txId, signerAuthorization.auth),
            );
        });

        await writeVaultAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: "vault.sign.solana.queued_for_approval",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            chainId,
            to: toAddress,
            value: txValue,
            ...signerAuthAuditMetadata(signerAuthorization.auth),
            policyResults: evaluation.results,
          },
        });

        dispatchWebhook(tenantId, agentId, "approval_required", {
          txId,
          results: evaluation.results,
        });
        dispatchIntentWebhook(tenantId, agentId, "intent.created", {
          intentId: txId,
          status: "pending",
          policyResults: evaluation.results,
        });

        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Transaction requires manual approval",
            data: {
              txId,
              results: evaluation.results,
              status: "pending_approval",
            },
          },
          202,
        );
      }

      await db.insert(transactions).values({
        id: txId,
        agentId,
        status: "rejected",
        toAddress,
        value: txValue,
        chainId,
        policyResults: evaluation.results,
      });

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.solana.rejected_by_policy",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId,
          to: toAddress,
          value: txValue,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          policyResults: evaluation.results,
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_rejected", {
        txId,
        results: evaluation.results,
      });

      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction rejected by policy",
          data: { txId, results: evaluation.results },
        },
        403,
      );
    }

    const binding = createSolanaRecoveryBinding(c, {
      tenantId,
      agentId,
      transaction: body.transaction,
      chainId,
      toAddress,
      value: txValue,
      broadcastRequested: shouldBroadcast,
      blindSigned: false,
    });
    const { txId } = binding;
    let executionToken: string | null = null;
    let completedResult: {
      txId: string;
      signature: string;
      broadcast: boolean;
      chainId: number;
      caip2?: string;
    } | null = null;
    try {
      // The vault's defense-in-depth envelope check (assertSolanaTransferTransactionMatches)
      // only models a single native SOL transfer. The instruction parser is the
      // authoritative policy check for ALL transaction shapes, so we only pass the
      // legacy envelope for the single-SystemProgram-transfer case (where it adds a
      // redundant byte-level assertion). For token / multi-instruction transactions
      // the parser already verified the effects against policy above.
      const isSingleNativeTransfer =
        derived.movesNativeSol &&
        derived.summary.tokenTransfers.length === 0 &&
        derived.summary.instructions.length === 1 &&
        derived.summary.instructions[0].instructionType === "system:Transfer" &&
        derived.to !== undefined;

      const staged = await stageSolanaRecoveryAnchor({
        agentId,
        transaction: body.transaction,
        chainId,
        toAddress,
        value: txValue,
        broadcastRequested: shouldBroadcast,
        blindSigned: false,
        policyResults: evaluation.results,
        binding,
      });
      if (!staged.executionToken) return solanaReplayResponse(c, staged.row);
      const ownerToken = staged.executionToken;
      executionToken = ownerToken;
      const result = await vault.signSolanaTransaction({
        agentId,
        tenantId,
        transaction: body.transaction,
        chainId,
        broadcast: body.broadcast,
        // SEC-163: non-single-transfer shapes carry no vault-layer envelope —
        // the instruction-parser policy check above approved the effects, so
        // the caller attests via allowBlindSign instead.
        ...(isSingleNativeTransfer
          ? { expectedTo: toAddress, expectedValue: txValue }
          : { allowBlindSign: true }),
        onBroadcastPrepared: (checkpoint) =>
          checkpointSolanaBroadcastSubmission(
            txId,
            agentId,
            ownerToken,
            checkpoint,
          ),
      });
      completedResult = { txId, ...result };

      await finalizeSolanaRecoveryAnchor(txId, agentId, ownerToken, result);

      // ── Record spend in Redis (fire-and-forget) ──────────────────────────────
      recordVaultSpend(agentId, tenantId, txValue, chainId).catch((err) =>
        logger.error(
          {
            details: [
              "[vault] Failed to record Solana spend",
              redactedThrownDiagnostics(err),
            ],
          },
          "[Login:vault] error",
        ),
      );

      await writeVaultAudit(c, {
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.solana",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          chainId,
          to: toAddress,
          value: txValue,
          broadcast: result.broadcast,
          ...signerAuthAuditMetadata(signerAuthorization.auth),
          signature: result.broadcast ? result.signature : undefined,
          // Authoritative, parser-derived effects (not caller-supplied).
          derivedFromTransaction: true,
          movesNativeSol: derived.movesNativeSol,
          programIds: derived.programIds,
          tokenTransfers: derived.summary.tokenTransfers.map((t) => ({
            mint: t.mint,
            destination: t.destination,
            amount: t.amount,
          })),
        },
      });

      dispatchWebhook(tenantId, agentId, "tx_signed", {
        txId,
        txHash: result.broadcast ? result.signature : undefined,
      });

      setNoStoreHeaders(c);
      return c.json<
        ApiResponse<{
          txId: string;
          signature: string;
          broadcast: boolean;
          chainId: number;
          caip2?: string;
        }>
      >({
        ok: true,
        data: { txId, ...result },
      });
    } catch (e: unknown) {
      const requestId = c.get("requestId") || "unknown";
      logger.error(
        {
          details: [
            `[${requestId}] Solana sign failed for agent ${agentId}`,
            redactedThrownDiagnostics(e),
          ],
        },
        "[Login:vault] error",
      );
      if (completedResult?.broadcast) {
        logger.error(
          {
            details: [
              `[${requestId}] Solana sign completed before bookkeeping failed for agent ${agentId}, tx ${txId}; returning completed result to prevent duplicate retry`,
            ],
          },
          "[Login:vault] error",
        );
        setNoStoreHeaders(c);
        return c.json<
          ApiResponse<{
            txId: string;
            signature: string;
            broadcast: boolean;
            chainId: number;
            caip2?: string;
          }>
        >({ ok: true, data: completedResult });
      }

      if (e instanceof SolanaIdempotencyConflictError) {
        return c.json<ApiResponse>({ ok: false, error: e.message }, 409);
      }
      if (e instanceof SolanaBroadcastNotSubmittedError) {
        await markSolanaBroadcastNotSubmitted(
          tenantId,
          txId,
          agentId,
          executionToken,
          e.transactionHash,
        );
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Solana RPC preflight rejected the transaction",
            data: { txId },
          },
          502,
        );
      }
      if (e instanceof ExternalBroadcastOutcomeUnknownError) {
        await preserveUnknownSolanaOutcome(
          txId,
          agentId,
          executionToken,
          e.transactionHash,
        );
        recordVaultSpend(agentId, tenantId, txValue, chainId).catch((err) =>
          logger.error(
            {
              details: [
                "[vault] Failed to record ambiguous Solana spend",
                redactedThrownDiagnostics(err),
              ],
            },
            "[Login:vault] error",
          ),
        );
        await writeOutcomeUnknownAudit(c, {
          tenantId,
          actorType: "agent",
          actorId: agentId,
          action: "vault.sign.solana.outcome_unknown",
          resourceType: "transaction",
          resourceId: txId,
          metadata: {
            chainId,
            to: toAddress,
            value: txValue,
            signature: e.transactionHash,
            derivedFromTransaction: true,
          },
        });
        return externalBroadcastOutcomeUnknownResponse(c, e, txId) as Response;
      }
      await markSolanaRecoveryAnchorFailed(txId, agentId, executionToken);
      const frozen = frozenSigningResponse(c, e);
      if (frozen) return frozen;

      dispatchWebhook(tenantId, agentId, "tx_failed", {
        error: "Transaction failed",
        ...redactedThrownDiagnostics(e),
        requestId,
      });

      if (isRpcError(e)) {
        return c.json<ApiResponse>(
          { ok: false, error: extractRpcErrorMessage(e) },
          502,
        );
      }
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(e) },
        500,
      );
    }
  });
});

vaultRoutes.post("/:agentId/transactions/:txId/reconcile-solana", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  if (!(await ensureAgentForTenant(tenantId, agentId))) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  const signerAuthorization = await requireSignerPermission(
    c,
    tenantId,
    agentId,
    "sign_transaction",
  );
  if (!signerAuthorization.ok) return signerAuthorization.response;

  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)))
    .limit(1);
  const metadata = readSolanaRecoveryMetadata(row?.actionPayload);
  if (!row || row.actionType !== "solana_transaction") {
    return c.json<ApiResponse>(
      { ok: false, error: "Solana transaction not found" },
      404,
    );
  }
  if (row.status !== "outcome_unknown") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Only outcome_unknown Solana transactions can be reconciled",
      },
      409,
    );
  }
  if (
    !isNonEmptyString(row.txHash) ||
    !isNonEmptyString(metadata.recentBlockhash)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Solana recovery checkpoint is incomplete" },
      409,
    );
  }
  const signature = row.txHash;
  const recentBlockhash = metadata.recentBlockhash;

  const nextStatus = await vault.reconcileSolanaBroadcast({
    signature,
    recentBlockhash,
    chainId: row.chainId,
  });
  if (nextStatus === "outcome_unknown") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Solana broadcast outcome is still unknown",
        data: { txId, signature: row.txHash, status: nextStatus },
      },
      202,
    );
  }

  const transitioned = await withTenantAuditedTransaction(
    tenantId,
    async (rawTx, appendRequiredAudit) => {
      const tx = rawTx as typeof db;
      const [updated] = await tx
        .update(transactions)
        .set({
          status: nextStatus,
          confirmedAt:
            nextStatus === "confirmed" ? new Date() : row.confirmedAt,
          actionPayload: {
            ...metadata,
            reconciledAt: new Date().toISOString(),
            reconciliationResult: nextStatus,
          },
        })
        .where(
          and(
            eq(transactions.id, txId),
            eq(transactions.agentId, agentId),
            eq(transactions.status, "outcome_unknown"),
            eq(transactions.txHash, signature),
          ),
        )
        .returning({ id: transactions.id });
      if (!updated) return false;
      await appendRequiredAudit({
        tenantId,
        actorType: "agent",
        actorId: agentId,
        action: "vault.sign.solana.reconciled",
        resourceType: "transaction",
        resourceId: txId,
        metadata: {
          previousStatus: "outcome_unknown",
          status: nextStatus,
          signature: row.txHash,
          evidence: "solana_signature_status",
          ...signerAuthAuditMetadata(signerAuthorization.auth),
        },
      });
      return true;
    },
  );
  if (!transitioned) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction state changed; retry" },
      409,
    );
  }
  return c.json<ApiResponse>({
    ok: true,
    data: { txId, signature: row.txHash, status: nextStatus },
  });
});

// ─── Generic RPC Passthrough ──────────────────────────────────────────────────

vaultRoutes.post("/:agentId/rpc", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<RpcRequest>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isNonEmptyString(body.method)) {
    return c.json<ApiResponse>(
      { ok: false, error: "'method' is required" },
      400,
    );
  }
  if (!VAULT_RPC_ALLOWLIST.has(body.method)) {
    return c.json<ApiResponse>(
      { ok: false, error: "RPC method is not allowlisted" },
      403,
    );
  }

  if (!body.chainId || typeof body.chainId !== "number") {
    return c.json<ApiResponse>(
      { ok: false, error: "'chainId' is required and must be a number" },
      400,
    );
  }

  try {
    const result = await vault.rpcPassthrough(body);
    return c.json<ApiResponse<RpcResponse>>({
      ok: true,
      data: result,
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error(
      {
        details: [
          `[${requestId}] RPC passthrough failed for agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// ─── Multi-Wallet Address List ────────────────────────────────────────────────

vaultRoutes.get("/:agentId/addresses", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  try {
    const addresses = await vault.getAddresses(tenantId, agentId);
    return c.json<
      ApiResponse<{
        agentId: string;
        addresses: Array<{
          chainFamily: "evm" | "solana" | "bitcoin" | "monero";
          address: string;
        }>;
      }>
    >({
      ok: true,
      data: { agentId, addresses },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    logger.error(
      {
        details: [
          `[${requestId}] getAddresses failed for agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── Key Import ───────────────────────────────────────────────────────────────

function encryptedImportDisabledResponse(
  c: Context<{ Variables: AppVariables }>,
): Response | null {
  if (allowPrivateKeyImport() && allowVaultPrivateKeyImport()) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error:
        "Encrypted private key import is disabled. Set STEWARD_ALLOW_PRIVATE_KEY_IMPORT=true and STEWARD_ALLOW_VAULT_PRIVATE_KEY_IMPORT=true only for audited import operations.",
    },
    403,
  );
}

async function requireEncryptedImportAccess(
  c: Context<{ Variables: AppVariables }>,
  tenantId: string,
  agentId: string,
): Promise<Response | null> {
  const disabled = encryptedImportDisabledResponse(c);
  if (disabled) return disabled;
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Encrypted key import requires tenant-level authentication",
      },
      403,
    );
  }
  if (!hasTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Encrypted key import requires tenant admin session authentication",
      },
      403,
    );
  }
  const mfaPolicy = await readTenantMfaPolicy(tenantId);
  if (tenantMfaDisabledFor(mfaPolicy, "keyImport")) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Private key import is disabled by tenant MFA policy",
      },
      403,
    );
  }
  if (!(await hasRecentTenantSessionMfa(c, tenantId, "keyImport"))) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Encrypted key import requires a recent MFA step-up session",
      },
      403,
    );
  }
  if (!isValidAgentId(agentId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid agent id — must be 1-128 alphanumeric characters (plus _ - . :)",
      },
      400,
    );
  }
  return null;
}

vaultRoutes.post("/:agentId/import/init", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const accessError = await requireEncryptedImportAccess(c, tenantId, agentId);
  if (accessError) return accessError;

  const body = await safeJsonParse<{ chain?: unknown }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const chain = body.chain;
  if (chain !== "evm" && chain !== "solana") {
    return c.json<ApiResponse>(
      { ok: false, error: "chain must be 'evm' or 'solana'" },
      400,
    );
  }

  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const session = await createEncryptedImportSession({
    tenantId,
    agentId,
    chain,
    createdBy: c.get("userId") ?? null,
  });
  await writeVaultAudit(c, {
    tenantId,
    actorType: "user",
    actorId: c.get("userId") ?? c.get("authType") ?? null,
    action: "vault.key.import_encrypted.initialized",
    resourceType: "agent",
    resourceId: agentId,
    metadata: {
      chain,
      importSessionId: session.id,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  });

  return c.json<
    ApiResponse<{
      importSessionId: string;
      publicKey: string;
      algorithm: "X25519-HKDF-SHA256-AES-256-GCM";
      expiresAt: string;
      aad: {
        importSessionId: string;
        tenantId: string;
        agentId: string;
        chain: "evm" | "solana";
      };
    }>
  >({
    ok: true,
    data: {
      importSessionId: session.id,
      publicKey: session.publicKey,
      algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
      expiresAt: new Date(session.expiresAt).toISOString(),
      aad: { importSessionId: session.id, tenantId, agentId, chain },
    },
  });
});

vaultRoutes.post("/:agentId/import/submit", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const accessError = await requireEncryptedImportAccess(c, tenantId, agentId);
  if (accessError) return accessError;

  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    importSessionId?: unknown;
    ephemeralPublicKey?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
    tag?: unknown;
    privateKey?: unknown;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (body.privateKey !== undefined) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Plaintext privateKey is not accepted by encrypted import submit",
      },
      400,
    );
  }

  const session = await takeEncryptedImportSession(
    body.importSessionId,
    tenantId,
    agentId,
  );
  if (typeof session === "string") {
    return c.json<ApiResponse>({ ok: false, error: session }, 400);
  }

  let privateKey: string | null = null;
  try {
    privateKey = decryptEncryptedImportPrivateKey(session, body);
  } catch {
    privateKey = null;
  }
  if (!privateKey || !isNonEmptyString(privateKey)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Encrypted private key payload could not be decrypted",
      },
      400,
    );
  }

  try {
    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.key.import_encrypted.authorized",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { chain: session.chain, importSessionId: session.id },
    });
    const result = await vault.importKey(
      tenantId,
      agentId,
      privateKey,
      session.chain,
    );
    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.key.import_encrypted",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { chain: session.chain, walletAddress: result.walletAddress },
    });
    return c.json<
      ApiResponse<{ agentId: string; walletAddress: string; chain: string }>
    >({
      ok: true,
      data: {
        agentId,
        walletAddress: result.walletAddress,
        chain: session.chain,
      },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    logger.error(
      {
        details: [
          `[${requestId}] Encrypted key import failed for agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

vaultRoutes.post("/:agentId/import", async (c) => {
  if (!allowPrivateKeyImport() || !allowVaultPrivateKeyImport()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Private key import is disabled. Set STEWARD_ALLOW_PRIVATE_KEY_IMPORT=true and STEWARD_ALLOW_VAULT_PRIVATE_KEY_IMPORT=true only for audited break-glass operations.",
      },
      403,
    );
  }

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key import requires tenant-level authentication" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  if (!hasTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Key import requires tenant admin session authentication",
      },
      403,
    );
  }
  const mfaPolicy = await readTenantMfaPolicy(tenantId);
  if (tenantMfaDisabledFor(mfaPolicy, "keyImport")) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Private key import is disabled by tenant MFA policy",
      },
      403,
    );
  }
  if (!(await hasRecentTenantSessionMfa(c, tenantId, "keyImport"))) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key import requires a recent MFA step-up session" },
      403,
    );
  }

  if (!isValidAgentId(agentId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid agent id — must be 1-128 alphanumeric characters (plus _ - . :)",
      },
      400,
    );
  }
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    privateKey: string;
    chain: "evm" | "solana";
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isNonEmptyString(body.privateKey)) {
    return c.json<ApiResponse>(
      { ok: false, error: "privateKey is required" },
      400,
    );
  }

  if (body.chain !== "evm" && body.chain !== "solana") {
    return c.json<ApiResponse>(
      { ok: false, error: "chain must be 'evm' or 'solana'" },
      400,
    );
  }

  try {
    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.key.import.authorized",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { chain: body.chain },
    });
    const result = await vault.importKey(
      tenantId,
      agentId,
      body.privateKey,
      body.chain,
    );
    await writeVaultAudit(c, {
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.key.import",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { chain: body.chain, walletAddress: result.walletAddress },
    });
    return c.json<
      ApiResponse<{ agentId: string; walletAddress: string; chain: string }>
    >({
      ok: true,
      data: { agentId, walletAddress: result.walletAddress, chain: body.chain },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    logger.error(
      {
        details: [
          `[${requestId}] Key import failed for agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── Key Export ──────────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/export", async (c) => {
  if (!allowPrivateKeyExport() || !allowVaultPrivateKeyExport()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Private key export is disabled. Set STEWARD_ALLOW_KEY_EXPORT=true, STEWARD_ALLOW_PRIVATE_KEY_EXPORT=true, and STEWARD_ALLOW_VAULT_PRIVATE_KEY_EXPORT=true only for audited break-glass operations.",
      },
      403,
    );
  }

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key export requires tenant-level authentication" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  if (!hasTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Key export requires tenant admin session authentication",
      },
      403,
    );
  }
  const mfaPolicy = await readTenantMfaPolicy(tenantId);
  if (tenantMfaDisabledFor(mfaPolicy, "keyExport")) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Private key export is disabled by tenant MFA policy",
      },
      403,
    );
  }
  if (!(await hasRecentTenantSessionMfa(c, tenantId, "keyExport"))) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key export requires a recent MFA step-up session" },
      403,
    );
  }
  const body = await safeJsonParse(c);
  const plaintextGateError = plaintextKeyExportResponseGateError(body);
  if (plaintextGateError) {
    return c.json<ApiResponse>({ ok: false, error: plaintextGateError }, 403);
  }

  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.private_key_export.authorized",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: { breakGlass: true },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    const keys = await vault.exportPrivateKey(tenantId, agentId, {
      breakGlass: true,
      actorId: c.get("userId") ?? c.get("authType") ?? "unknown",
      reason: "tenant-admin break-glass export",
    });
    const exportedFamilies = [
      keys.evm ? "evm" : null,
      keys.solana ? "solana" : null,
      keys.bitcoin && keys.bitcoin.length > 0 ? "bitcoin" : null,
    ].filter((family): family is string => Boolean(family));
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: c.get("userId") ?? c.get("authType") ?? null,
      action: "vault.private_key_export.succeeded",
      resourceType: "wallet",
      resourceId: agentId,
      metadata: {
        breakGlass: true,
        chainFamilies: exportedFamilies,
        bitcoinWalletCount: keys.bitcoin?.length ?? 0,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    dispatchWebhook(tenantId, agentId, "private_key.exported", {
      agentId,
      breakGlass: true,
    });

    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json<
      ApiResponse<
        ExportPrivateKeyResult & {
          warning: string;
        }
      >
    >({
      ok: true,
      data: {
        ...keys,
        warning: "This key controls real funds. Store securely.",
      },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    logger.error(
      {
        details: [
          `[${requestId}] Key export failed for agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:vault] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});
