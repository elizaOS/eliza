/**
 * user.ts — User-facing wallet routes
 *
 * Route group mounted under `/user` (or wherever the main app mounts it).
 * All routes require a valid JWT session token in the `Authorization: Bearer <token>` header.
 *
 * Routes:
 *   GET  /me                  — current user info
 *   GET  /me/wallet           — wallet address + on-chain balance
 *   POST /me/wallet           — provision wallet if absent
 *   POST /me/wallet/sign      — sign a transaction (policy-enforced)
 *   GET  /me/wallet/history   — transaction history
 *   GET  /me/wallet/policies  — view active policies on the user's wallet
 *   POST /me/wallet/sign-message — sign arbitrary message data
 *
 * NOTE: Do NOT import or modify packages/api/src/index.ts.
 *       This file exports a Hono route group ready for mounting.
 */

import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { logger } from "@elizaos/logger";
import bs58 from "bs58";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { type Context, Hono, type Next } from "hono";
import { getAddress, verifyMessage as viemVerifyMessage } from "viem";
import { requireLoginValue } from "../../../../required";
import {
  ChallengeStore,
  generateApiKey,
  getProviderConfig,
  hashSha256Hex,
  isBuiltInProvider,
  isValidE164,
  MemoryBackend,
  NamespacedStoreBackend,
  OAuthClient,
  revocationStore,
  type StoreBackend,
  type TelegramLoginPayload,
  uint8ArrayToBase64url,
  verifyFarcasterLogin,
  verifyTelegramLogin,
} from "../../../auth/src/index.ts";
import {
  accounts,
  agentSigners,
  agents,
  agentWallets,
  auditEvents,
  authenticators,
  getDb,
  policies,
  refreshTokens,
  tenantAppClients,
  tenantConfigs,
  tenantInvitations,
  tenants,
  toPolicyRule,
  toTxRecord,
  transactions,
  userPushSubscriptions,
  users,
  userTenants,
  userWalletAppConsents,
} from "../../../db/src/index.ts";
import { PolicyEngine } from "../../../policy-engine/src/index.ts";
import {
  type AgentBalance,
  type AgentIdentity,
  type ApiResponse,
  type ChainFamily,
  type PolicyRule,
  redactedThrownDiagnostics,
  type SignRequest,
  type TenantAuthAbuseConfig,
} from "../../../shared/src/index.ts";
import {
  applyUserWalletDefaults,
  generateMnemonic,
  getUserWallet,
  isValidMnemonic,
  normalizeUserWalletIndex,
  provisionRecoverableUserWallet,
  provisionUserWallet,
  restoreRecoverableUserWallet,
  USER_WALLET_DEFAULT_POLICIES,
  type Vault,
} from "../../../vault/src/index.ts";
import { writeAuditEvent } from "../services/audit";
import {
  continueWithTenantDatabase,
  priceOracle,
  sanitizeErrorMessage,
  setNoStoreHeaders,
  verifySessionToken,
} from "../services/context";
import {
  publicGasSponsorshipState,
  readTenantGasSponsorshipConfig,
} from "../services/gas-sponsorship";
import { plaintextKeyExportResponseGateError } from "../services/key-export-plaintext-gate";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import { lockUserSession } from "../services/session-lock";
import {
  createSignerCredentialHash,
  verifySignerCredential,
} from "../services/signer-credentials";
import { getConfiguredVault } from "../services/vault-factory";
import { redactWalletMetadataSecrets } from "../services/wallet-metadata";
import { dispatchWebhook } from "../services/webhook-dispatch";
import {
  assertAllowedOAuthRedirectUri,
  claimSmsVerifyAttempt,
  clearSmsVerifyFailures,
  createSessionToken,
  decryptImportSessionJson,
  encryptImportSessionJson,
  encryptOAuthProviderTokens,
  getEmailAuthForTenant,
  getImportSessionBackend,
  getPhoneAuth,
  releaseUnattemptedSmsVerifyClaim,
} from "./auth";

// ─── Session payload types ────────────────────────────────────────────────────

interface UserSessionPayload {
  userId: string;
  address?: string;
  email?: string;
  tenantId?: string;
  iat?: number;
  exp?: number;
  mfaVerifiedAt?: number;
  mfaMethod?: string;
  factorEnrollmentVerifiedAt?: number;
  [key: string]: unknown;
}

type UserVariables = {
  userId: string;
  userSession: UserSessionPayload;
  authType?: "session-jwt" | "user-wallet-signer";
  userWalletSignerAuth?: {
    signerId: string;
    tenantId: string;
    agentId: string;
    requiredPermission: string;
  };
  sessionMfaVerifiedAt?: number;
  sessionMfaMethod?: string;
  requestId?: string;
};

type UserAccountRow = typeof accounts.$inferSelect;
type UserAuthenticatorRow = typeof authenticators.$inferSelect;
type UserRefreshTokenRow = typeof refreshTokens.$inferSelect;

type UserAccountUnlinkMutation = {
  accountId: string;
  deletedAccount?: UserAccountRow;
  deletedPasskey?: UserAuthenticatorRow;
  deletedRefreshTokens: UserRefreshTokenRow[];
};

type UserWalletSignResult =
  | { approved: false; results: unknown }
  | { approved: true; txId: string; txHash: string };

type UserPortfolioAsset = {
  token: string;
  symbol: string;
  balance: string;
  formatted: string;
  decimals: number;
  usdPrice: number | null;
  usdValue: number | null;
  usdPriceText: string | null;
  usdValueText: string | null;
};

const MAX_CUSTOM_TOKEN_BALANCES = 25;
const MAX_USER_WALLET_SIGNER_PERMISSIONS = 16;
const MAX_USER_WALLET_SIGNER_METADATA_BYTES = 8_192;
const USER_WALLET_ENCRYPTED_IMPORT_SESSION_TTL_MS = 10 * 60_000;
const USER_WALLET_ENCRYPTED_IMPORT_MAX_CIPHERTEXT_BYTES = 4096;
const USER_ACCOUNT_CAPABILITIES = [
  "sign_transaction",
  "sign_message",
  "transfer",
  "solana_transaction",
  "export_private_key",
] as const;
const USD_SCALE_DECIMALS = 18;
const WALLET_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const WALLET_LINK_REDEEM_LOCK_TTL_MS = 10_000;
const SOCIAL_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const OAUTH_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const initialUserLinkBackend = new MemoryBackend();
let currentUserLinkBackend: StoreBackend | null = null;
let walletLinkChallenges: ChallengeStore;
let socialLinkChallenges: ChallengeStore;
let oauthLinkChallenges: ChallengeStore;

/** Bind account-link challenges to auth startup's selected durable backend. */
export function initUserLinkChallengeStores(backend: StoreBackend): void {
  const supersededBackend = currentUserLinkBackend;
  currentUserLinkBackend = backend;
  walletLinkChallenges = new ChallengeStore({
    backend: new NamespacedStoreBackend(backend, "user-link-wallet"),
    ttlMs: WALLET_LINK_CHALLENGE_TTL_MS,
  });
  socialLinkChallenges = new ChallengeStore({
    backend: new NamespacedStoreBackend(backend, "user-link-social"),
    ttlMs: SOCIAL_LINK_CHALLENGE_TTL_MS,
  });
  oauthLinkChallenges = new ChallengeStore({
    backend: new NamespacedStoreBackend(backend, "user-link-oauth"),
    ttlMs: OAUTH_LINK_CHALLENGE_TTL_MS,
  });
  if (
    supersededBackend instanceof MemoryBackend &&
    supersededBackend !== backend
  ) {
    supersededBackend.destroy();
  }
}

// Development and tests remain process-local until auth startup selects the
// shared backend. Every entry is still bounded by the flow-specific TTL.
initUserLinkChallengeStores(initialUserLinkBackend);
const TELEGRAM_LINK_MAX_AGE_SEC = 24 * 60 * 60;
const TENANT_ROLES = [
  "owner",
  "admin",
  "developer",
  "billing",
  "viewer",
  "member",
] as const;
type TenantRole = (typeof TENANT_ROLES)[number];
const TENANT_INVITATION_ROLES = [
  "admin",
  "developer",
  "billing",
  "viewer",
  "member",
] as const;
type TenantInvitationRole = (typeof TENANT_INVITATION_ROLES)[number];
const MAX_TENANT_METADATA_BYTES = 16_384;
const MAX_TENANT_METADATA_DEPTH = 8;
const MAX_TENANT_METADATA_KEYS = 100;
const MAX_TENANT_METADATA_STRING_BYTES = 4_096;
const PUSH_PROVIDERS = ["expo", "apns", "fcm"] as const;
const PUSH_PLATFORMS = ["ios", "android"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PUSH_METADATA_BYTES = 8_192;
const PREGENERATED_USER_WALLET_TYPE = "pregenerated_user";
const PREGENERATED_CLAIM_PREFIX = "pregenerated:";
const CLAIMED_PREGENERATED_CLAIM_PREFIX = "claimed:";
const EXPIRED_PREGENERATED_CLAIM_PREFIX = "expired:";
const EMBEDDED_WALLET_CREATE_ON_LOGIN = [
  "off",
  "users-without-wallets",
  "all-users",
] as const;
const USER_WALLET_SIGNER_STATUSES = new Set(["active", "paused", "revoked"]);
const USER_WALLET_SIGNER_SUBJECT_TYPES = new Set([
  "user",
  "wallet",
  "external",
]);
const USER_WALLET_SIGNER_ALLOWED_PERMISSIONS = new Set([
  "sign_transaction",
  "sign_message",
  "sign_typed_data",
  "sign_user_operation",
  "sign_authorization",
  "transfer",
  "solana_transaction",
]);
const USER_WALLET_SIGNER_FORBIDDEN_PERMISSIONS = new Set([
  "export_private_key",
  "private_key_export",
  "export_key",
  "recovery_setup",
  "recovery_restore",
  "restore_recovery",
  "policy_mutation",
  "policy_update",
  "policy_create",
  "policy_delete",
  "owner_update",
  "owner_add",
  "owner_remove",
]);
const RESERVED_SIGNER_METADATA_KEYS = new Set([
  "credentialHash",
  "credentialCreatedAt",
  "credentialLastUsedAt",
]);

type EmbeddedWalletCreateOnLogin =
  (typeof EMBEDDED_WALLET_CREATE_ON_LOGIN)[number];
type EmbeddedWalletLoginConfig = {
  tenantId: string;
  clientId?: string;
  createOnLogin: EmbeddedWalletCreateOnLogin;
};

function pregeneratedClaimPlatformIdPrefix(claimTokenHash: string): string {
  return `${PREGENERATED_CLAIM_PREFIX}${claimTokenHash}`;
}

function parsePregeneratedClaimPlatformId(
  platformId: string | null,
  claimTokenHash: string,
): { hash: string; expiresAt: Date | null } | null {
  const prefix = pregeneratedClaimPlatformIdPrefix(claimTokenHash);
  if (platformId === prefix) return { hash: claimTokenHash, expiresAt: null };
  if (!platformId?.startsWith(`${prefix}:`)) return null;
  const expiresAtMs = Number(platformId.slice(prefix.length + 1));
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) return null;
  return { hash: claimTokenHash, expiresAt: new Date(expiresAtMs) };
}

type PushProvider = (typeof PUSH_PROVIDERS)[number];
type PushPlatform = (typeof PUSH_PLATFORMS)[number];
type UserWalletSignerRow = typeof agentSigners.$inferSelect;
type UserWalletEncryptedImportSession = {
  id: string;
  tenantId: string;
  userId: string;
  agentId: string;
  chain: "evm" | "solana";
  walletIndex: number;
  appId: string | null;
  privateKey: string;
  publicKey: string;
  createdAt: number;
  expiresAt: number;
};

type TenantMfaPolicyConfig = {
  maxAgeSeconds?: number;
  maxAgeFor?: {
    keyImport?: number;
    keyExport?: number;
  };
  requireFor?: {
    keyImport?: boolean;
    keyExport?: boolean;
  };
  disableFor?: {
    keyImport?: boolean;
    keyExport?: boolean;
  };
};

type TenantAuthAbuseConfigWithMfa = TenantAuthAbuseConfig & {
  mfa?: TenantMfaPolicyConfig;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeJsonParse<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

function userWalletAgentId(userId: string, walletIndex = 0): string {
  return walletIndex === 0
    ? `user-wallet-${userId}`
    : `user-wallet-${userId}-${walletIndex}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function exportImportKeyDerBase64Url(
  key: KeyObject,
  type: "spki" | "pkcs8",
): string {
  return base64UrlEncode(key.export({ type, format: "der" }) as Uint8Array);
}

function userWalletEncryptedImportSessionStoreKey(id: string): string {
  return `user-wallet:${id}`;
}

function parseStoredUserWalletEncryptedImportSession(
  raw: string | null,
): UserWalletEncryptedImportSession | null {
  if (!raw) return null;
  try {
    const parsed =
      decryptImportSessionJson<Partial<UserWalletEncryptedImportSession>>(raw);
    const walletIndex = parsed.walletIndex;
    const createdAt = parsed.createdAt;
    const expiresAt = parsed.expiresAt;
    if (
      !isNonEmptyString(parsed.id) ||
      !isNonEmptyString(parsed.tenantId) ||
      !isNonEmptyString(parsed.userId) ||
      !isNonEmptyString(parsed.agentId) ||
      (parsed.chain !== "evm" && parsed.chain !== "solana") ||
      typeof walletIndex !== "number" ||
      !Number.isSafeInteger(walletIndex) ||
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
      userId: parsed.userId,
      agentId: parsed.agentId,
      chain: parsed.chain,
      walletIndex,
      appId: typeof parsed.appId === "string" ? parsed.appId : null,
      privateKey: parsed.privateKey,
      publicKey: parsed.publicKey,
      createdAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

async function createUserWalletEncryptedImportSession(input: {
  tenantId: string;
  userId: string;
  agentId: string;
  chain: "evm" | "solana";
  walletIndex: number;
  appId: string | null;
}): Promise<UserWalletEncryptedImportSession> {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const id = `uwimp_${base64UrlEncode(randomBytes(24))}`;
  const now = Date.now();
  const session: UserWalletEncryptedImportSession = {
    ...input,
    id,
    privateKey: exportImportKeyDerBase64Url(privateKey, "pkcs8"),
    publicKey: exportImportKeyDerBase64Url(publicKey, "spki"),
    createdAt: now,
    expiresAt: now + USER_WALLET_ENCRYPTED_IMPORT_SESSION_TTL_MS,
  };
  await getImportSessionBackend().set(
    userWalletEncryptedImportSessionStoreKey(id),
    encryptImportSessionJson(session),
    USER_WALLET_ENCRYPTED_IMPORT_SESSION_TTL_MS,
  );
  return session;
}

async function takeUserWalletEncryptedImportSession(
  id: unknown,
  expected: {
    tenantId: string;
    userId: string;
    walletIndex: number;
    appId: string | null;
  },
): Promise<UserWalletEncryptedImportSession | null> {
  if (typeof id !== "string" || !id) return null;
  const key = userWalletEncryptedImportSessionStoreKey(id);
  const session = parseStoredUserWalletEncryptedImportSession(
    await getImportSessionBackend().get(key),
  );
  if (!session) return null;
  if (
    session.expiresAt <= Date.now() ||
    session.tenantId !== expected.tenantId ||
    session.userId !== expected.userId ||
    session.walletIndex !== expected.walletIndex ||
    session.appId !== expected.appId
  ) {
    return null;
  }
  const consumed = parseStoredUserWalletEncryptedImportSession(
    await getImportSessionBackend().consume(key),
  );
  if (
    !consumed ||
    consumed.expiresAt <= Date.now() ||
    consumed.tenantId !== expected.tenantId ||
    consumed.userId !== expected.userId ||
    consumed.walletIndex !== expected.walletIndex ||
    consumed.appId !== expected.appId
  ) {
    return null;
  }
  return consumed;
}

function decryptUserWalletEncryptedPrivateKey(
  session: UserWalletEncryptedImportSession,
  payload: {
    ephemeralPublicKey?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
    tag?: unknown;
  },
): string {
  if (
    typeof payload.ephemeralPublicKey !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.ciphertext !== "string" ||
    typeof payload.tag !== "string"
  ) {
    throw new Error("Encrypted import envelope is incomplete");
  }
  const ephemeralPublicKeyDer = base64UrlDecode(payload.ephemeralPublicKey);
  const iv = base64UrlDecode(payload.iv);
  const ciphertext = base64UrlDecode(payload.ciphertext);
  const tag = base64UrlDecode(payload.tag);
  if (!ephemeralPublicKeyDer || !iv || !ciphertext || !tag) {
    throw new Error("Encrypted import envelope is not valid base64url");
  }
  if (iv.byteLength !== 12)
    throw new Error("Encrypted import iv must be 12 bytes");
  if (tag.byteLength !== 16)
    throw new Error("Encrypted import tag must be 16 bytes");
  if (
    ciphertext.byteLength === 0 ||
    ciphertext.byteLength > USER_WALLET_ENCRYPTED_IMPORT_MAX_CIPHERTEXT_BYTES
  ) {
    throw new Error("Encrypted import ciphertext has an invalid size");
  }
  const privateKeyDer = base64UrlDecode(session.privateKey);
  if (!privateKeyDer) {
    throw new Error("Encrypted import session is invalid");
  }

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
    `steward:user-wallet-import:v1:${session.tenantId}:${session.userId}:${session.agentId}:${session.chain}:${session.walletIndex}:${session.appId ?? ""}:${session.id}`,
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
  decipher.setAAD(new TextEncoder().encode(session.id) as never);
  decipher.setAuthTag(tag as never);
  const plaintext = new Uint8Array([
    ...decipher.update(ciphertext as never),
    ...decipher.final(),
  ]);
  return new TextDecoder().decode(plaintext);
}

function parseUserWalletIndex(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  try {
    return { ok: true, value: normalizeUserWalletIndex(value) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "walletIndex must be valid",
    };
  }
}

function parseUserWalletIndexSelector(
  walletIndex: unknown,
  wallet_index: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  const hasCamel = walletIndex !== undefined && walletIndex !== null;
  const hasSnake = wallet_index !== undefined && wallet_index !== null;
  if (!hasCamel && !hasSnake) return { ok: true, value: 0 };

  const camel = hasCamel ? parseUserWalletIndex(walletIndex) : null;
  const snake = hasSnake ? parseUserWalletIndex(wallet_index) : null;
  if (camel && !camel.ok) return camel;
  if (snake && !snake.ok) return snake;
  if (camel && snake && camel.value !== snake.value) {
    return {
      ok: false,
      error: "walletIndex and wallet_index must match when both are provided",
    };
  }
  return camel ?? snake ?? { ok: true, value: 0 };
}

async function parseOptionalJsonBody<T extends Record<string, unknown>>(
  c: Context,
): Promise<{ ok: true; value: T | null } | { ok: false; error: string }> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: true, value: null };
  }
  const rawBody = await c.req.raw.clone().text();
  if (rawBody.trim() === "") {
    return { ok: true, value: null };
  }
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isPlainObject(parsed)) {
      return { ok: false, error: "JSON request body must be an object" };
    }
    return { ok: true, value: parsed as T };
  } catch {
    return { ok: false, error: "Invalid JSON in request body" };
  }
}

function walletIndexAuditValue(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  return Array.isArray(value) ? "[array]" : `[${typeof value}]`;
}

function isValidAddress(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_\-.:]{1,64}$/.test(value);
}

function normalizePublicClientId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,63}$/.test(normalized) ? normalized : undefined;
}

function parseAppId(
  value: unknown,
): { tenantId: string; clientId: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const index = trimmed.lastIndexOf("/");
  if (index <= 0 || index === trimmed.length - 1) return null;
  const tenantId = trimmed.slice(0, index);
  const clientId = normalizePublicClientId(trimmed.slice(index + 1));
  if (!isValidTenantId(tenantId) || !clientId) return null;
  return { tenantId, clientId };
}

function isEmbeddedWalletCreateOnLogin(
  value: unknown,
): value is EmbeddedWalletCreateOnLogin {
  return (
    typeof value === "string" &&
    EMBEDDED_WALLET_CREATE_ON_LOGIN.includes(
      value as EmbeddedWalletCreateOnLogin,
    )
  );
}

function isPushProvider(value: unknown): value is PushProvider {
  return (
    typeof value === "string" && PUSH_PROVIDERS.includes(value as PushProvider)
  );
}

function isPushPlatform(value: unknown): value is PushPlatform {
  return (
    typeof value === "string" && PUSH_PLATFORMS.includes(value as PushPlatform)
  );
}

function normalizedOptionalString(
  value: unknown,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeUserWalletSignerSubjectType(value: unknown): string {
  if (value === undefined || value === null || value === "") return "external";
  const subjectType = normalizeOptionalText(value, "subjectType", 32) ?? "";
  if (!USER_WALLET_SIGNER_SUBJECT_TYPES.has(subjectType)) {
    throw new Error("subjectType must be one of: user, wallet, external");
  }
  return subjectType;
}

function normalizeUserWalletSignerSubjectId(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return `user-wallet-signer:${crypto.randomUUID()}`;
  }
  return normalizeOptionalText(value, "subjectId", 255) as string;
}

function normalizeUserWalletSignerPermissions(value: unknown): string[] {
  if (value === undefined) return ["sign_transaction"];
  if (!Array.isArray(value))
    throw new Error("permissions must be an array of strings");
  if (value.length > MAX_USER_WALLET_SIGNER_PERMISSIONS) {
    throw new Error(
      `permissions cannot contain more than ${MAX_USER_WALLET_SIGNER_PERMISSIONS} entries`,
    );
  }
  const permissions = [
    ...new Set(
      value.map((permission) => {
        if (typeof permission !== "string" || !permission.trim()) {
          throw new Error("permissions must be non-empty strings");
        }
        const normalized = permission.trim();
        if (normalized.length > 128)
          throw new Error("permissions entries must be 128 chars or less");
        return normalized;
      }),
    ),
  ];
  if (permissions.length === 0)
    throw new Error("permissions must contain at least one entry");
  for (const permission of permissions) {
    if (
      USER_WALLET_SIGNER_FORBIDDEN_PERMISSIONS.has(permission) ||
      !USER_WALLET_SIGNER_ALLOWED_PERMISSIONS.has(permission)
    ) {
      throw new Error(
        "user wallet signers may only receive signing permissions; private-key export, recovery, policy, and owner permissions are forbidden",
      );
    }
  }
  return permissions;
}

function normalizeUserWalletSignerMetadata(
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error("metadata must be an object");
  if (JSON.stringify(value).length > MAX_USER_WALLET_SIGNER_METADATA_BYTES) {
    throw new Error(
      `metadata cannot exceed ${MAX_USER_WALLET_SIGNER_METADATA_BYTES} bytes`,
    );
  }
  for (const key of Object.keys(value)) {
    if (RESERVED_SIGNER_METADATA_KEYS.has(key)) {
      throw new Error(
        `metadata.${key} is reserved and cannot be set by clients`,
      );
    }
  }
  return value;
}

function createUserWalletSignerSecret(): string {
  return `stwd_signer_${randomBytes(32).toString("hex")}`;
}

function redactSignerMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const {
    credentialHash: _credentialHash,
    credentialCreatedAt: _credentialCreatedAt,
    credentialLastUsedAt: _credentialLastUsedAt,
    ...safeMetadata
  } = metadata;
  return safeMetadata;
}

function toUserWalletSignerResponse(row: UserWalletSignerRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    signerType: row.signerType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    keyType: row.keyType,
    publicKey: row.publicKey,
    address: row.address,
    chainFamily: row.chainFamily,
    label: row.label,
    permissions: row.permissions,
    policyIds: row.policyIds,
    metadata: redactSignerMetadata(row.metadata),
    hasCredential: typeof row.metadata.credentialHash === "string",
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePushToken(
  token: unknown,
  provider: PushProvider,
): string | null {
  if (typeof token !== "string") return null;
  const normalized = token.trim();
  if (
    normalized.length < 16 ||
    normalized.length > 4096 ||
    /\s/.test(normalized)
  )
    return null;
  if (provider === "apns" && !/^[0-9a-f]{64}$/i.test(normalized)) return null;
  if (
    provider === "expo" &&
    !/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizePushMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return null;
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_PUSH_METADATA_BYTES
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return value;
}

function isValidUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isReservedTenantId(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "platform" ||
    normalized === "system" ||
    normalized === "default" ||
    normalized === "personal" ||
    normalized.startsWith("personal-") ||
    normalized.startsWith("eth:") ||
    normalized.startsWith("t-") ||
    normalized.startsWith("solana:")
  );
}

function normalizeTenantRole(value: unknown): TenantRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return (TENANT_ROLES as readonly string[]).includes(role)
    ? (role as TenantRole)
    : null;
}

function normalizeTenantInvitationRole(
  value: unknown,
): TenantInvitationRole | null {
  if (value === undefined || value === null || value === "") return "member";
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return (TENANT_INVITATION_ROLES as readonly string[]).includes(role)
    ? (role as TenantInvitationRole)
    : null;
}

function normalizeInvitationExpiry(value: unknown): Date {
  const maxSeconds = 30 * 24 * 60 * 60;
  const defaultSeconds = 7 * 24 * 60 * 60;
  const seconds =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, maxSeconds)
      : defaultSeconds;
  return new Date(Date.now() + seconds * 1000);
}

function getTenantMetadataValidationError(value: unknown): string | null {
  if (!isPlainObject(value)) return "tenantCustomMetadata must be an object";

  let keyCount = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    if (current.depth > MAX_TENANT_METADATA_DEPTH) {
      return `tenantCustomMetadata must not exceed ${MAX_TENANT_METADATA_DEPTH} levels`;
    }
    if (typeof current.value === "string") {
      if (
        new TextEncoder().encode(current.value).length >
        MAX_TENANT_METADATA_STRING_BYTES
      ) {
        return `tenantCustomMetadata string values must not exceed ${MAX_TENANT_METADATA_STRING_BYTES} bytes`;
      }
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "number" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (Array.isArray(current.value)) {
      keyCount += current.value.length;
      if (keyCount > MAX_TENANT_METADATA_KEYS) {
        return `tenantCustomMetadata must not contain more than ${MAX_TENANT_METADATA_KEYS} keys or items`;
      }
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (isPlainObject(current.value)) {
      const entries = Object.entries(current.value);
      keyCount += entries.length;
      if (keyCount > MAX_TENANT_METADATA_KEYS) {
        return `tenantCustomMetadata must not contain more than ${MAX_TENANT_METADATA_KEYS} keys or items`;
      }
      for (const [, child] of entries) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    return "tenantCustomMetadata must contain only JSON values";
  }

  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    MAX_TENANT_METADATA_BYTES
  ) {
    return `tenantCustomMetadata must not exceed ${MAX_TENANT_METADATA_BYTES} bytes`;
  }
  return null;
}

function tenantUserCsvRow(
  fields: Array<string | number | boolean | Date | null | undefined>,
): string {
  return fields
    .map((field) => {
      const raw =
        field instanceof Date ? field.toISOString() : String(field ?? "");
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
        return `"${safe.replace(/"/g, '""')}"`;
      }
      return safe;
    })
    .join(",");
}

function slugifyTenantId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function userTenantCreationAllowed(): boolean {
  return process.env.ALLOW_USER_TENANT_CREATION === "true";
}

async function writeUserAudit(
  c: Context<{ Variables: UserVariables }>,
  event: {
    tenantId: string;
    actorType: "user";
    actorId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await writeAuditEvent({
    ...event,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
}

async function writeInvalidUserWalletIndexAudit(
  c: Context<{ Variables: UserVariables }>,
  params: {
    userId: string;
    action: string;
    error: string;
    walletIndex?: unknown;
    wallet_index?: unknown;
  },
): Promise<void> {
  try {
    await writeUserAudit(c, {
      tenantId: `personal-${params.userId}`,
      actorType: "user",
      actorId: params.userId,
      action: params.action,
      resourceType: "wallet",
      resourceId: `user-wallet-${params.userId}`,
      metadata: {
        rejected: true,
        reason: "invalid_wallet_index",
        error: params.error,
        walletIndex: walletIndexAuditValue(params.walletIndex),
        wallet_index: walletIndexAuditValue(params.wallet_index),
      },
    });
  } catch (error) {
    logger.warn(
      {
        details: [
          "[UserWallet] Failed to audit invalid wallet index selector",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:user] warn",
    );
  }
}

async function restoreUserAccountUnlinkMutation(
  mutation: UserAccountUnlinkMutation,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    if (mutation.deletedAccount) {
      await tx
        .insert(accounts)
        .values(mutation.deletedAccount)
        .onConflictDoNothing();
    }
    if (mutation.deletedPasskey) {
      await tx
        .insert(authenticators)
        .values(mutation.deletedPasskey)
        .onConflictDoNothing();
    }
    if (mutation.deletedRefreshTokens.length > 0) {
      await tx
        .insert(refreshTokens)
        .values(mutation.deletedRefreshTokens)
        .onConflictDoNothing();
    }
  });
}

function hasRecentMfaStepUp(
  session: UserSessionPayload,
  maxAgeMs = 5 * 60_000,
): boolean {
  return isRecentMfaTimestamp(session.mfaVerifiedAt, maxAgeMs);
}

async function readPersonalTenantMfaPolicy(
  tenantId: string,
): Promise<TenantMfaPolicyConfig> {
  const [row] = await getDb()
    .select({ authAbuseConfig: tenantConfigs.authAbuseConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));
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
    : 5 * 60_000;
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

async function requireUserWalletPrivateKeyPolicy(
  c: Context<{ Variables: UserVariables }>,
  action: "keyImport" | "keyExport",
): Promise<Response | null> {
  const userId = c.get("userId");
  const session = c.get("userSession");
  const tenantId = personalTenantId(userId);
  const policy = await readPersonalTenantMfaPolicy(tenantId);
  if (tenantMfaDisabledFor(policy, action)) {
    const label = action === "keyImport" ? "import" : "export";
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Private key ${label} is disabled by tenant MFA policy`,
      },
      403,
    );
  }
  if (
    tenantMfaRequiredFor(policy, action) &&
    !hasRecentMfaStepUp(session, tenantMfaMaxAgeMs(policy, action))
  ) {
    const label = action === "keyImport" ? "import" : "export";
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Private key ${label} requires a recent MFA step-up session`,
      },
      403,
    );
  }
  return null;
}

function sessionTenantMatches(
  session: UserSessionPayload,
  tenantId: string,
): boolean {
  return typeof session.tenantId === "string" && session.tenantId === tenantId;
}

function sessionAppClientId(session: UserSessionPayload): string | null {
  const value = session.appClientId ?? session.clientId ?? session.client_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTenantAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

const TENANT_USER_DIRECTORY_READ_ROLES = [
  "owner",
  "admin",
  "developer",
  "viewer",
] as const;

function isTenantUserDirectoryReaderRole(
  role: string | null | undefined,
): boolean {
  return (TENANT_USER_DIRECTORY_READ_ROLES as readonly string[]).includes(
    role ?? "",
  );
}

async function activeTenantOwnerCount(
  tx: Pick<ReturnType<typeof getDb>, "select">,
  tenantId: string,
  excludeUserId?: string,
): Promise<number> {
  const conditions = [
    eq(userTenants.tenantId, tenantId),
    eq(userTenants.role, "owner"),
    isNull(users.deactivatedAt),
  ];
  if (excludeUserId) conditions.push(ne(userTenants.userId, excludeUserId));
  const [ownerCount] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(and(...conditions));
  return Number(ownerCount?.count ?? 0);
}

function tenantOwnerLifecycleLockKey(tenantId: string): string {
  return `tenant_owner_lifecycle_${tenantId}`;
}

async function lockTenantOwnerLifecycle(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${tenantOwnerLifecycleLockKey(tenantId)}, 0))`,
  );
}

function clampLimit(value: string | null, fallback = 50): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 100);
}

function parseBoundedOffset(value: string | null): number {
  const parsed = value ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.floor(parsed), 100_000);
}

function escapeLikePattern(value: string): string {
  // PostgreSQL LIKE uses backslash as its default escape character. Escape it
  // before '%' and '_' so a caller cannot turn our escaping back into a
  // wildcard by supplying a preceding backslash.
  return value.replace(/[\\%_]/g, "\\$&");
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function requireTenantAdmin(
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const db = getDb();
  const [membership] = await db
    .select({ role: userTenants.role })
    .from(userTenants)
    .where(
      and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
    );
  return isTenantAdminRole(membership?.role) ? membership.role : null;
}

async function requireTenantUserDirectoryReader(
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const db = getDb();
  const [membership] = await db
    .select({ role: userTenants.role })
    .from(userTenants)
    .where(
      and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
    );
  return isTenantUserDirectoryReaderRole(membership?.role)
    ? membership.role
    : null;
}

async function ensurePersonalTenant(
  userId: string,
  displayName: string,
): Promise<string> {
  const tenantId = `personal-${userId}`;
  const { hash } = generateApiKey();
  await getDb()
    .insert(tenants)
    .values({ id: tenantId, name: displayName, apiKeyHash: hash })
    .onConflictDoNothing();
  return tenantId;
}

function embeddedWalletCreateOnLoginFromFeatureFlags(
  featureFlags: unknown,
): EmbeddedWalletCreateOnLogin {
  if (!isPlainObject(featureFlags)) return "off";
  const embeddedWallets = featureFlags.embeddedWallets;
  if (
    isPlainObject(embeddedWallets) &&
    isEmbeddedWalletCreateOnLogin(embeddedWallets.createOnLogin)
  ) {
    return embeddedWallets.createOnLogin;
  }
  if (isEmbeddedWalletCreateOnLogin(featureFlags.embeddedWalletCreateOnLogin)) {
    return featureFlags.embeddedWalletCreateOnLogin;
  }
  return "off";
}

function embeddedWalletCreateOnLoginFromAppClient(
  embeddedWallets: unknown,
): EmbeddedWalletCreateOnLogin | undefined {
  if (!isPlainObject(embeddedWallets)) return undefined;
  return isEmbeddedWalletCreateOnLogin(embeddedWallets.createOnLogin)
    ? embeddedWallets.createOnLogin
    : undefined;
}

async function readEmbeddedWalletLoginConfigForTenant(
  userId: string,
  tenantId: string,
  clientId?: string,
): Promise<EmbeddedWalletLoginConfig> {
  if (!isValidTenantId(tenantId)) {
    return { tenantId: personalTenantId(userId), createOnLogin: "off" };
  }
  const db = getDb();
  const [membership] = await db
    .select({ role: userTenants.role })
    .from(userTenants)
    .where(
      and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
    );
  if (!membership) return { tenantId, createOnLogin: "off" };

  const [config] = await db
    .select({ featureFlags: tenantConfigs.featureFlags })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));
  const tenantCreateOnLogin = embeddedWalletCreateOnLoginFromFeatureFlags(
    config?.featureFlags,
  );
  const normalizedClientId = normalizePublicClientId(clientId);
  let resolvedClientId: string | undefined;
  if (normalizedClientId) {
    const [appClient] = await db
      .select({
        id: tenantAppClients.id,
        embeddedWallets: tenantAppClients.embeddedWallets,
      })
      .from(tenantAppClients)
      .where(
        and(
          eq(tenantAppClients.tenantId, tenantId),
          eq(tenantAppClients.id, normalizedClientId),
          eq(tenantAppClients.enabled, true),
        ),
      );
    resolvedClientId = appClient?.id;
    const appClientCreateOnLogin = embeddedWalletCreateOnLoginFromAppClient(
      appClient?.embeddedWallets,
    );
    if (appClientCreateOnLogin) {
      return {
        tenantId,
        clientId: resolvedClientId,
        createOnLogin: appClientCreateOnLogin,
      };
    }
  }
  return {
    tenantId,
    ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
    createOnLogin: tenantCreateOnLogin,
  };
}

function resolveEmbeddedWalletLoginClientId(
  c: Context<{ Variables: UserVariables }>,
  tenantId: string,
): string | undefined {
  const queryClientId =
    c.req.query("client_id") ??
    c.req.query("clientId") ??
    c.req.query("app_client_id") ??
    c.req.query("appClientId");
  const normalizedQueryClientId = normalizePublicClientId(queryClientId);
  if (normalizedQueryClientId) return normalizedQueryClientId;

  const headerClientId = normalizePublicClientId(
    c.req.header("X-Steward-App-Client-Id") ??
      c.req.header("X-Steward-Client-Id"),
  );
  if (headerClientId) return headerClientId;

  const appId = parseAppId(c.req.header("X-Steward-App-Id"));
  if (appId?.tenantId === tenantId) return appId.clientId;
  return undefined;
}

async function resolveEmbeddedWalletLoginConfig(
  c: Context<{ Variables: UserVariables }>,
  userId: string,
): Promise<EmbeddedWalletLoginConfig> {
  const session = c.get("userSession");
  const requestedTenantId =
    normalizedOptionalString(c.req.query("tenantId"), 64) ??
    normalizedOptionalString(c.req.header("X-Steward-Tenant"), 64) ??
    session.tenantId ??
    personalTenantId(userId);
  const requestedClientId = resolveEmbeddedWalletLoginClientId(
    c,
    requestedTenantId,
  );
  return readEmbeddedWalletLoginConfigForTenant(
    userId,
    requestedTenantId,
    requestedClientId,
  );
}

async function provisionEmbeddedUserWallet(
  vault: Vault,
  userId: string,
  displayName: string,
  eventTenantId?: string,
  walletIndex = 0,
): Promise<AgentIdentity> {
  const personalTenant = await ensurePersonalTenant(userId, displayName);
  await provisionUserWallet(vault, userId, displayName, undefined, walletIndex);
  const wallet = await getUserWallet(vault, userId, undefined, walletIndex);
  if (!wallet) throw new Error("Provision succeeded but agent not found");
  dispatchWebhook(personalTenant, wallet.id, "user.wallet_created", {
    userId,
    walletId: wallet.id,
    walletAddress: wallet.walletAddress,
    walletAddresses: wallet.walletAddresses,
    walletIndex,
    ...(eventTenantId && eventTenantId !== personalTenant
      ? { configuredTenantId: eventTenantId }
      : {}),
  });
  return wallet;
}

/** Build a Vault instance from environment. Same defaults as index.ts. */
function getVault(): Vault {
  return getConfiguredVault();
}

async function getTransactionStats(agentId: string) {
  const db = getDb();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const oneDayAgo = new Date(now.getTime() - 86_400_000);
  const oneWeekAgo = new Date(now.getTime() - 604_800_000);

  const oneHourAgoStr = oneHourAgo.toISOString();
  const oneDayAgoStr = oneDayAgo.toISOString();

  const [stats] = await db
    .select({
      recentTxCount1h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneHourAgoStr}::timestamptz)`,
      recentTxCount24h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz)`,
      spentToday: sql<string>`
        coalesce(
          sum(
            case
              when ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz then (${transactions.value})::numeric
              else 0
            end
          ),
          0
        )::text
      `,
      spentThisWeek: sql<string>`coalesce(sum((${transactions.value})::numeric), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        sql`${transactions.createdAt} >= ${oneWeekAgo.toISOString()}::timestamptz`,
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
      ),
    );

  return {
    recentTxCount1h: Number(stats?.recentTxCount1h ?? 0),
    recentTxCount24h: Number(stats?.recentTxCount24h ?? 0),
    spentToday: BigInt(stats?.spentToday ?? "0"),
    spentThisWeek: BigInt(stats?.spentThisWeek ?? "0"),
  };
}

async function getUserWalletTransactionStats(userId: string, chainId?: number) {
  const db = getDb();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const oneDayAgo = new Date(now.getTime() - 86_400_000);
  const oneWeekAgo = new Date(now.getTime() - 604_800_000);

  const oneHourAgoStr = oneHourAgo.toISOString();
  const oneDayAgoStr = oneDayAgo.toISOString();
  const baseAgentId = `user-wallet-${userId}`;
  const agentIds = [
    baseAgentId,
    ...Array.from({ length: 255 }, (_, index) => `${baseAgentId}-${index + 1}`),
  ];

  // Same cross-chain unit discipline as getTransactionStats (SEC-039): the
  // value column holds raw per-chain base units, so spend sums used for
  // policy enforcement must be scoped to the request's chain.
  const chainFilter =
    chainId === undefined
      ? sql``
      : sql` and ${transactions.chainId} = ${chainId}`;

  const [stats] = await db
    .select({
      recentTxCount1h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneHourAgoStr}::timestamptz)`,
      recentTxCount24h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz)`,
      spentToday: sql<string>`
        coalesce(
          sum(
            case
              when ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz${chainFilter} then (${transactions.value})::numeric
              else 0
            end
          ),
          0
        )::text
      `,
      spentThisWeek: sql<string>`coalesce(sum((${transactions.value})::numeric) filter (where true${chainFilter}), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.agentId, agentIds),
        sql`${transactions.createdAt} >= ${oneWeekAgo.toISOString()}::timestamptz`,
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
      ),
    );

  return {
    recentTxCount1h: Number(stats?.recentTxCount1h ?? 0),
    recentTxCount24h: Number(stats?.recentTxCount24h ?? 0),
    spentToday: BigInt(stats?.spentToday ?? "0"),
    spentThisWeek: BigInt(stats?.spentThisWeek ?? "0"),
  };
}

async function getMonthlySpend(agentId: string): Promise<string> {
  const [stats] = await getDb()
    .select({
      spentThisMonth: sql<string>`coalesce(sum((${transactions.value})::numeric), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        sql`${transactions.createdAt} >= ${new Date(Date.now() - 30 * 86400_000).toISOString()}::timestamptz`,
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
      ),
    );
  return stats?.spentThisMonth ?? "0";
}

function parseCustomTokenList(
  value: string | undefined,
): string[] | string | undefined {
  if (!value) return undefined;
  if (value.length > 2_500) return "tokens query is too long";
  const tokens = [
    ...new Set(
      value
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
  if (tokens.length > MAX_CUSTOM_TOKEN_BALANCES) {
    return `tokens cannot contain more than ${MAX_CUSTOM_TOKEN_BALANCES} addresses`;
  }
  for (const token of tokens) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(token))
      return "tokens must be comma-separated EVM addresses";
  }
  return tokens;
}

function parseOptionalChainId(
  value: string | undefined,
): number | string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) return "chainId must be a positive integer";
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    return "chainId must be a positive integer";
  return chainId;
}

function parseDecimalToScaled(
  value: string,
  scaleDecimals = USD_SCALE_DECIMALS,
): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const scaledFraction = fraction
    .slice(0, scaleDecimals)
    .padEnd(scaleDecimals, "0");
  return (
    BigInt(whole) * 10n ** BigInt(scaleDecimals) + BigInt(scaledFraction || "0")
  );
}

function formatScaledDecimal(
  value: bigint,
  scaleDecimals = USD_SCALE_DECIMALS,
): string {
  const whole = value / 10n ** BigInt(scaleDecimals);
  const fraction = value % 10n ** BigInt(scaleDecimals);
  const trimmedFraction = fraction
    .toString()
    .padStart(scaleDecimals, "0")
    .replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
}

function priceToScaledText(price: number | null): string | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  const scaled = parseDecimalToScaled(price.toFixed(USD_SCALE_DECIMALS));
  return scaled === null ? null : formatScaledDecimal(scaled);
}

function tokenAmountUsdText(
  balance: string,
  decimals: number,
  price: number | null,
): string | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  if (!/^\d+$/.test(balance) || !Number.isSafeInteger(decimals) || decimals < 0)
    return null;
  const scaledPrice = parseDecimalToScaled(price.toFixed(USD_SCALE_DECIMALS));
  if (scaledPrice === null) return null;
  const usdScaled = (BigInt(balance) * scaledPrice) / 10n ** BigInt(decimals);
  return formatScaledDecimal(usdScaled);
}

function sumUsdText(values: Array<string | null>): string | null {
  let total = 0n;
  let hasValue = false;
  for (const value of values) {
    if (value === null) continue;
    const scaled = parseDecimalToScaled(value);
    if (scaled === null) continue;
    total += scaled;
    hasValue = true;
  }
  return hasValue ? formatScaledDecimal(total) : null;
}

function sumNullableUsd(values: Array<number | null>): number | null {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

function userWalletRowsToAccountWallets(
  wallet: AgentIdentity,
  rows: Array<{
    id: string;
    chainFamily: ChainFamily;
    address: string;
    venue: string | null;
    purpose: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }>,
) {
  if (rows.length > 0) {
    return rows.map((row) => ({
      id: row.id,
      chainFamily: row.chainFamily,
      address: row.address,
      venue: row.venue,
      purpose: row.purpose,
      metadata: redactWalletMetadataSecrets(row.metadata),
      createdAt: row.createdAt,
    }));
  }

  return [
    {
      id: `${wallet.id}:evm`,
      chainFamily: "evm" as const,
      address: wallet.walletAddress,
      venue: null,
      purpose: "primary",
      metadata: {},
      createdAt: wallet.createdAt,
    },
  ];
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
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${agentId}, 0))`,
    );
    return fn();
  });
}

const USER_WALLET_SIGNER_AUTH_REQUIRED_ERROR =
  "User wallet signer credentials are required for this action";

function userWalletSignerPermissionForPath(path: string): string | null {
  if (path.endsWith("/me/wallet/sign")) return "sign_transaction";
  if (path.endsWith("/me/wallet/sign-message")) return "sign_message";
  return null;
}

function userWalletSignerHasPermission(
  permissions: readonly string[],
  required: string,
): boolean {
  const family = required.includes("_")
    ? `${required.split("_")[0]}:*`
    : `${required}:*`;
  return (
    permissions.includes("*") ||
    (required.startsWith("sign_") && permissions.includes("sign:*")) ||
    permissions.includes(required) ||
    permissions.includes(family)
  );
}

function userIdFromPersonalTenantId(tenantId: string): string | null {
  const prefix = "personal-";
  if (!tenantId.startsWith(prefix)) return null;
  const userId = tenantId.slice(prefix.length);
  return userId ? userId : null;
}

function getUserWalletSignerAuth(c: Context<{ Variables: UserVariables }>) {
  return c.get("authType") === "user-wallet-signer"
    ? c.get("userWalletSignerAuth")
    : undefined;
}

function userWalletSignerAuditMetadata(
  c: Context<{ Variables: UserVariables }>,
): Record<string, unknown> {
  const auth = getUserWalletSignerAuth(c);
  return auth
    ? { authMode: "user-wallet-signer", signerId: auth.signerId }
    : {};
}

function requireUserWalletSignerWalletScope(
  c: Context<{ Variables: UserVariables }>,
  walletAgentId: string,
): Response | null {
  const auth = getUserWalletSignerAuth(c);
  if (!auth) return null;
  if (auth.agentId === walletAgentId) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: "Signer credential is not authorized for the selected walletIndex",
    },
    403,
  );
}

async function authenticateUserWalletSigner(
  c: Context<{ Variables: UserVariables }>,
  next: Next,
): Promise<Response | undefined> {
  const requiredPermission = userWalletSignerPermissionForPath(
    new URL(c.req.url).pathname,
  );
  if (!requiredPermission) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization: Bearer <token> header is required" },
      401,
    );
  }

  const signerId = c.req.header("x-steward-signer-id")?.trim();
  const signerSecret = c.req.header("x-steward-signer-secret");
  if (!signerId || !signerSecret) {
    return c.json<ApiResponse>(
      { ok: false, error: USER_WALLET_SIGNER_AUTH_REQUIRED_ERROR },
      403,
    );
  }

  const [signer] = await getDb()
    .select()
    .from(agentSigners)
    .where(eq(agentSigners.id, signerId));
  const credentialHash =
    signer?.metadata && typeof signer.metadata.credentialHash === "string"
      ? signer.metadata.credentialHash
      : null;
  const userId = signer ? userIdFromPersonalTenantId(signer.tenantId) : null;
  if (
    !signer ||
    signer.status !== "active" ||
    !userId ||
    !credentialHash ||
    !(await verifySignerCredential(signerSecret, credentialHash)) ||
    !userWalletSignerHasPermission(signer.permissions, requiredPermission)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: USER_WALLET_SIGNER_AUTH_REQUIRED_ERROR },
      403,
    );
  }

  const now = new Date();
  await getDb()
    .update(agentSigners)
    .set({
      metadata: {
        ...signer.metadata,
        credentialLastUsedAt: now.toISOString(),
      },
      updatedAt: now,
    })
    .where(eq(agentSigners.id, signer.id));

  c.set("userId", userId);
  c.set("userSession", { userId, tenantId: signer.tenantId });
  c.set("authType", "user-wallet-signer");
  c.set("userWalletSignerAuth", {
    signerId: signer.id,
    tenantId: signer.tenantId,
    agentId: signer.agentId,
    requiredPermission,
  });

  await next();
  return undefined;
}

// ─── Session auth middleware ──────────────────────────────────────────────────

/**
 * Reads `Authorization: Bearer <jwt>`, verifies it with jose, and populates
 * `c.get("userId")` + `c.get("userSession")` for downstream handlers.
 *
 * The JWT is expected to contain `userId` from the auth identity layer. Legacy
 * address-only SIWE sessions are intentionally rejected here because user routes
 * operate on database users and tenant memberships, not raw wallet addresses.
 */
export async function userSessionAuth(
  c: Context<{ Variables: UserVariables }>,
  next: Next,
): Promise<Response | undefined> {
  if (c.get("userId") && c.get("userSession")) {
    await next();
    return undefined;
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    if (
      c.req.header("x-steward-signer-id") ||
      c.req.header("x-steward-signer-secret")
    ) {
      return authenticateUserWalletSigner(c, next);
    }
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization: Bearer <token> header is required" },
      401,
    );
  }

  const token = authHeader.slice(7);

  let payload: UserSessionPayload;
  try {
    const verified = await verifySessionToken(token);
    if (!verified) throw new Error("invalid session token");
    payload = verified as unknown as UserSessionPayload;
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired session token" },
      401,
    );
  }

  const userId = payload.userId as string | undefined;
  if (!userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Session token missing userId claim" },
      401,
    );
  }

  c.set("userId", userId);
  c.set("userSession", { ...payload, userId });
  c.set("authType", "session-jwt");
  if (typeof payload.mfaVerifiedAt === "number") {
    c.set("sessionMfaVerifiedAt", payload.mfaVerifiedAt);
  }
  if (typeof payload.mfaMethod === "string") {
    c.set("sessionMfaMethod", payload.mfaMethod);
  }

  if (!payload.tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Session token missing tenantId claim" },
      401,
    );
  }
  await continueWithTenantDatabase(
    payload.tenantId,
    "user-session-jwt",
    userId,
    next,
    userId,
  );
}

// ─── Route group ──────────────────────────────────────────────────────────────

const user = new Hono<{ Variables: UserVariables }>();
const allowPrivateKeyExport = (): boolean =>
  process.env.STEWARD_ALLOW_KEY_EXPORT !== "false" &&
  process.env.STEWARD_ALLOW_PRIVATE_KEY_EXPORT === "true";
const allowPrivateKeyImport = (): boolean =>
  process.env.STEWARD_ALLOW_PRIVATE_KEY_IMPORT === "true";
const allowUnsafeMessageSigning = (): boolean =>
  process.env.STEWARD_ALLOW_UNSAFE_MESSAGE_SIGNING === "true";
const allowUserPrivateKeyExport = (): boolean =>
  process.env.STEWARD_ALLOW_USER_PRIVATE_KEY_EXPORT === "true";
const allowUserPrivateKeyImport = (): boolean =>
  process.env.STEWARD_ALLOW_USER_PRIVATE_KEY_IMPORT === "true";
const allowUserUnsafeMessageSigning = (): boolean =>
  process.env.STEWARD_ALLOW_USER_UNSAFE_MESSAGE_SIGNING === "true";

// Apply session auth to all routes in this group
user.use("*", userSessionAuth);

function personalTenantId(userId: string): string {
  return `personal-${userId}`;
}

function requirePersonalUserSession(
  c: Context<{ Variables: UserVariables }>,
): Response | null {
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (session.tenantId === personalTenantId(userId)) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: "Personal user route requires a personal user session",
    },
    403,
  );
}

function hasCalldata(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim().toLowerCase() !== "0x"
  );
}

// Canonical non-negative uint256 decimal string (same semantics as intents.ts/vault.ts).
// Guards against negative/garbage wei flowing into BigInt(value) + spend SQL `(value)::numeric`,
// which could otherwise reduce spentToday and loosen the daily cap.
const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = 78;
function isUint256DecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT256_DECIMAL_DIGITS) return false;
  return (
    normalized.length < MAX_UINT256_DECIMAL_DIGITS ||
    normalized <= MAX_UINT256_DECIMAL
  );
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

function isValidAccountProvider(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.trim())
  );
}

function isValidProviderAccountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 255
  );
}

function normalizeEvmAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value;
  if (!isValidAddress(candidate)) return null;
  try {
    return getAddress(candidate);
  } catch {
    return null;
  }
}

function normalizeSolanaAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  try {
    return bs58.decode(candidate).length === 32 ? candidate : null;
  } catch {
    return null;
  }
}

type WalletLinkChain = "ethereum" | "solana";

function walletLinkChallengeKey(
  chain: WalletLinkChain,
  userId: string,
  nonce: string,
): string {
  return `wallet-link:${chain}:${userId}:${nonce}`;
}

function walletLinkRedeemLockKey(
  chain: WalletLinkChain,
  userId: string,
  nonce: string,
): string {
  return `wallet-link-lock:${chain}:${userId}:${nonce}`;
}

function walletLinkLabel(chain: WalletLinkChain): string {
  return chain === "ethereum" ? "Ethereum" : "Solana";
}

function buildWalletLinkMessage(input: {
  chain: WalletLinkChain;
  userId: string;
  nonce: string;
  issuedAt: string;
  account?: string;
}): string {
  const accountLabel = input.chain === "ethereum" ? "Address" : "Public Key";
  return [
    `Link this ${walletLinkLabel(input.chain)} wallet to your Steward account.`,
    "",
    `User ID: ${input.userId}`,
    ...(input.account ? [`${accountLabel}: ${input.account}`] : []),
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

function parseWalletLinkMessage(
  chain: WalletLinkChain,
  message: string,
): {
  userId: string;
  nonce: string;
  issuedAt: string;
  account?: string;
} | null {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (
    lines[0] !==
    `Link this ${walletLinkLabel(chain)} wallet to your Steward account.`
  )
    return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const match = line.match(/^([A-Za-z ]+):\s*(.+)$/);
    if (match) fields.set(match[1].toLowerCase().replace(/\s+/g, ""), match[2]);
  }
  const userId = fields.get("userid");
  const nonce = fields.get("nonce");
  const issuedAt = fields.get("issuedat");
  if (!userId || !nonce || !issuedAt) return null;
  const account = fields.get(chain === "ethereum" ? "address" : "publickey");
  return { userId, nonce, issuedAt, ...(account ? { account } : {}) };
}

async function evmWalletAlreadyBelongsToAnotherUser(
  address: string,
  userId: string,
): Promise<boolean> {
  const normalized = address.toLowerCase();
  const [primaryOwner] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        ne(users.id, userId),
        eq(users.walletChain, "ethereum"),
        sql`lower(${users.walletAddress}) = ${normalized}`,
      ),
    );
  if (primaryOwner) return true;

  const [linkedOwner] = await getDb()
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "wallet:ethereum"),
        eq(accounts.providerAccountId, normalized),
      ),
    );
  return Boolean(linkedOwner && linkedOwner.userId !== userId);
}

async function solanaWalletAlreadyBelongsToAnotherUser(
  publicKey: string,
  userId: string,
): Promise<boolean> {
  const [primaryOwner] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        ne(users.id, userId),
        eq(users.walletChain, "solana"),
        eq(users.walletAddress, publicKey),
      ),
    );
  if (primaryOwner) return true;

  const [linkedOwner] = await getDb()
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "wallet:solana"),
        eq(accounts.providerAccountId, publicKey),
      ),
    );
  return Boolean(linkedOwner && linkedOwner.userId !== userId);
}

async function getTenantWalletPolicyConfig(
  tenantId: string,
): Promise<TenantAuthAbuseConfig> {
  const [config] = await getDb()
    .select({ authAbuseConfig: tenantConfigs.authAbuseConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));
  return config?.authAbuseConfig ?? {};
}

async function userHasAnyLinkedThirdPartyWallet(
  userId: string,
): Promise<boolean> {
  const [linkedWallet] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        or(
          eq(accounts.provider, "wallet:ethereum"),
          eq(accounts.provider, "wallet:solana"),
        ),
      ),
    )
    .limit(1);
  return Boolean(linkedWallet);
}

async function enforceSingleThirdPartyWalletPolicy(
  c: Context<{ Variables: UserVariables }>,
  userId: string,
  tenantId: string,
): Promise<Response | null> {
  const config = await getTenantWalletPolicyConfig(tenantId);
  if (config.wallet?.restrictToOneThirdPartyWallet !== true) return null;
  if (!(await userHasAnyLinkedThirdPartyWallet(userId))) return null;
  return c.json<ApiResponse>(
    { ok: false, error: "User already has a linked wallet" },
    409,
  );
}

function verifySolanaWalletLinkSignature(
  message: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const publicKeyBytes = bs58.decode(publicKey);
    const signatureBytes = bs58.decode(signature);
    if (publicKeyBytes.length !== 32) return false;
    const keyObject = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: uint8ArrayToBase64url(publicKeyBytes),
      },
      format: "jwk",
    });
    return verifySignature(
      null,
      Buffer.from(message, "utf8"),
      keyObject,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

async function linkedAccountAlreadyBelongsToAnotherUser(
  provider: string,
  providerAccountId: string,
  userId: string,
): Promise<boolean> {
  const [linkedOwner] = await getDb()
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, provider),
        eq(accounts.providerAccountId, providerAccountId),
      ),
    );
  return Boolean(linkedOwner && linkedOwner.userId !== userId);
}

function phoneLinkPurpose(channel: "sms" | "whatsapp", userId: string): string {
  return `user-link:${channel}:${userId}`;
}

function phoneProviderAccountId(phone: string): string {
  return `phone:${hashSha256Hex(phone)}`;
}

function maskedPhone(phone: string): string {
  return `***${phone.slice(-4)}`;
}

async function phoneAlreadyBelongsToAnotherUser(
  provider: "phone" | "whatsapp",
  phone: string,
  userId: string,
): Promise<boolean> {
  const providerAccountId = phoneProviderAccountId(phone);
  const [primaryOwner] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      and(ne(users.id, userId), eq(users.walletAddress, providerAccountId)),
    );
  if (primaryOwner) return true;
  return linkedAccountAlreadyBelongsToAnotherUser(
    provider,
    providerAccountId,
    userId,
  );
}

function farcasterProviderAccountId(address: string): string {
  return `address:${address.toLowerCase()}`;
}

function userFarcasterAllowedDomains(): string[] | undefined {
  const raw = process.env.SIWE_ALLOWED_DOMAINS?.trim();
  if (!raw) return undefined;
  const domains = raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  return domains.length > 0 ? domains : undefined;
}

function socialLinkChallengeKey(
  provider: "telegram" | "farcaster",
  userId: string,
  nonce: string,
) {
  return `social-link:${provider}:${userId}:${nonce}`;
}

function oauthLinkChallengeKey(userId: string, state: string) {
  return `oauth-link:${userId}:${hashSha256Hex(state)}`;
}

function randomOAuthLinkState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function telegramLinkHashKey(hash: string): string {
  return `social-link:telegram-hash:${hashSha256Hex(hash.toLowerCase())}`;
}

async function consumeTelegramLinkHashOnce(
  hash: string,
  authDate: number,
): Promise<boolean> {
  const expiresAtMs = (authDate + TELEGRAM_LINK_MAX_AGE_SEC) * 1000;
  const ttlMs = Math.max(1_000, expiresAtMs - Date.now());
  return socialLinkChallenges.setIfNotExists(
    telegramLinkHashKey(hash),
    "1",
    ttlMs,
  );
}

type UserLinkedAccount = {
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
};

async function listUserLinkedAccounts(
  userId: string,
): Promise<UserLinkedAccount[]> {
  const db = getDb();
  const linkedAccounts = await db
    .select({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const passkeys = await db
    .select({
      id: authenticators.id,
      credentialId: authenticators.credentialId,
    })
    .from(authenticators)
    .where(eq(authenticators.userId, userId));
  const crossAppAccounts = await db
    .select({
      id: userWalletAppConsents.id,
      tenantId: userWalletAppConsents.tenantId,
      clientId: userWalletAppConsents.clientId,
      walletAddress: userWalletAppConsents.walletAddress,
      grantedAt: userWalletAppConsents.grantedAt,
      lastUsedAt: userWalletAppConsents.lastUsedAt,
      expiresAt: userWalletAppConsents.expiresAt,
      appName: tenantAppClients.name,
    })
    .from(userWalletAppConsents)
    .leftJoin(
      tenantAppClients,
      and(
        eq(tenantAppClients.tenantId, userWalletAppConsents.tenantId),
        eq(tenantAppClients.id, userWalletAppConsents.clientId),
      ),
    )
    .where(
      and(
        eq(userWalletAppConsents.userId, userId),
        eq(userWalletAppConsents.status, "active"),
        sql`(${userWalletAppConsents.expiresAt} is null or ${userWalletAppConsents.expiresAt} > now())`,
      ),
    );
  return [
    ...linkedAccounts,
    ...passkeys.map((passkey) => ({
      id: passkey.id,
      provider: "passkey",
      providerAccountId: passkey.credentialId,
      expiresAt: null,
    })),
    ...crossAppAccounts.map((account) => {
      const appId = `${account.tenantId}/${account.clientId}`;
      return {
        id: account.id,
        provider: "cross_app",
        providerAccountId: appId,
        expiresAt: account.expiresAt
          ? Math.floor(account.expiresAt.getTime() / 1000)
          : null,
        type: "cross_app",
        embeddedWallets: account.walletAddress
          ? [{ address: account.walletAddress }]
          : [],
        smartWallets: [],
        providerApp: {
          id: appId,
          name: account.appName,
          logoUrl: null,
        },
        firstVerifiedAt: account.grantedAt,
        latestVerifiedAt: account.lastUsedAt ?? account.grantedAt,
      } satisfies UserLinkedAccount;
    }),
  ];
}

function primaryLoginMethods(row: {
  email: string | null;
  walletAddress: string | null;
}): Array<{ provider: "email" | "wallet"; providerAccountId: string }> {
  const methods: Array<{
    provider: "email" | "wallet";
    providerAccountId: string;
  }> = [];
  if (row.email)
    methods.push({ provider: "email", providerAccountId: row.email });
  if (row.walletAddress) {
    methods.push({
      provider: "wallet",
      providerAccountId: row.walletAddress.toLowerCase(),
    });
  }
  return methods;
}

// ─── GET /me ─────────────────────────────────────────────────────────────────

user.get("/me", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  const userId = c.get("userId");

  // Check if the user already has a wallet provisioned
  let walletInfo: { address: string; agentId: string } | null = null;
  let walletAutoCreated = false;
  const embeddedWalletConfig = await resolveEmbeddedWalletLoginConfig(
    c,
    userId,
  );
  try {
    const vault = getVault();
    let wallet = await getUserWallet(vault, userId);
    if (!wallet && embeddedWalletConfig.createOnLogin !== "off") {
      const displayName = (session.address as string | undefined) ?? userId;
      const walletId = `user-wallet-${userId}`;
      await writeUserAudit(c, {
        tenantId: personalTenantId(userId),
        actorType: "user",
        actorId: userId,
        action: "user.wallet.create_on_login.authorized",
        resourceType: "wallet",
        resourceId: walletId,
        metadata: {
          configuredTenantId: embeddedWalletConfig.tenantId,
          configuredClientId: embeddedWalletConfig.clientId,
          createOnLogin: embeddedWalletConfig.createOnLogin,
        },
      });
      wallet = await provisionEmbeddedUserWallet(
        vault,
        userId,
        displayName,
        embeddedWalletConfig.tenantId,
      );
      walletAutoCreated = true;
      writeUserAudit(c, {
        tenantId: personalTenantId(userId),
        actorType: "user",
        actorId: userId,
        action: "user.wallet.create_on_login",
        resourceType: "wallet",
        resourceId: wallet.id,
        metadata: {
          configuredTenantId: embeddedWalletConfig.tenantId,
          configuredClientId: embeddedWalletConfig.clientId,
          createOnLogin: embeddedWalletConfig.createOnLogin,
        },
      }).catch((error) => {
        logger.error(
          {
            details: [
              "[user] Failed to audit create-on-login wallet success",
              redactedThrownDiagnostics(error),
            ],
          },
          "[Login:user] error",
        );
      });
    }
    if (wallet) {
      walletInfo = { address: wallet.walletAddress, agentId: wallet.id };
    }
  } catch {
    // Non-fatal — wallet may not be provisioned yet
  }

  return c.json<
    ApiResponse<{
      userId: string;
      address?: string;
      email?: string;
      wallet: { address: string; agentId: string } | null;
      walletAutoCreated: boolean;
      embeddedWalletConfig: EmbeddedWalletLoginConfig;
    }>
  >({
    ok: true,
    data: {
      userId,
      address: session.address as string | undefined,
      email: session.email as string | undefined,
      wallet: walletInfo,
      walletAutoCreated,
      embeddedWalletConfig,
    },
  });
});

// ─── Push Subscriptions ──────────────────────────────────────────────────────

function publicPushSubscription(
  row: typeof userPushSubscriptions.$inferSelect,
) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider: row.provider,
    token: row.token,
    platform: row.platform,
    deviceId: row.deviceId,
    appId: row.appId,
    locale: row.locale,
    timezone: row.timezone,
    metadata: row.metadata,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

user.get("/me/push-subscriptions", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const db = getDb();

  const rows = await db
    .select()
    .from(userPushSubscriptions)
    .where(
      and(
        eq(userPushSubscriptions.userId, userId),
        eq(userPushSubscriptions.status, "active"),
      ),
    )
    .orderBy(desc(userPushSubscriptions.lastSeenAt));

  return c.json<
    ApiResponse<{ subscriptions: ReturnType<typeof publicPushSubscription>[] }>
  >({
    ok: true,
    data: { subscriptions: rows.map(publicPushSubscription) },
  });
});

user.post("/me/push-subscriptions", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const body = await safeJsonParse<{
    provider?: unknown;
    token?: unknown;
    platform?: unknown;
    tenantId?: unknown;
    deviceId?: unknown;
    appId?: unknown;
    locale?: unknown;
    timezone?: unknown;
    metadata?: unknown;
  }>(c);
  if (!body || !isPushProvider(body.provider)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Push provider must be expo, apns, or fcm" },
      400,
    );
  }
  const token = normalizePushToken(body.token, body.provider);
  if (!token)
    return c.json<ApiResponse>({ ok: false, error: "Invalid push token" }, 400);
  const metadata = normalizePushMetadata(body.metadata);
  if (!metadata) {
    return c.json<ApiResponse>(
      { ok: false, error: "Push metadata must be a small object" },
      400,
    );
  }
  const platform =
    body.platform === undefined
      ? null
      : isPushPlatform(body.platform)
        ? body.platform
        : null;
  if (body.platform !== undefined && !platform) {
    return c.json<ApiResponse>(
      { ok: false, error: "Push platform must be ios or android" },
      400,
    );
  }
  const tenantId =
    body.tenantId === undefined || body.tenantId === null
      ? null
      : isValidTenantId(body.tenantId)
        ? body.tenantId
        : null;
  if (body.tenantId !== undefined && body.tenantId !== null && !tenantId) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenantId" }, 400);
  }

  const db = getDb();
  const [row] = await db
    .insert(userPushSubscriptions)
    .values({
      userId,
      tenantId,
      provider: body.provider,
      token,
      platform,
      deviceId: normalizedOptionalString(body.deviceId, 255),
      appId: normalizedOptionalString(body.appId, 255),
      locale: normalizedOptionalString(body.locale, 64),
      timezone: normalizedOptionalString(body.timezone, 128),
      metadata,
      status: "active",
      lastSeenAt: new Date(),
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [
        userPushSubscriptions.userId,
        userPushSubscriptions.provider,
        userPushSubscriptions.token,
      ],
      targetWhere: sql`${userPushSubscriptions.status} = 'active'`,
      set: {
        tenantId,
        platform,
        deviceId: normalizedOptionalString(body.deviceId, 255),
        appId: normalizedOptionalString(body.appId, 255),
        locale: normalizedOptionalString(body.locale, 64),
        timezone: normalizedOptionalString(body.timezone, 128),
        metadata,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  await writeAuditEvent({
    tenantId: tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.push_subscription.registered",
    resourceType: "user_push_subscription",
    resourceId: row.id,
    metadata: {
      provider: row.provider,
      platform: row.platform,
      appId: row.appId,
    },
  });

  return c.json<
    ApiResponse<{ subscription: ReturnType<typeof publicPushSubscription> }>
  >({
    ok: true,
    data: { subscription: publicPushSubscription(row) },
  });
});

user.delete("/me/push-subscriptions/:subscriptionId", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const subscriptionId = c.req.param("subscriptionId");
  const db = getDb();
  const revokedAt = new Date();

  const [row] = await db
    .update(userPushSubscriptions)
    .set({ status: "revoked", revokedAt, updatedAt: revokedAt })
    .where(
      and(
        eq(userPushSubscriptions.id, subscriptionId),
        eq(userPushSubscriptions.userId, userId),
        eq(userPushSubscriptions.status, "active"),
      ),
    )
    .returning();
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Push subscription not found" },
      404,
    );

  await writeAuditEvent({
    tenantId: row.tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.push_subscription.revoked",
    resourceType: "user_push_subscription",
    resourceId: row.id,
    metadata: {
      provider: row.provider,
      platform: row.platform,
      appId: row.appId,
    },
  });

  return c.json<
    ApiResponse<{ subscription: ReturnType<typeof publicPushSubscription> }>
  >({
    ok: true,
    data: { subscription: publicPushSubscription(row) },
  });
});

// ─── Linked Accounts ─────────────────────────────────────────────────────────

user.get("/me/accounts", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const db = getDb();
  const [userRow] = await db
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!userRow)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  const linkedAccounts = await listUserLinkedAccounts(userId);

  return c.json<
    ApiResponse<{
      accounts: UserLinkedAccount[];
      primaryLoginMethods: Array<{
        provider: "email" | "wallet";
        providerAccountId: string;
      }>;
    }>
  >({
    ok: true,
    data: {
      accounts: linkedAccounts,
      primaryLoginMethods: primaryLoginMethods(userRow),
    },
  });
});

user.post("/me/accounts/wallet/ethereum/nonce", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const body = await safeJsonParse<{ address?: unknown }>(c);
  const requestedAddress =
    body?.address === undefined || body.address === null || body.address === ""
      ? null
      : normalizeEvmAddress(body.address);
  if (body?.address !== undefined && !requestedAddress) {
    return c.json<ApiResponse>(
      { ok: false, error: "address must be an EVM address" },
      400,
    );
  }

  const userId = c.get("userId");
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const message = buildWalletLinkMessage({
    chain: "ethereum",
    userId,
    nonce,
    issuedAt,
    ...(requestedAddress ? { account: requestedAddress } : {}),
  });
  await walletLinkChallenges.setIfNotExists(
    walletLinkChallengeKey("ethereum", userId, nonce),
    JSON.stringify({ userId, address: requestedAddress, issuedAt }),
  );

  return c.json<
    ApiResponse<{
      nonce: string;
      message: string;
      expiresIn: number;
      address?: string;
    }>
  >({
    ok: true,
    data: {
      nonce,
      message,
      expiresIn: Math.floor(WALLET_LINK_CHALLENGE_TTL_MS / 1000),
      ...(requestedAddress ? { address: requestedAddress } : {}),
    },
  });
});

user.post("/me/accounts/wallet/ethereum", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Wallet linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    address?: unknown;
    message?: unknown;
    signature?: unknown;
  }>(c);
  const address = normalizeEvmAddress(body?.address);
  if (!address)
    return c.json<ApiResponse>(
      { ok: false, error: "address must be an EVM address" },
      400,
    );
  if (!isNonEmptyString(body?.message) || !isNonEmptyString(body?.signature)) {
    return c.json<ApiResponse>(
      { ok: false, error: "message and signature are required" },
      400,
    );
  }

  const parsed = parseWalletLinkMessage("ethereum", body.message);
  const userId = c.get("userId");
  if (!parsed || parsed.userId !== userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid wallet link message" },
      400,
    );
  }
  const parsedAddress = parsed.account
    ? normalizeEvmAddress(parsed.account)
    : null;
  if (parsedAddress && parsedAddress.toLowerCase() !== address.toLowerCase()) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet link message address mismatch" },
      400,
    );
  }

  const challengeKey = walletLinkChallengeKey("ethereum", userId, parsed.nonce);
  const rawChallenge = await walletLinkChallenges.get(challengeKey);
  if (!rawChallenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired wallet link nonce" },
      401,
    );
  }
  const challenge = JSON.parse(rawChallenge) as { address?: string | null };
  if (
    challenge.address &&
    challenge.address.toLowerCase() !== address.toLowerCase()
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet link nonce address mismatch" },
      401,
    );
  }

  const verified = await viemVerifyMessage({
    address: address as `0x${string}`,
    message: body.message,
    signature: body.signature as `0x${string}`,
  }).catch(() => false);
  if (!verified)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid wallet signature" },
      401,
    );

  const lockKey = walletLinkRedeemLockKey("ethereum", userId, parsed.nonce);
  if (
    !(await walletLinkChallenges.setIfNotExists(
      lockKey,
      "1",
      WALLET_LINK_REDEEM_LOCK_TTL_MS,
    ))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet link nonce is already being redeemed" },
      409,
    );
  }
  try {
    const consumed = await walletLinkChallenges.consume(challengeKey);
    if (!consumed || consumed !== rawChallenge) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired wallet link nonce" },
        401,
      );
    }
  } finally {
    await walletLinkChallenges.delete(lockKey);
  }

  const normalized = address.toLowerCase();
  const [userRow] = await getDb()
    .select({
      id: users.id,
      walletAddress: users.walletAddress,
      walletChain: users.walletChain,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!userRow)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  if (
    userRow.walletChain === "ethereum" &&
    userRow.walletAddress?.toLowerCase() === normalized
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet is already a primary login method" },
      409,
    );
  }
  if (await evmWalletAlreadyBelongsToAnotherUser(address, userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet is already linked to another user" },
      409,
    );
  }

  const [existing] = await getDb()
    .select({
      id: accounts.id,
      userId: accounts.userId,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "wallet:ethereum"),
        eq(accounts.providerAccountId, normalized),
      ),
    );
  if (existing) {
    if (existing.userId !== userId) {
      return c.json<ApiResponse>(
        { ok: false, error: "Wallet is already linked to another user" },
        409,
      );
    }
    const { userId: _ownerUserId, ...account } = existing;
    return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
      ok: true,
      data: { account, isNew: false },
    });
  }
  const singleWalletPolicyResponse = await enforceSingleThirdPartyWalletPolicy(
    c,
    userId,
    session.tenantId ?? personalTenantId(userId),
  );
  if (singleWalletPolicyResponse) return singleWalletPolicyResponse;

  const [account] = await getDb()
    .insert(accounts)
    .values({
      userId,
      provider: "wallet:ethereum",
      providerAccountId: normalized,
    })
    .returning({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    });
  await writeUserAudit(c, {
    tenantId: session.tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.account.link",
    resourceType: "user",
    resourceId: userId,
    metadata: { provider: "wallet:ethereum", providerAccountId: normalized },
  });
  dispatchWebhook(
    session.tenantId ?? personalTenantId(userId),
    userId,
    "user.linked_account",
    {
      userId,
      provider: "wallet:ethereum",
      providerAccountId: normalized,
      accountId: account.id,
    },
  );

  return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
    ok: true,
    data: { account, isNew: true },
  });
});

user.post("/me/accounts/wallet/solana/nonce", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const body = await safeJsonParse<{ publicKey?: unknown }>(c);
  const requestedPublicKey =
    body?.publicKey === undefined ||
    body.publicKey === null ||
    body.publicKey === ""
      ? null
      : normalizeSolanaAddress(body.publicKey);
  if (body?.publicKey !== undefined && !requestedPublicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "publicKey must be a Solana address" },
      400,
    );
  }

  const userId = c.get("userId");
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const message = buildWalletLinkMessage({
    chain: "solana",
    userId,
    nonce,
    issuedAt,
    ...(requestedPublicKey ? { account: requestedPublicKey } : {}),
  });
  await walletLinkChallenges.setIfNotExists(
    walletLinkChallengeKey("solana", userId, nonce),
    JSON.stringify({ userId, publicKey: requestedPublicKey, issuedAt }),
  );

  return c.json<
    ApiResponse<{
      nonce: string;
      message: string;
      expiresIn: number;
      publicKey?: string;
    }>
  >({
    ok: true,
    data: {
      nonce,
      message,
      expiresIn: Math.floor(WALLET_LINK_CHALLENGE_TTL_MS / 1000),
      ...(requestedPublicKey ? { publicKey: requestedPublicKey } : {}),
    },
  });
});

user.post("/me/accounts/wallet/solana", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Wallet linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    publicKey?: unknown;
    message?: unknown;
    signature?: unknown;
  }>(c);
  const publicKey = normalizeSolanaAddress(body?.publicKey);
  if (!publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "publicKey must be a Solana address" },
      400,
    );
  }
  if (!isNonEmptyString(body?.message) || !isNonEmptyString(body?.signature)) {
    return c.json<ApiResponse>(
      { ok: false, error: "message and signature are required" },
      400,
    );
  }

  const parsed = parseWalletLinkMessage("solana", body.message);
  const userId = c.get("userId");
  if (!parsed || parsed.userId !== userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid wallet link message" },
      400,
    );
  }
  const parsedPublicKey = parsed.account
    ? normalizeSolanaAddress(parsed.account)
    : null;
  if (parsedPublicKey && parsedPublicKey !== publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet link message public key mismatch" },
      400,
    );
  }

  const challengeKey = walletLinkChallengeKey("solana", userId, parsed.nonce);
  const rawChallenge = await walletLinkChallenges.get(challengeKey);
  if (!rawChallenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired wallet link nonce" },
      401,
    );
  }
  const challenge = JSON.parse(rawChallenge) as { publicKey?: string | null };
  if (challenge.publicKey && challenge.publicKey !== publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet link nonce public key mismatch" },
      401,
    );
  }

  if (
    !verifySolanaWalletLinkSignature(body.message, body.signature, publicKey)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid wallet signature" },
      401,
    );
  }

  const lockKey = walletLinkRedeemLockKey("solana", userId, parsed.nonce);
  if (
    !(await walletLinkChallenges.setIfNotExists(
      lockKey,
      "1",
      WALLET_LINK_REDEEM_LOCK_TTL_MS,
    ))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet link nonce is already being redeemed" },
      409,
    );
  }
  try {
    const consumed = await walletLinkChallenges.consume(challengeKey);
    if (!consumed || consumed !== rawChallenge) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired wallet link nonce" },
        401,
      );
    }
  } finally {
    await walletLinkChallenges.delete(lockKey);
  }

  const [userRow] = await getDb()
    .select({
      id: users.id,
      walletAddress: users.walletAddress,
      walletChain: users.walletChain,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!userRow)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  if (userRow.walletChain === "solana" && userRow.walletAddress === publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet is already a primary login method" },
      409,
    );
  }
  if (await solanaWalletAlreadyBelongsToAnotherUser(publicKey, userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet is already linked to another user" },
      409,
    );
  }

  const [existing] = await getDb()
    .select({
      id: accounts.id,
      userId: accounts.userId,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "wallet:solana"),
        eq(accounts.providerAccountId, publicKey),
      ),
    );
  if (existing) {
    if (existing.userId !== userId) {
      return c.json<ApiResponse>(
        { ok: false, error: "Wallet is already linked to another user" },
        409,
      );
    }
    const { userId: _ownerUserId, ...account } = existing;
    return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
      ok: true,
      data: { account, isNew: false },
    });
  }
  const singleWalletPolicyResponse = await enforceSingleThirdPartyWalletPolicy(
    c,
    userId,
    session.tenantId ?? personalTenantId(userId),
  );
  if (singleWalletPolicyResponse) return singleWalletPolicyResponse;

  const [account] = await getDb()
    .insert(accounts)
    .values({ userId, provider: "wallet:solana", providerAccountId: publicKey })
    .returning({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    });
  await writeUserAudit(c, {
    tenantId: session.tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.account.link",
    resourceType: "user",
    resourceId: userId,
    metadata: { provider: "wallet:solana", providerAccountId: publicKey },
  });
  dispatchWebhook(
    session.tenantId ?? personalTenantId(userId),
    userId,
    "user.linked_account",
    {
      userId,
      provider: "wallet:solana",
      providerAccountId: publicKey,
      accountId: account.id,
    },
  );

  return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
    ok: true,
    data: { account, isNew: true },
  });
});

user.post("/me/accounts/oauth/:provider/challenge", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "OAuth account linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  const providerName = c.req.param("provider");
  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Unknown provider: ${providerName}` },
      400,
    );
  }

  const body = await safeJsonParse<{
    redirectUri?: unknown;
    codeChallenge?: unknown;
    codeChallengeMethod?: unknown;
  }>(c);
  const redirectUri =
    typeof body?.redirectUri === "string" ? body.redirectUri.trim() : "";
  const codeChallenge =
    typeof body?.codeChallenge === "string"
      ? body.codeChallenge.trim()
      : undefined;
  const codeChallengeMethod =
    typeof body?.codeChallengeMethod === "string"
      ? body.codeChallengeMethod.trim()
      : undefined;
  if (!redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "redirectUri is required" },
      400,
    );
  }

  try {
    await assertAllowedOAuthRedirectUri(redirectUri, session.tenantId);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid redirectUri",
      },
      400,
    );
  }

  const userId = c.get("userId");
  const state = randomOAuthLinkState();
  await oauthLinkChallenges.setIfNotExists(
    oauthLinkChallengeKey(userId, state),
    JSON.stringify({
      userId,
      providerName,
      redirectUri,
      tenantId: session.tenantId ?? null,
      codeChallenge,
      codeChallengeMethod,
      issuedAt: new Date().toISOString(),
    }),
  );

  return c.json<
    ApiResponse<{
      state: string;
      redirectUri: string;
      expiresIn: number;
    }>
  >({
    ok: true,
    data: {
      state,
      redirectUri,
      expiresIn: Math.floor(OAUTH_LINK_CHALLENGE_TTL_MS / 1000),
    },
  });
});

user.post("/me/accounts/oauth/:provider/token", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "OAuth account linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  const providerName = c.req.param("provider");
  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Unknown provider: ${providerName}` },
      400,
    );
  }

  const body = await safeJsonParse<{
    code?: unknown;
    redirectUri?: unknown;
    state?: unknown;
    codeVerifier?: unknown;
  }>(c);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const redirectUri =
    typeof body?.redirectUri === "string" ? body.redirectUri.trim() : "";
  const state = typeof body?.state === "string" ? body.state.trim() : "";
  const codeVerifier =
    typeof body?.codeVerifier === "string" ? body.codeVerifier.trim() : "";
  if (!code || !redirectUri || !state) {
    return c.json<ApiResponse>(
      { ok: false, error: "code, redirectUri, and state are required" },
      400,
    );
  }

  const userId = c.get("userId");
  const challenge = await oauthLinkChallenges.consume(
    oauthLinkChallengeKey(userId, state),
  );
  if (!challenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired OAuth link state" },
      401,
    );
  }
  let challengePayload: {
    userId?: string;
    providerName?: string;
    redirectUri?: string;
    tenantId?: string | null;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  };
  try {
    challengePayload = JSON.parse(challenge);
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Malformed OAuth link state" },
      401,
    );
  }
  if (challengePayload.userId !== userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "OAuth link state user mismatch" },
      401,
    );
  }
  if (challengePayload.providerName !== providerName) {
    return c.json<ApiResponse>(
      { ok: false, error: "OAuth link state provider mismatch" },
      401,
    );
  }
  if (challengePayload.redirectUri !== redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "OAuth link state redirectUri mismatch" },
      401,
    );
  }
  if ((challengePayload.tenantId ?? null) !== (session.tenantId ?? null)) {
    return c.json<ApiResponse>(
      { ok: false, error: "OAuth link state tenant mismatch" },
      401,
    );
  }
  try {
    await assertAllowedOAuthRedirectUri(redirectUri, session.tenantId);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid redirectUri",
      },
      400,
    );
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(err) },
      503,
    );
  }

  let tokenResponse: Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
  try {
    tokenResponse = await oauthClient.exchangeCode(
      code,
      redirectUri,
      codeVerifier || undefined,
    );
  } catch (err) {
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(err) },
      502,
    );
  }

  let providerUser: Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
  try {
    providerUser = await oauthClient.getUserInfo(tokenResponse.access_token);
  } catch (err) {
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(err) },
      502,
    );
  }

  if (!providerUser.id) {
    return c.json<ApiResponse>(
      { ok: false, error: "Provider returned no account ID" },
      400,
    );
  }

  if (
    await linkedAccountAlreadyBelongsToAnotherUser(
      providerName,
      providerUser.id,
      userId,
    )
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "OAuth account is already linked to another user" },
      409,
    );
  }
  const encryptedProviderTokens = encryptOAuthProviderTokens(
    tokenResponse.access_token,
    tokenResponse.refresh_token ?? null,
  );
  const expiresAt = tokenResponse.expires_in
    ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
    : null;
  const db = getDb();
  const [inserted] = await db
    .insert(accounts)
    .values({
      userId,
      provider: providerName,
      providerAccountId: providerUser.id,
      ...encryptedProviderTokens,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [accounts.provider, accounts.providerAccountId],
    })
    .returning({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    });
  let account = inserted;
  const isNew = Boolean(inserted);
  if (!account) {
    const [current] = await db
      .select({
        id: accounts.id,
        userId: accounts.userId,
        provider: accounts.provider,
        providerAccountId: accounts.providerAccountId,
        expiresAt: accounts.expiresAt,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, providerName),
          eq(accounts.providerAccountId, providerUser.id),
        ),
      );
    if (!current || current.userId !== userId) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth account is already linked to another user" },
        409,
      );
    }
    const [updated] = await db
      .update(accounts)
      .set({ ...encryptedProviderTokens, expiresAt })
      .where(and(eq(accounts.id, current.id), eq(accounts.userId, userId)))
      .returning({
        id: accounts.id,
        provider: accounts.provider,
        providerAccountId: accounts.providerAccountId,
        expiresAt: accounts.expiresAt,
      });
    if (!updated) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth account ownership changed during link" },
        409,
      );
    }
    account = updated;
  }

  await writeUserAudit(c, {
    tenantId: session.tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.account.link",
    resourceType: "user",
    resourceId: userId,
    metadata: { provider: providerName, providerAccountId: providerUser.id },
  });
  dispatchWebhook(
    session.tenantId ?? personalTenantId(userId),
    userId,
    "user.linked_account",
    {
      userId,
      provider: providerName,
      providerAccountId: providerUser.id,
      accountId: account.id,
    },
  );

  return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
    ok: true,
    data: { account, isNew },
  });
});

for (const channel of ["sms", "whatsapp"] as const) {
  user.post(`/me/accounts/phone/${channel}/send`, async (c) => {
    const personalSessionResponse = requirePersonalUserSession(c);
    if (personalSessionResponse) return personalSessionResponse;
    if (channel === "whatsapp" && process.env.WHATSAPP_OTP_ENABLED !== "true") {
      return c.json<ApiResponse>(
        { ok: false, error: "WhatsApp OTP is not configured" },
        503,
      );
    }
    const session = c.get("userSession");
    if (!hasRecentMfaStepUp(session)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Phone account linking requires a recent MFA step-up session",
        },
        403,
      );
    }

    const body = await safeJsonParse<{ phone?: unknown }>(c);
    if (!isValidE164(body?.phone)) {
      return c.json<ApiResponse>(
        { ok: false, error: "phone must be E.164" },
        400,
      );
    }

    const userId = c.get("userId");
    let expiresAt: Date;
    try {
      ({ expiresAt } = await getPhoneAuth().sendOtp(
        body.phone,
        phoneLinkPurpose(channel, userId),
        channel,
      ));
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "SMS provider not configured"
      ) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error:
              channel === "whatsapp"
                ? "WhatsApp OTP provider not configured"
                : "SMS provider not configured",
          },
          503,
        );
      }
      throw err;
    }

    return c.json<ApiResponse<{ phone: string; expiresAt: string }>>({
      ok: true,
      data: {
        phone: maskedPhone(body.phone),
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  user.post(`/me/accounts/phone/${channel}/verify`, async (c) => {
    const personalSessionResponse = requirePersonalUserSession(c);
    if (personalSessionResponse) return personalSessionResponse;
    if (channel === "whatsapp" && process.env.WHATSAPP_OTP_ENABLED !== "true") {
      return c.json<ApiResponse>(
        { ok: false, error: "WhatsApp OTP is not configured" },
        503,
      );
    }
    const session = c.get("userSession");
    if (!hasRecentMfaStepUp(session)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Phone account linking requires a recent MFA step-up session",
        },
        403,
      );
    }

    const body = await safeJsonParse<{ phone?: unknown; code?: unknown }>(c);
    if (!isValidE164(body?.phone) || typeof body?.code !== "string") {
      return c.json<ApiResponse>(
        { ok: false, error: "phone and code are required" },
        400,
      );
    }
    if (!/^\d{6}$/.test(body.code)) {
      return c.json<ApiResponse>(
        { ok: false, error: "code must be 6 digits" },
        400,
      );
    }

    const userId = c.get("userId");
    const linkPurpose = phoneLinkPurpose(channel, userId);
    const attemptClaim = await claimSmsVerifyAttempt(body.phone, linkPurpose);
    if (!attemptClaim) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Too many invalid codes. Request a new code and try again later.",
        },
        429,
      );
    }

    let verified: Awaited<
      ReturnType<ReturnType<typeof getPhoneAuth>["verifyOtp"]>
    >;
    try {
      verified = await getPhoneAuth().verifyOtp(
        body.phone,
        body.code,
        linkPurpose,
      );
    } catch (error) {
      await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
      throw error;
    }
    if (!verified.valid) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired code" },
        401,
      );
    }
    await clearSmsVerifyFailures(body.phone, linkPurpose);

    const provider = channel === "whatsapp" ? "whatsapp" : "phone";
    const providerAccountId = phoneProviderAccountId(body.phone);
    const [userRow] = await getDb()
      .select({ id: users.id, walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, userId));
    if (!userRow)
      return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
    if (userRow.walletAddress === providerAccountId) {
      return c.json<ApiResponse>(
        { ok: false, error: "Phone is already a primary login method" },
        409,
      );
    }
    if (await phoneAlreadyBelongsToAnotherUser(provider, body.phone, userId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Phone is already linked to another user" },
        409,
      );
    }

    const [existing] = await getDb()
      .select({
        id: accounts.id,
        userId: accounts.userId,
        provider: accounts.provider,
        providerAccountId: accounts.providerAccountId,
        expiresAt: accounts.expiresAt,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.providerAccountId, providerAccountId),
        ),
      );
    if (existing) {
      if (existing.userId !== userId) {
        return c.json<ApiResponse>(
          { ok: false, error: "Phone is already linked to another user" },
          409,
        );
      }
      const { userId: _ownerUserId, ...account } = existing;
      return c.json<
        ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>
      >({
        ok: true,
        data: { account, isNew: false },
      });
    }

    const [account] = await getDb()
      .insert(accounts)
      .values({ userId, provider, providerAccountId })
      .returning({
        id: accounts.id,
        provider: accounts.provider,
        providerAccountId: accounts.providerAccountId,
        expiresAt: accounts.expiresAt,
      });
    await writeUserAudit(c, {
      tenantId: session.tenantId ?? personalTenantId(userId),
      actorType: "user",
      actorId: userId,
      action: "user.account.link",
      resourceType: "user",
      resourceId: userId,
      metadata: { provider, providerAccountId },
    });
    dispatchWebhook(
      session.tenantId ?? personalTenantId(userId),
      userId,
      "user.linked_account",
      {
        userId,
        provider,
        providerAccountId,
        accountId: account.id,
      },
    );

    return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
      ok: true,
      data: { account, isNew: true },
    });
  });
}

user.post("/me/accounts/telegram/challenge", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Telegram account linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login is not configured" },
      503,
    );
  }
  const userId = c.get("userId");
  const challengeId = crypto.randomUUID();
  await socialLinkChallenges.setIfNotExists(
    socialLinkChallengeKey("telegram", userId, challengeId),
    JSON.stringify({ userId, issuedAt: new Date().toISOString() }),
  );
  return c.json<ApiResponse<{ challengeId: string; expiresIn: number }>>({
    ok: true,
    data: {
      challengeId,
      expiresIn: Math.floor(SOCIAL_LINK_CHALLENGE_TTL_MS / 1000),
    },
  });
});

user.post("/me/accounts/telegram", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Telegram account linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login is not configured" },
      503,
    );
  }
  const body = await safeJsonParse<
    TelegramLoginPayload & { challengeId?: unknown }
  >(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const challengeId =
    typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  if (!challengeId) {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId is required" },
      400,
    );
  }
  const userId = c.get("userId");
  const challengeKey = socialLinkChallengeKey("telegram", userId, challengeId);
  const challenge = await socialLinkChallenges.consume(challengeKey);
  if (!challenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired Telegram challenge" },
      401,
    );
  }

  const { challengeId: _challengeId, ...telegramPayload } = body;
  let telegramUser: ReturnType<typeof verifyTelegramLogin>;
  try {
    telegramUser = verifyTelegramLogin(telegramPayload, botToken);
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid Telegram login",
      },
      401,
    );
  }

  const telegramHash =
    typeof body.hash === "string" ? body.hash : String(body.hash);
  if (
    !(await consumeTelegramLinkHashOnce(telegramHash, telegramUser.authDate))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login payload was already used" },
      401,
    );
  }
  if (
    await linkedAccountAlreadyBelongsToAnotherUser(
      "telegram",
      telegramUser.id,
      userId,
    )
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Telegram account is already linked to another user",
      },
      409,
    );
  }
  const [existing] = await getDb()
    .select({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "telegram"),
        eq(accounts.providerAccountId, telegramUser.id),
      ),
    );
  if (existing) {
    return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
      ok: true,
      data: { account: existing, isNew: false },
    });
  }

  const [account] = await getDb()
    .insert(accounts)
    .values({
      userId,
      provider: "telegram",
      providerAccountId: telegramUser.id,
    })
    .returning({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    });
  await writeUserAudit(c, {
    tenantId: session.tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.account.link",
    resourceType: "user",
    resourceId: userId,
    metadata: { provider: "telegram", providerAccountId: telegramUser.id },
  });
  dispatchWebhook(
    session.tenantId ?? personalTenantId(userId),
    userId,
    "user.linked_account",
    {
      userId,
      provider: "telegram",
      providerAccountId: telegramUser.id,
      accountId: account.id,
    },
  );

  return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
    ok: true,
    data: { account, isNew: true },
  });
});

user.post("/me/accounts/farcaster/nonce", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Farcaster account linking requires a recent MFA step-up session",
      },
      403,
    );
  }
  if (process.env.FARCASTER_LOGIN_ENABLED !== "true") {
    return c.json<ApiResponse>(
      { ok: false, error: "Farcaster login is not configured" },
      503,
    );
  }

  const userId = c.get("userId");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await socialLinkChallenges.setIfNotExists(
    socialLinkChallengeKey("farcaster", userId, nonce),
    JSON.stringify({ userId, issuedAt: new Date().toISOString() }),
  );
  return c.json<ApiResponse<{ nonce: string; expiresIn: number }>>({
    ok: true,
    data: { nonce, expiresIn: Math.floor(SOCIAL_LINK_CHALLENGE_TTL_MS / 1000) },
  });
});

user.post("/me/accounts/farcaster", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Farcaster account linking requires a recent MFA step-up session",
      },
      403,
    );
  }

  if (process.env.FARCASTER_LOGIN_ENABLED !== "true") {
    return c.json<ApiResponse>(
      { ok: false, error: "Farcaster login is not configured" },
      503,
    );
  }
  const body =
    await safeJsonParse<Parameters<typeof verifyFarcasterLogin>[0]>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  let farcasterUser: Awaited<ReturnType<typeof verifyFarcasterLogin>>;
  try {
    farcasterUser = await verifyFarcasterLogin(body, {
      expectedDomain: userFarcasterAllowedDomains(),
      maxMessageAgeMs: 10 * 60 * 1000,
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid Farcaster login",
      },
      401,
    );
  }

  const userId = c.get("userId");
  const nonceKey = socialLinkChallengeKey(
    "farcaster",
    userId,
    farcasterUser.message.nonce,
  );
  const nonceRecord = await socialLinkChallenges.consume(nonceKey);
  if (!nonceRecord) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired Farcaster nonce" },
      401,
    );
  }

  const providerAccountId = farcasterProviderAccountId(
    farcasterUser.custodyAddress,
  );
  if (
    await linkedAccountAlreadyBelongsToAnotherUser(
      "farcaster",
      providerAccountId,
      userId,
    )
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Farcaster account is already linked to another user",
      },
      409,
    );
  }
  const [existing] = await getDb()
    .select({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "farcaster"),
        eq(accounts.providerAccountId, providerAccountId),
      ),
    );
  if (existing) {
    return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
      ok: true,
      data: { account: existing, isNew: false },
    });
  }

  const [account] = await getDb()
    .insert(accounts)
    .values({ userId, provider: "farcaster", providerAccountId })
    .returning({
      id: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    });
  await writeUserAudit(c, {
    tenantId: session.tenantId ?? personalTenantId(userId),
    actorType: "user",
    actorId: userId,
    action: "user.account.link",
    resourceType: "user",
    resourceId: userId,
    metadata: { provider: "farcaster", providerAccountId },
  });
  dispatchWebhook(
    session.tenantId ?? personalTenantId(userId),
    userId,
    "user.linked_account",
    {
      userId,
      provider: "farcaster",
      providerAccountId,
      accountId: account.id,
    },
  );

  return c.json<ApiResponse<{ account: UserLinkedAccount; isNew: boolean }>>({
    ok: true,
    data: { account, isNew: true },
  });
});

user.delete("/me/accounts/:provider/:providerAccountId", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  const tenantId = session.tenantId ?? `personal-${userId}`;
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Account unlinking requires a recent MFA step-up session",
      },
      403,
    );
  }
  const provider = c.req.param("provider");
  const providerAccountId = c.req.param("providerAccountId");
  if (
    !isValidAccountProvider(provider) ||
    !isValidProviderAccountId(providerAccountId)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid account identifier" },
      400,
    );
  }

  const db = getDb();
  const [initialUserRow] = await db
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!initialUserRow)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  const initialUserAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const initialPasskeys = await db
    .select({
      id: authenticators.id,
      credentialId: authenticators.credentialId,
    })
    .from(authenticators)
    .where(eq(authenticators.userId, userId));
  const initialAccount = initialUserAccounts.find(
    (row) =>
      row.provider === provider && row.providerAccountId === providerAccountId,
  );
  const initialPasskey =
    provider === "passkey"
      ? initialPasskeys.find((row) => row.credentialId === providerAccountId)
      : undefined;
  const initialLinkedAccountId = initialAccount?.id ?? initialPasskey?.id;
  if (!initialLinkedAccountId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Linked account not found" },
      404,
    );
  }

  const initialLoginMethodCount =
    primaryLoginMethods(initialUserRow).length +
    initialUserAccounts.length +
    initialPasskeys.length;
  if (initialLoginMethodCount <= 1) {
    return c.json<ApiResponse>(
      { ok: false, error: "Cannot unlink the user's last login method" },
      409,
    );
  }

  const issuedBefore = Math.floor(Date.now() / 1000) + 1;
  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "user.account.unlink.authorized",
    resourceType: "user",
    resourceId: userId,
    metadata: {
      provider,
      providerAccountId,
      accountId: initialLinkedAccountId,
      issuedBefore,
    },
  });

  let mutation: UserAccountUnlinkMutation;
  try {
    mutation = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`user_session_${userId}`}, 0))`,
      );
      const [userRow] = await tx
        .select({
          id: users.id,
          email: users.email,
          walletAddress: users.walletAddress,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (!userRow) throw new Error("User not found");

      const userAccounts = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.userId, userId));
      const passkeys = await tx
        .select({
          id: authenticators.id,
          credentialId: authenticators.credentialId,
        })
        .from(authenticators)
        .where(eq(authenticators.userId, userId));
      const account = userAccounts.find(
        (row) =>
          row.provider === provider &&
          row.providerAccountId === providerAccountId,
      );
      const passkey =
        provider === "passkey"
          ? passkeys.find((row) => row.credentialId === providerAccountId)
          : undefined;
      if (!account && !passkey) throw new Error("Linked account not found");

      const loginMethodCount =
        primaryLoginMethods(userRow).length +
        userAccounts.length +
        passkeys.length;
      if (loginMethodCount <= 1) {
        throw new Error("Cannot unlink the user's last login method");
      }

      const refreshTokenSnapshot = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
      await revocationStore.revokeUserTokens(userId, issuedBefore);
      const [deleted] = account
        ? await tx
            .delete(accounts)
            .where(
              and(
                eq(accounts.id, account.id),
                eq(accounts.userId, userId),
                eq(accounts.provider, provider),
                eq(accounts.providerAccountId, providerAccountId),
              ),
            )
            .returning()
        : await tx
            .delete(authenticators)
            .where(
              and(
                eq(authenticators.id, requireLoginValue(passkey, "passkey").id),
                eq(authenticators.userId, userId),
                eq(authenticators.credentialId, providerAccountId),
              ),
            )
            .returning();
      if (!deleted) throw new Error("Linked account changed during unlink");
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      return {
        accountId: deleted.id,
        deletedAccount: account ? (deleted as UserAccountRow) : undefined,
        deletedPasskey: passkey ? (deleted as UserAuthenticatorRow) : undefined,
        deletedRefreshTokens: refreshTokenSnapshot,
      };
    });
  } catch (error) {
    if (error instanceof Error) {
      const status =
        error.message === "User not found"
          ? 404
          : error.message === "Linked account not found"
            ? 404
            : error.message === "Cannot unlink the user's last login method"
              ? 409
              : error.message === "Linked account changed during unlink"
                ? 409
                : 500;
      // SEC-210: known client-facing messages keep their detail; anything else
      // is an internal failure and must not leak internals to the client.
      return c.json<ApiResponse>(
        {
          ok: false,
          error: status === 500 ? sanitizeErrorMessage(error) : error.message,
        },
        status,
      );
    }
    throw error;
  }

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.account.unlink",
      resourceType: "user",
      resourceId: userId,
      metadata: {
        provider,
        providerAccountId,
        accountId: mutation.accountId,
        issuedBefore,
      },
    });
  } catch (error) {
    await restoreUserAccountUnlinkMutation(mutation);
    throw error;
  }
  dispatchWebhook(tenantId, userId, "user.unlinked_account", {
    userId,
    provider,
    providerAccountId,
    accountId: mutation.accountId,
  });

  return c.json<ApiResponse<{ deleted: boolean; issuedBefore: number }>>({
    ok: true,
    data: { deleted: true, issuedBefore },
  });
});

// ─── GET /me/account ─────────────────────────────────────────────────────────

user.get("/me/account", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const db = getDb();
  const [userRow] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      name: users.name,
      image: users.image,
      walletAddress: users.walletAddress,
      walletChain: users.walletChain,
      customMetadata: users.customMetadata,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!userRow)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  const chainId = parseOptionalChainId(c.req.query("chainId"));
  if (typeof chainId === "string")
    return c.json<ApiResponse>({ ok: false, error: chainId }, 400);
  const customTokens = parseCustomTokenList(c.req.query("tokens"));
  if (typeof customTokens === "string") {
    return c.json<ApiResponse>({ ok: false, error: customTokens }, 400);
  }

  const linkedAccounts = await listUserLinkedAccounts(userId);

  let vault: Vault | null = null;
  let vaultUnavailableReason: string | null = null;
  try {
    vault = getVault();
  } catch (error) {
    vaultUnavailableReason =
      error instanceof Error ? error.message : "Vault not configured";
  }

  const wallet = vault ? await getUserWallet(vault, userId) : null;
  const personalTenant = personalTenantId(userId);
  const noWalletSponsorship = publicGasSponsorshipState(
    await readTenantGasSponsorshipConfig(personalTenant),
  );

  if (!wallet || !vault) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        id: userId,
        type: "user",
        userId,
        tenantId: personalTenant,
        email: userRow.email,
        emailVerified: userRow.emailVerified,
        name: userRow.name,
        image: userRow.image,
        walletAddress: userRow.walletAddress,
        walletChain: userRow.walletChain,
        customMetadata: userRow.customMetadata,
        linkedAccounts,
        primaryLoginMethods: primaryLoginMethods(userRow),
        wallet: null,
        wallets: [],
        walletAddresses: {},
        balances: {
          evm: null,
          unavailableReason: vaultUnavailableReason ?? "No wallet found",
        },
        portfolio: {
          chainId: chainId ?? null,
          walletAddress: null,
          native: null,
          tokens: [],
          totalUsd: null,
          totalUsdText: null,
          unavailableReason: vaultUnavailableReason ?? "No wallet found",
        },
        spend: { todayWei: "0", weekWei: "0", monthWei: "0" },
        capabilities: [],
        sponsorship: {
          enabled: noWalletSponsorship.enabled,
          provider: noWalletSponsorship.provider,
          mode: noWalletSponsorship.mode,
          circuitBreakerEnabled: noWalletSponsorship.circuitBreakerEnabled,
        },
        createdAt: userRow.createdAt,
        updatedAt: userRow.updatedAt,
      },
    });
  }
  const activeVault = vault as Vault;

  const [
    walletRows,
    txStats,
    monthWei,
    balanceResult,
    tokenBalancesResult,
    gasSponsorshipConfig,
  ] = await Promise.all([
    db
      .select({
        id: agentWallets.id,
        chainFamily: agentWallets.chainFamily,
        address: agentWallets.address,
        venue: agentWallets.venue,
        purpose: agentWallets.purpose,
        metadata: agentWallets.metadata,
        createdAt: agentWallets.createdAt,
      })
      .from(agentWallets)
      .where(eq(agentWallets.agentId, wallet.id)),
    getTransactionStats(wallet.id),
    getMonthlySpend(wallet.id),
    activeVault
      .getBalance(personalTenant, wallet.id, chainId)
      .catch((error: unknown) => ({
        unavailable: true as const,
        reason: error instanceof Error ? error.message : "Balance unavailable",
      })),
    activeVault
      .getTokenBalances(personalTenant, wallet.id, chainId, customTokens)
      .catch((error) => ({
        unavailable: true as const,
        reason:
          error instanceof Error ? error.message : "Token balances unavailable",
      })),
    readTenantGasSponsorshipConfig(personalTenant),
  ]);
  const sponsorship = publicGasSponsorshipState(gasSponsorshipConfig);

  const wallets = userWalletRowsToAccountWallets(wallet, walletRows);
  const walletAddresses = wallets.reduce<Partial<Record<ChainFamily, string>>>(
    (acc, row) => {
      acc[row.chainFamily] = row.address;
      return acc;
    },
    {},
  );
  const portfolioChainId =
    "unavailable" in balanceResult ? (chainId ?? null) : balanceResult.chainId;
  const nativeAsset: UserPortfolioAsset | null =
    "unavailable" in balanceResult
      ? null
      : await (async () => {
          const balance = balanceResult.native.toString();
          const usdPrice = await priceOracle.getNativeUsdPrice(
            balanceResult.chainId,
          );
          const usdValue = await priceOracle.weiToUsd(
            balance,
            balanceResult.chainId,
          );
          return {
            token: "native",
            symbol: balanceResult.symbol,
            balance,
            formatted: balanceResult.nativeFormatted,
            decimals: 18,
            usdPrice,
            usdValue,
            usdPriceText: priceToScaledText(usdPrice),
            usdValueText: tokenAmountUsdText(balance, 18, usdPrice),
          };
        })();
  const tokenAssets: UserPortfolioAsset[] =
    "unavailable" in tokenBalancesResult
      ? []
      : await Promise.all(
          tokenBalancesResult.map(async (token) => {
            const usdPrice =
              portfolioChainId === null
                ? null
                : await priceOracle.getTokenUsdPrice(
                    portfolioChainId,
                    token.token,
                  );
            const usdValue =
              portfolioChainId === null
                ? null
                : await priceOracle.weiToUsd(
                    token.balance,
                    portfolioChainId,
                    token.token,
                  );
            return {
              token: token.token,
              symbol: token.symbol,
              balance: token.balance,
              formatted: token.formatted,
              decimals: token.decimals,
              usdPrice,
              usdValue,
              usdPriceText: priceToScaledText(usdPrice),
              usdValueText: tokenAmountUsdText(
                token.balance,
                token.decimals,
                usdPrice,
              ),
            };
          }),
        );
  const portfolioUnavailableReasons = [
    "unavailable" in balanceResult ? balanceResult.reason : null,
    "unavailable" in tokenBalancesResult ? tokenBalancesResult.reason : null,
  ].filter((reason): reason is string => Boolean(reason));

  return c.json<ApiResponse>({
    ok: true,
    data: {
      id: userId,
      type: "user",
      userId,
      tenantId: personalTenant,
      email: userRow.email,
      emailVerified: userRow.emailVerified,
      name: userRow.name,
      image: userRow.image,
      walletAddress: wallet.walletAddress,
      walletChain: userRow.walletChain,
      customMetadata: userRow.customMetadata,
      linkedAccounts,
      primaryLoginMethods: primaryLoginMethods(userRow),
      wallet: {
        id: wallet.id,
        agentId: wallet.id,
        walletAddress: wallet.walletAddress,
        walletAddresses,
        createdAt: wallet.createdAt,
      },
      wallets,
      walletAddresses,
      balances:
        "unavailable" in balanceResult
          ? { evm: null, unavailableReason: balanceResult.reason }
          : {
              evm: {
                native: balanceResult.native.toString(),
                nativeFormatted: balanceResult.nativeFormatted,
                chainId: balanceResult.chainId,
                symbol: balanceResult.symbol,
                walletAddress: balanceResult.walletAddress,
              },
            },
      portfolio: {
        chainId: portfolioChainId,
        walletAddress:
          "unavailable" in balanceResult
            ? wallet.walletAddress
            : balanceResult.walletAddress,
        native: nativeAsset,
        tokens: tokenAssets,
        totalUsd: sumNullableUsd([
          nativeAsset?.usdValue ?? null,
          ...tokenAssets.map((token) => token.usdValue),
        ]),
        totalUsdText: sumUsdText([
          nativeAsset?.usdValueText ?? null,
          ...tokenAssets.map((token) => token.usdValueText),
        ]),
        ...(portfolioUnavailableReasons.length > 0
          ? { unavailableReason: portfolioUnavailableReasons.join("; ") }
          : {}),
      },
      spend: {
        todayWei: txStats.spentToday.toString(),
        weekWei: txStats.spentThisWeek.toString(),
        monthWei,
      },
      capabilities: USER_ACCOUNT_CAPABILITIES,
      sponsorship: {
        enabled: sponsorship.enabled,
        provider: sponsorship.provider,
        mode: sponsorship.mode,
        circuitBreakerEnabled: sponsorship.circuitBreakerEnabled,
      },
      createdAt: userRow.createdAt,
      updatedAt: userRow.updatedAt,
    },
  });
});

user.get("/me/aggregation", (c) => {
  const query = new URL(c.req.url).search;
  return user.request(`/me/account${query}`, {
    method: "GET",
    headers: c.req.raw.headers,
  });
});

user.get("/me/accounts/aggregation", (c) => {
  const query = new URL(c.req.url).search;
  return user.request(`/me/account${query}`, {
    method: "GET",
    headers: c.req.raw.headers,
  });
});

// ─── GET /me/wallet ───────────────────────────────────────────────────────────

user.get("/me/wallet", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch (_e) {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const walletIndex = parseUserWalletIndexSelector(
    c.req.query("walletIndex"),
    c.req.query("wallet_index"),
  );
  if (!walletIndex.ok) {
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  const wallet: AgentIdentity | null = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet to provision",
      },
      404,
    );
  }

  const chainIdParam = c.req.query("chainId");
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : undefined;

  try {
    const balance = await vault.getBalance(
      `personal-${userId}`,
      wallet.id,
      chainId,
    );

    return c.json<ApiResponse<AgentBalance>>({
      ok: true,
      data: {
        agentId: wallet.id,
        walletAddress: wallet.walletAddress,
        walletIndex: walletIndex.value,
        balances: {
          native: balance.native.toString(),
          nativeFormatted: balance.nativeFormatted,
          chainId: balance.chainId,
          symbol: balance.symbol,
        },
      },
    });
  } catch (e) {
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── POST /me/wallet ──────────────────────────────────────────────────────────

user.post("/me/wallet", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch (_e) {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const parsedBody = await parseOptionalJsonBody<{
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  if (!parsedBody.ok) {
    return c.json<ApiResponse>({ ok: false, error: parsedBody.error }, 400);
  }
  const body = parsedBody.value ?? {};
  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex,
    body.wallet_index,
  );
  if (!walletIndex.ok) {
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let wallet: AgentIdentity | null = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    try {
      const session = c.get("userSession");
      const displayName = (session.address as string | undefined) ?? userId;
      wallet = await provisionEmbeddedUserWallet(
        vault,
        userId,
        displayName,
        undefined,
        walletIndex.value,
      );
    } catch (e) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Failed to provision wallet: ${sanitizeErrorMessage(e)}`,
        },
        500,
      );
    }
  }

  return c.json<
    ApiResponse<{ agentId: string; walletAddress: string; walletIndex: number }>
  >(
    {
      ok: true,
      data: {
        agentId: wallet.id,
        walletAddress: wallet.walletAddress,
        walletIndex: walletIndex.value,
      },
    },
    201,
  );
});

// ─── POST /me/wallet/claim-pregenerated ──────────────────────────────────────

user.post("/me/wallet/claim-pregenerated", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Pregenerated wallet claim requires a recent MFA step-up session",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    tenantId?: unknown;
    claimToken?: unknown;
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  const sourceTenantId = isValidTenantId(body?.tenantId) ? body.tenantId : null;
  const claimToken =
    typeof body?.claimToken === "string" ? body.claimToken.trim() : "";
  if (!sourceTenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId is required" },
      400,
    );
  }
  if (!claimToken || claimToken.length > 160) {
    return c.json<ApiResponse>(
      { ok: false, error: "claimToken is required" },
      400,
    );
  }
  const walletIndex = parseUserWalletIndexSelector(
    body?.walletIndex,
    body?.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.pregenerated_claim.rejected",
      error: walletIndex.error,
      walletIndex: body?.walletIndex,
      wallet_index: body?.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const existing = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (existing) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User already has an embedded wallet at the selected walletIndex",
      },
      409,
    );
  }

  const claimTokenHash = hashSha256Hex(claimToken);
  const platformIdPrefix = pregeneratedClaimPlatformIdPrefix(claimTokenHash);
  const db = getDb();
  const [claimable] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.tenantId, sourceTenantId),
        eq(agents.walletType, PREGENERATED_USER_WALLET_TYPE),
        or(
          eq(agents.platformId, platformIdPrefix),
          sql`${agents.platformId} like ${`${platformIdPrefix}:%`}`,
        ),
      ),
    );
  if (!claimable) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or already claimed wallet token" },
      404,
    );
  }
  const claimablePlatformId = claimable.platformId;
  const claimRecord = parsePregeneratedClaimPlatformId(
    claimablePlatformId,
    claimTokenHash,
  );
  if (!claimablePlatformId || !claimRecord) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or already claimed wallet token" },
      404,
    );
  }
  if (claimRecord.expiresAt && claimRecord.expiresAt.getTime() <= Date.now()) {
    await db
      .update(agents)
      .set({
        platformId: `${EXPIRED_PREGENERATED_CLAIM_PREFIX}${claimTokenHash}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, claimable.id),
          eq(agents.tenantId, sourceTenantId),
          eq(agents.walletType, PREGENERATED_USER_WALLET_TYPE),
          eq(agents.platformId, claimablePlatformId),
        ),
      );
    return c.json<ApiResponse>(
      { ok: false, error: "Wallet claim token expired" },
      410,
    );
  }

  const displayName =
    (session.address as string | undefined) ?? session.email ?? userId;
  const personalTenant = await ensurePersonalTenant(userId, displayName);
  const targetAgentId =
    walletIndex.value === 0
      ? `user-wallet-${userId}`
      : `user-wallet-${userId}-${walletIndex.value}`;

  try {
    await writeUserAudit(c, {
      tenantId: personalTenant,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.pregenerated_claim.authorized",
      resourceType: "wallet",
      resourceId: targetAgentId,
      metadata: {
        sourceTenantId,
        sourceAgentId: claimable.id,
        walletIndex: walletIndex.value,
      },
    });

    const [claimed] = await db
      .update(agents)
      .set({
        platformId: `${CLAIMED_PREGENERATED_CLAIM_PREFIX}${claimTokenHash}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, claimable.id),
          eq(agents.tenantId, sourceTenantId),
          eq(agents.walletType, PREGENERATED_USER_WALLET_TYPE),
          eq(agents.platformId, claimablePlatformId),
        ),
      )
      .returning({ id: agents.id });
    if (!claimed) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or already claimed wallet token" },
        409,
      );
    }

    try {
      const keys = await vault.exportPrivateKey(sourceTenantId, claimable.id, {
        breakGlass: true,
        actorId: userId,
        reason: "claim pregenerated user wallet",
      });
      if (!keys.evm?.privateKey) {
        throw new Error("Pregenerated wallet is missing an EVM key");
      }

      if (keys.solana?.privateKey) {
        await vault.importKey(
          personalTenant,
          targetAgentId,
          keys.solana.privateKey,
          "solana",
        );
      }
      await vault.importKey(
        personalTenant,
        targetAgentId,
        keys.evm.privateKey,
        "evm",
      );
      await db
        .update(agents)
        .set({
          name: `${displayName}'s Wallet`,
          platformId: `user:${userId}`,
          walletType: "claimed_user",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agents.id, targetAgentId),
            eq(agents.tenantId, personalTenant),
          ),
        );
      await applyUserWalletDefaults(userId, personalTenant);
      await db
        .delete(agents)
        .where(
          and(eq(agents.id, claimable.id), eq(agents.tenantId, sourceTenantId)),
        );
    } catch (claimError) {
      await db
        .update(agents)
        .set({ platformId: claimablePlatformId, updatedAt: new Date() })
        .where(
          and(
            eq(agents.id, claimable.id),
            eq(agents.tenantId, sourceTenantId),
            eq(
              agents.platformId,
              `${CLAIMED_PREGENERATED_CLAIM_PREFIX}${claimTokenHash}`,
            ),
          ),
        );
      throw claimError;
    }

    const wallet = await getUserWallet(
      vault,
      userId,
      undefined,
      walletIndex.value,
    );
    if (!wallet)
      throw new Error("Claim succeeded but wallet could not be fetched");

    await writeUserAudit(c, {
      tenantId: personalTenant,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.pregenerated_claim",
      resourceType: "wallet",
      resourceId: wallet.id,
      metadata: {
        sourceTenantId,
        sourceAgentId: claimable.id,
        walletIndex: walletIndex.value,
      },
    });
    dispatchWebhook(personalTenant, wallet.id, "user.wallet_created", {
      userId,
      walletId: wallet.id,
      walletAddress: wallet.walletAddress,
      walletIndex: walletIndex.value,
      pregenerated: true,
    });

    return c.json<
      ApiResponse<{
        agentId: string;
        walletAddress: string;
        walletIndex: number;
        claimed: true;
      }>
    >(
      {
        ok: true,
        data: {
          agentId: wallet.id,
          walletAddress: wallet.walletAddress,
          walletIndex: walletIndex.value,
          claimed: true,
        },
      },
      201,
    );
  } catch (e) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Failed to claim wallet: ${sanitizeErrorMessage(e)}`,
      },
      500,
    );
  }
});

// ─── POST /me/wallet/recovery/setup ──────────────────────────────────────────

user.post("/me/wallet/recovery/setup", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Wallet recovery setup requires a recent MFA step-up session",
      },
      403,
    );
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const parsedBody = await parseOptionalJsonBody<{
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  if (!parsedBody.ok) {
    return c.json<ApiResponse>({ ok: false, error: parsedBody.error }, 400);
  }
  const body = parsedBody.value ?? {};
  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex,
    body.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.recovery_setup.rejected",
      error: walletIndex.error,
      walletIndex: body.walletIndex,
      wallet_index: body.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  const existing = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (existing) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "This wallet already exists and cannot be assigned a new recovery phrase. Use audited key export for break-glass backup or create recovery during initial wallet provisioning.",
      },
      409,
    );
  }

  const displayName =
    (session.address as string | undefined) ?? session.email ?? userId;
  const mnemonic = generateMnemonic(256);

  try {
    const tenantId = await ensurePersonalTenant(userId, displayName);
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.recovery_setup.authorized",
      resourceType: "wallet",
      resourceId:
        walletIndex.value === 0
          ? `user-wallet-${userId}`
          : `user-wallet-${userId}-${walletIndex.value}`,
      metadata: {
        method: "bip39",
        strength: 256,
        walletIndex: walletIndex.value,
      },
    });

    const wallet = await provisionRecoverableUserWallet(
      vault,
      userId,
      displayName,
      mnemonic,
      tenantId,
      walletIndex.value,
    );

    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.recovery_setup",
      resourceType: "wallet",
      resourceId: wallet.agentId,
      metadata: {
        method: "bip39",
        strength: 256,
        walletIndex: wallet.walletIndex,
      },
    });
    dispatchWebhook(tenantId, wallet.agentId, "user.wallet_created", {
      userId,
      walletId: wallet.agentId,
      walletAddress: wallet.walletAddress,
      recoverable: true,
      walletIndex: wallet.walletIndex,
    });
    dispatchWebhook(tenantId, wallet.agentId, "wallet.recovery_setup", {
      userId,
      walletId: wallet.agentId,
      method: "bip39",
      walletIndex: wallet.walletIndex,
    });

    setNoStoreHeaders(c);
    return c.json<
      ApiResponse<{
        wallet: {
          agentId: string;
          walletAddress: string;
          recoverable: true;
          walletIndex: number;
        };
        recovery: { type: "bip39"; mnemonic: string; warning: string };
      }>
    >(
      {
        ok: true,
        data: {
          wallet: {
            agentId: wallet.agentId,
            walletAddress: wallet.walletAddress,
            recoverable: true,
            walletIndex: wallet.walletIndex,
          },
          recovery: {
            type: "bip39",
            mnemonic,
            warning:
              "This recovery phrase is shown once. Steward does not store it; losing it means the wallet cannot be recovered from this phrase.",
          },
        },
      },
      201,
    );
  } catch (e) {
    logger.error(
      {
        details: [
          `[UserWallet] recovery setup failed for user "${userId}"`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:user] error",
    );
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Failed to set up recovery: ${sanitizeErrorMessage(e)}`,
      },
      500,
    );
  }
});

// ─── POST /me/wallet/recovery/restore ────────────────────────────────────────

user.post("/me/wallet/recovery/restore", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Wallet recovery restore requires a recent MFA step-up session",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    mnemonic?: unknown;
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  const mnemonic =
    typeof body?.mnemonic === "string"
      ? body.mnemonic.trim().replace(/\s+/g, " ")
      : "";
  if (!mnemonic || !isValidMnemonic(mnemonic)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid BIP-39 recovery phrase" },
      400,
    );
  }
  const walletIndex = parseUserWalletIndexSelector(
    body?.walletIndex,
    body?.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.recovery_restore.rejected",
      error: walletIndex.error,
      walletIndex: body?.walletIndex,
      wallet_index: body?.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const displayName =
    (session.address as string | undefined) ?? session.email ?? userId;
  const tenantId = await ensurePersonalTenant(userId, displayName);

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.recovery_restore.authorized",
      resourceType: "wallet",
      resourceId:
        walletIndex.value === 0
          ? `user-wallet-${userId}`
          : `user-wallet-${userId}-${walletIndex.value}`,
      metadata: { method: "bip39", walletIndex: walletIndex.value },
    });

    const wallet = await restoreRecoverableUserWallet(
      vault,
      userId,
      displayName,
      mnemonic,
      tenantId,
      walletIndex.value,
    );

    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.recovered",
      resourceType: "wallet",
      resourceId: wallet.agentId,
      metadata: {
        method: "bip39",
        restoredExisting: wallet.restoredExisting,
        walletIndex: wallet.walletIndex,
      },
    });
    dispatchWebhook(tenantId, wallet.agentId, "wallet.recovered", {
      userId,
      walletId: wallet.agentId,
      walletAddress: wallet.walletAddress,
      method: "bip39",
      restoredExisting: wallet.restoredExisting,
      walletIndex: wallet.walletIndex,
    });
    if (!wallet.restoredExisting) {
      dispatchWebhook(tenantId, wallet.agentId, "user.wallet_created", {
        userId,
        walletId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        recoverable: true,
        walletIndex: wallet.walletIndex,
      });
    }

    return c.json<
      ApiResponse<{
        wallet: {
          agentId: string;
          walletAddress: string;
          recoverable: true;
          restoredExisting: boolean;
          walletIndex: number;
        };
        recovery: { type: "bip39"; restored: true };
      }>
    >(
      {
        ok: true,
        data: {
          wallet: {
            agentId: wallet.agentId,
            walletAddress: wallet.walletAddress,
            recoverable: true,
            restoredExisting: wallet.restoredExisting,
            walletIndex: wallet.walletIndex,
          },
          recovery: { type: "bip39", restored: true },
        },
      },
      wallet.restoredExisting ? 200 : 201,
    );
  } catch (e) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Failed to restore wallet: ${sanitizeErrorMessage(e)}`,
      },
      409,
    );
  }
});

// ─── User wallet additional signers ───────────────────────────────────────────

user.get("/me/wallet/signers", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet signer inventory requires a recent MFA step-up session",
      },
      403,
    );
  }

  const status = c.req.query("status");
  if (status && !USER_WALLET_SIGNER_STATUSES.has(status)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid signer status filter" },
      400,
    );
  }
  const walletIndex = parseUserWalletIndexSelector(
    c.req.query("walletIndex"),
    c.req.query("wallet_index"),
  );
  if (!walletIndex.ok) {
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet first to provision",
      },
      404,
    );
  }

  const tenantId = personalTenantId(userId);
  const conditions = [
    eq(agentSigners.tenantId, tenantId),
    eq(agentSigners.agentId, wallet.id),
  ];
  if (status) conditions.push(eq(agentSigners.status, status));
  const rows = await getDb()
    .select()
    .from(agentSigners)
    .where(and(...conditions))
    .orderBy(agentSigners.createdAt);

  return c.json<
    ApiResponse<{ signers: ReturnType<typeof toUserWalletSignerResponse>[] }>
  >({
    ok: true,
    data: { signers: rows.map(toUserWalletSignerResponse) },
  });
});

user.post("/me/wallet/signers", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet signer creation requires a recent MFA step-up session",
      },
      403,
    );
  }

  const body = await safeJsonParse<Record<string, unknown>>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (
    body.credentialSecret !== undefined &&
    body.credentialSecret !== null &&
    body.credentialSecret !== ""
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "credentialSecret is server-generated for user wallet signers",
      },
      400,
    );
  }
  if (body.policyIds !== undefined) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "policyIds are not supported on user wallet signers",
      },
      400,
    );
  }
  if (body.signerType !== undefined && body.signerType !== "delegated") {
    return c.json<ApiResponse>(
      { ok: false, error: "user wallet signers must use signerType delegated" },
      400,
    );
  }
  if (body.keyType !== undefined && body.keyType !== "hmac") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "user wallet signer credentials currently support keyType hmac only",
      },
      400,
    );
  }
  if (
    body.publicKey !== undefined &&
    body.publicKey !== null &&
    body.publicKey !== ""
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "publicKey is not supported for user wallet signer credentials",
      },
      400,
    );
  }

  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex,
    body.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.signer.create.rejected",
      error: walletIndex.error,
      walletIndex: body.walletIndex,
      wallet_index: body.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet first to provision",
      },
      404,
    );
  }

  let subjectType: string;
  let subjectId: string;
  let address: string | null;
  let chainFamily: "evm" | "solana" | null;
  let label: string | null;
  let permissions: string[];
  let metadata: Record<string, unknown>;
  try {
    subjectType = normalizeUserWalletSignerSubjectType(body.subjectType);
    subjectId = normalizeUserWalletSignerSubjectId(body.subjectId);
    address = normalizeOptionalText(body.address, "address", 128);
    if (
      address &&
      !/^0x[a-fA-F0-9]{40}$/.test(address) &&
      !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(address)
    ) {
      throw new Error("address must be an EVM or Solana address");
    }
    chainFamily =
      body.chainFamily === undefined || body.chainFamily === null
        ? null
        : body.chainFamily === "evm" || body.chainFamily === "solana"
          ? body.chainFamily
          : (() => {
              throw new Error("chainFamily must be evm or solana");
            })();
    label = normalizeOptionalText(body.label, "label", 255);
    permissions = normalizeUserWalletSignerPermissions(body.permissions);
    metadata = normalizeUserWalletSignerMetadata(body.metadata);
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid signer payload",
      },
      400,
    );
  }

  const tenantId = personalTenantId(userId);
  const [existingSigner] = await getDb()
    .select({ id: agentSigners.id })
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, wallet.id),
        eq(agentSigners.subjectType, subjectType),
        eq(agentSigners.subjectId, subjectId),
      ),
    );
  if (existingSigner) {
    return c.json<ApiResponse>(
      { ok: false, error: "Signer already exists for this wallet and subject" },
      409,
    );
  }

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "user.wallet.signer.create.authorized",
    resourceType: "wallet",
    resourceId: wallet.id,
    metadata: {
      subjectType,
      subjectId,
      permissions,
      walletIndex: walletIndex.value,
    },
  });

  const credentialSecret = createUserWalletSignerSecret();
  try {
    const [row] = await getDb()
      .insert(agentSigners)
      .values({
        tenantId,
        agentId: wallet.id,
        signerType: "delegated",
        subjectType,
        subjectId,
        keyType: "hmac",
        publicKey: null,
        address,
        chainFamily,
        label,
        permissions,
        policyIds: [],
        metadata: {
          ...metadata,
          credentialHash: await createSignerCredentialHash(credentialSecret),
          credentialCreatedAt: new Date().toISOString(),
        },
        status: "active",
        createdBy: userId,
      })
      .returning();

    try {
      await writeUserAudit(c, {
        tenantId,
        actorType: "user",
        actorId: userId,
        action: "user.wallet.signer.create",
        resourceType: "agent_signer",
        resourceId: row.id,
        metadata: {
          agentId: wallet.id,
          subjectType,
          subjectId,
          walletIndex: walletIndex.value,
        },
      });
    } catch (error) {
      await getDb().delete(agentSigners).where(eq(agentSigners.id, row.id));
      throw error;
    }

    return c.json<
      ApiResponse<
        ReturnType<typeof toUserWalletSignerResponse> & {
          credentialSecret: string;
        }
      >
    >(
      {
        ok: true,
        data: { ...toUserWalletSignerResponse(row), credentialSecret },
      },
      201,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    const duplicateSigner =
      message.includes("agent_signers_agent_subject_idx") ||
      message.toLowerCase().includes("duplicate key") ||
      message.toLowerCase().includes("unique constraint");
    return c.json<ApiResponse>(
      {
        ok: false,
        error: duplicateSigner
          ? "Signer already exists for this wallet and subject"
          : message,
      },
      duplicateSigner ? 409 : 500,
    );
  }
});

user.delete("/me/wallet/signers/:signerId", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet signer revocation requires a recent MFA step-up session",
      },
      403,
    );
  }

  const parsedBody = await parseOptionalJsonBody<{
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  if (!parsedBody.ok) {
    return c.json<ApiResponse>({ ok: false, error: parsedBody.error }, 400);
  }
  const body = parsedBody.value ?? {};
  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex ?? c.req.query("walletIndex"),
    body.wallet_index ?? c.req.query("wallet_index"),
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.signer.revoke.rejected",
      error: walletIndex.error,
      walletIndex: body.walletIndex ?? c.req.query("walletIndex"),
      wallet_index: body.wallet_index ?? c.req.query("wallet_index"),
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet first to provision",
      },
      404,
    );
  }

  const tenantId = personalTenantId(userId);
  const signerId = c.req.param("signerId");
  const [existingSigner] = await getDb()
    .select()
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, wallet.id),
      ),
    );
  if (!existingSigner) {
    return c.json<ApiResponse>({ ok: false, error: "Signer not found" }, 404);
  }

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "user.wallet.signer.revoke.authorized",
    resourceType: "agent_signer",
    resourceId: signerId,
    metadata: { agentId: wallet.id, walletIndex: walletIndex.value },
  });

  const [row] = await getDb()
    .update(agentSigners)
    .set({ status: "revoked" })
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, wallet.id),
      ),
    )
    .returning();

  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "Signer not found" }, 404);

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "user.wallet.signer.revoke",
    resourceType: "agent_signer",
    resourceId: row.id,
    metadata: { agentId: wallet.id, walletIndex: walletIndex.value },
  });

  return c.json<ApiResponse<ReturnType<typeof toUserWalletSignerResponse>>>({
    ok: true,
    data: toUserWalletSignerResponse(row),
  });
});

// ─── POST /me/wallet/sign ─────────────────────────────────────────────────────

user.post("/me/wallet/sign", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  const signerAuth = getUserWalletSignerAuth(c);
  if (!signerAuth && !hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Wallet transaction signing requires a recent MFA step-up session",
      },
      403,
    );
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const body = await safeJsonParse<
    Omit<SignRequest, "agentId" | "tenantId"> & {
      walletIndex?: unknown;
      wallet_index?: unknown;
    }
  >(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex,
    body.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.sign.rejected",
      error: walletIndex.error,
      walletIndex: body.walletIndex,
      wallet_index: body.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet first to provision",
      },
      404,
    );
  }
  const signerScopeResponse = requireUserWalletSignerWalletScope(c, wallet.id);
  if (signerScopeResponse) return signerScopeResponse;
  const {
    walletIndex: _walletIndex,
    wallet_index: _wallet_index,
    ...signBody
  } = body;
  const shouldBroadcast = body.broadcast !== false;
  if (shouldBroadcast && !isNonEmptyString(c.req.header("Idempotency-Key"))) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Broadcast signing requires an Idempotency-Key header",
      },
      400,
    );
  }

  if (!isNonEmptyString(signBody.to)) {
    return c.json<ApiResponse>(
      { ok: false, error: "'to' address is required" },
      400,
    );
  }
  if (!isValidAddress(signBody.to)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "'to' must be a valid Ethereum address (0x + 40 hex chars)",
      },
      400,
    );
  }
  if (signBody.value === undefined || signBody.value === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' is required (wei amount as string)" },
      400,
    );
  }
  if (!isUint256DecimalString(signBody.value)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "'value' must be a non-negative uint256 wei amount encoded as a decimal string",
      },
      400,
    );
  }
  if (signBody.chainId !== undefined) {
    if (
      typeof signBody.chainId !== "number" ||
      !Number.isSafeInteger(signBody.chainId) ||
      signBody.chainId <= 0
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "'chainId' must be a positive integer when provided",
        },
        400,
      );
    }
  }
  if (hasCalldata((signBody as { data?: unknown }).data)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet contract calldata is disabled unless a selector-specific policy is configured",
      },
      403,
    );
  }
  if ((signBody as { gasLimit?: unknown }).gasLimit !== undefined) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet native transfers cannot set gasLimit because gas spend is not policy-accounted",
      },
      403,
    );
  }

  const tenantId = `personal-${userId}`;
  const agentId = wallet.id;
  const chainId =
    signBody.chainId ?? parseInt(process.env.CHAIN_ID || "84532", 10);
  let codeResponse: Awaited<ReturnType<Vault["rpcPassthrough"]>>;
  try {
    codeResponse = await vault.rpcPassthrough({
      method: "eth_getCode",
      params: [getAddress(signBody.to), "latest"],
      chainId,
    });
  } catch {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet native transfers cannot be signed until recipient contract code is verified",
      },
      502,
    );
  }
  if (codeResponse.error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "User wallet native transfers cannot be signed until recipient contract code is verified",
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
          "User wallet native transfers to contract recipients are disabled because gas spend is not policy-accounted",
      },
      403,
    );
  }
  // Build the SignRequest from declared fields only. Extra body fields must not
  // reach the policy engine or shadow the destination that the vault signs.
  const signRequest: SignRequest = {
    tenantId,
    agentId,
    to: signBody.to,
    value: signBody.value,
    data: typeof signBody.data === "string" ? signBody.data : undefined,
    chainId,
    broadcast: shouldBroadcast,
  };

  // Fetch active policies
  const db = getDb();
  const storedPolicies = await db
    .select()
    .from(policies)
    .where(eq(policies.agentId, agentId));

  const policySet: PolicyRule[] =
    storedPolicies.length > 0
      ? storedPolicies.map(toPolicyRule)
      : USER_WALLET_DEFAULT_POLICIES;

  let completedResult: { txId: string; txHash: string } | undefined;

  try {
    const result: UserWalletSignResult = await withAgentSpendLock(
      `user-wallet-${userId}`,
      async () => {
        const stats = await getUserWalletTransactionStats(userId, chainId);
        const engine = new PolicyEngine();
        const evaluation = await engine.evaluate(policySet, {
          request: signRequest,
          recentTxCount1h: stats.recentTxCount1h,
          recentTxCount24h: stats.recentTxCount24h,
          spentToday: stats.spentToday,
          spentThisWeek: stats.spentThisWeek,
        });

        if (!evaluation.approved) {
          const txId = crypto.randomUUID();
          await writeUserAudit(c, {
            tenantId,
            actorType: "user",
            actorId: userId,
            action: "user.wallet.sign.rejected_by_policy",
            resourceType: "wallet_transaction",
            resourceId: txId,
            metadata: {
              agentId,
              to: signRequest.to,
              value: signRequest.value,
              chainId: signRequest.chainId,
              walletIndex: walletIndex.value,
              ...userWalletSignerAuditMetadata(c),
              policyResults: evaluation.results,
            },
          });
          return { approved: false, results: evaluation.results };
        }

        const txId = crypto.randomUUID();
        await writeUserAudit(c, {
          tenantId,
          actorType: "user",
          actorId: userId,
          action: "user.wallet.sign.authorized",
          resourceType: "wallet_transaction",
          resourceId: txId,
          metadata: {
            agentId,
            to: signRequest.to,
            value: signRequest.value,
            chainId: signRequest.chainId,
            walletIndex: walletIndex.value,
            ...userWalletSignerAuditMetadata(c),
          },
        });
        const txHash = await vault.signTransaction(signRequest, {
          txId,
          policyResults: evaluation.results,
          status: shouldBroadcast ? "broadcast" : "signed",
        });
        completedResult = { txId, txHash };
        await writeUserAudit(c, {
          tenantId,
          actorType: "user",
          actorId: userId,
          action: "user.wallet.sign",
          resourceType: "wallet_transaction",
          resourceId: txId,
          metadata: {
            agentId,
            to: signRequest.to,
            value: signRequest.value,
            chainId: signRequest.chainId,
            txHash,
            walletIndex: walletIndex.value,
            ...userWalletSignerAuditMetadata(c),
          },
        });
        return { approved: true, txId, txHash };
      },
    );

    if (!result.approved) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction rejected by policy",
          data: { results: result.results },
        },
        403,
      );
    }

    return c.json<ApiResponse<{ txId: string; txHash: string }>>({
      ok: true,
      data: { txId: result.txId, txHash: result.txHash },
    });
  } catch (e) {
    if (completedResult) {
      logger.error(
        {
          details: [
            `[UserWallet] Post-sign bookkeeping failed for user "${userId}" after transaction "${completedResult.txId}" completed`,
            redactedThrownDiagnostics(e),
          ],
        },
        "[Login:user] error",
      );
      return c.json<ApiResponse<{ txId: string; txHash: string }>>({
        ok: true,
        data: completedResult,
      });
    }
    logger.error(
      {
        details: [
          `[UserWallet] Sign failed for user "${userId}"`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:user] error",
    );
    try {
      await writeUserAudit(c, {
        tenantId: `personal-${userId}`,
        actorType: "user",
        actorId: userId,
        action: "user.wallet.sign.failed",
        resourceType: "wallet",
        resourceId: wallet.id,
        metadata: {
          ...redactedThrownDiagnostics(e),
          walletIndex: walletIndex.value,
        },
      });
    } catch (auditErr) {
      logger.error(
        {
          details: [
            `[UserWallet] Failed to audit signing failure for user "${userId}"`,
            redactedThrownDiagnostics(auditErr),
          ],
        },
        "[Login:user] error",
      );
    }
    // SEC-210: the raw message stays in server-side logs/audit metadata only;
    // the client gets the sanitized form.
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── GET /me/wallet/history ───────────────────────────────────────────────────

user.get("/me/wallet/history", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const walletIndex = parseUserWalletIndexSelector(
    c.req.query("walletIndex"),
    c.req.query("wallet_index"),
  );
  if (!walletIndex.ok) {
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse<[]>>({ ok: true, data: [] });
  }

  const db = getDb();
  const limit = clampLimit(c.req.query("limit") ?? null);
  const offset = parseBoundedOffset(c.req.query("offset") ?? null);
  const history = await db
    .select()
    .from(transactions)
    .where(eq(transactions.agentId, wallet.id))
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({
    ok: true,
    data: { transactions: history.map(toTxRecord), limit, offset },
  });
});

// ─── GET /me/wallet/policies ──────────────────────────────────────────────────

user.get("/me/wallet/policies", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Message signing requires a recent MFA step-up session",
      },
      403,
    );
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const walletIndex = parseUserWalletIndexSelector(
    c.req.query("walletIndex"),
    c.req.query("wallet_index"),
  );
  if (!walletIndex.ok) {
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    // No wallet yet — return the defaults so the user can preview them
    return c.json<ApiResponse<PolicyRule[]>>({
      ok: true,
      data: USER_WALLET_DEFAULT_POLICIES,
    });
  }

  const db = getDb();
  const storedPolicies = await db
    .select()
    .from(policies)
    .where(eq(policies.agentId, wallet.id));

  const activePolicies: PolicyRule[] =
    storedPolicies.length > 0
      ? storedPolicies.map(toPolicyRule)
      : USER_WALLET_DEFAULT_POLICIES;

  return c.json<ApiResponse<PolicyRule[]>>({ ok: true, data: activePolicies });
});

// ─── POST /me/wallet/sign-message ─────────────────────────────────────────────

user.post("/me/wallet/sign-message", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  if (!allowUnsafeMessageSigning() || !allowUserUnsafeMessageSigning()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Message signing is disabled because arbitrary signatures bypass transaction policy controls. Set STEWARD_ALLOW_UNSAFE_MESSAGE_SIGNING=true and STEWARD_ALLOW_USER_UNSAFE_MESSAGE_SIGNING=true only for audited compatibility flows.",
      },
      403,
    );
  }

  const userId = c.get("userId");
  const session = c.get("userSession");
  const signerAuth = getUserWalletSignerAuth(c);
  if (!signerAuth && !hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Message signing requires a recent MFA step-up session",
      },
      403,
    );
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const body = await safeJsonParse<{
    message: string;
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  if (!body || !isNonEmptyString(body.message)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "'message' is required and must be a non-empty string",
      },
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
  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex,
    body.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.sign_message.rejected",
      error: walletIndex.error,
      walletIndex: body.walletIndex,
      wallet_index: body.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }
  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet first to provision",
      },
      404,
    );
  }
  const signerScopeResponse = requireUserWalletSignerWalletScope(c, wallet.id);
  if (signerScopeResponse) return signerScopeResponse;

  try {
    await writeAuditEvent({
      tenantId: `personal-${userId}`,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.sign_message.authorized",
      resourceType: "wallet",
      resourceId: wallet.id,
      metadata: {
        messageLength: body.message.length,
        unsafeCompatibilityMode: true,
        walletIndex: walletIndex.value,
        ...userWalletSignerAuditMetadata(c),
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    const signature = await vault.signMessage(
      `personal-${userId}`,
      wallet.id,
      body.message,
    );
    await writeAuditEvent({
      tenantId: `personal-${userId}`,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.sign_message",
      resourceType: "wallet",
      resourceId: wallet.id,
      metadata: {
        messageLength: body.message.length,
        unsafeCompatibilityMode: true,
        walletIndex: walletIndex.value,
        ...userWalletSignerAuditMetadata(c),
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });

    setNoStoreHeaders(c);
    return c.json<ApiResponse<{ signature: string; address: string }>>({
      ok: true,
      data: { signature, address: wallet.walletAddress },
    });
  } catch (e) {
    logger.error(
      {
        details: [
          `[UserWallet] sign-message failed for user "${userId}"`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:user] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── POST /me/wallet/import/init ─────────────────────────────────────────────

user.post("/me/wallet/import/init", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  if (!allowPrivateKeyImport() || !allowUserPrivateKeyImport()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Private key import is disabled. Set STEWARD_ALLOW_PRIVATE_KEY_IMPORT=true and STEWARD_ALLOW_USER_PRIVATE_KEY_IMPORT=true only for audited import operations.",
      },
      403,
    );
  }

  const userId = c.get("userId");
  const policyResponse = await requireUserWalletPrivateKeyPolicy(
    c,
    "keyImport",
  );
  if (policyResponse) return policyResponse;
  const session = c.get("userSession");

  try {
    getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const body = await safeJsonParse<{
    chain?: unknown;
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  if (body?.chain !== "evm" && body?.chain !== "solana") {
    return c.json<ApiResponse>(
      { ok: false, error: "chain must be evm or solana" },
      400,
    );
  }
  const walletIndex = parseUserWalletIndexSelector(
    body?.walletIndex,
    body?.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.private_key_import.rejected",
      error: walletIndex.error,
      walletIndex: body?.walletIndex,
      wallet_index: body?.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  const displayName =
    (session.address as string | undefined) ?? session.email ?? userId;
  const tenantId = await ensurePersonalTenant(userId, displayName);
  const agentId = userWalletAgentId(userId, walletIndex.value);
  const appId = sessionAppClientId(session);
  const importSession = await createUserWalletEncryptedImportSession({
    tenantId,
    userId,
    agentId,
    chain: body.chain,
    walletIndex: walletIndex.value,
    appId,
  });

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "user.wallet.private_key_import.initialized",
    resourceType: "wallet",
    resourceId: agentId,
    metadata: {
      chain: body.chain,
      walletIndex: walletIndex.value,
      appClientId: appId,
      importSessionId: importSession.id,
      expiresAt: new Date(importSession.expiresAt).toISOString(),
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
        userId: string;
        agentId: string;
        chain: "evm" | "solana";
        walletIndex: number;
        appClientId: string | null;
      };
    }>
  >({
    ok: true,
    data: {
      importSessionId: importSession.id,
      publicKey: importSession.publicKey,
      algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
      expiresAt: new Date(importSession.expiresAt).toISOString(),
      aad: {
        importSessionId: importSession.id,
        tenantId,
        userId,
        agentId,
        chain: importSession.chain,
        walletIndex: importSession.walletIndex,
        appClientId: appId,
      },
    },
  });
});

// ─── POST /me/wallet/import/submit ───────────────────────────────────────────

user.post("/me/wallet/import/submit", async (c) => {
  setNoStoreHeaders(c);
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  if (!allowPrivateKeyImport() || !allowUserPrivateKeyImport()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Private key import is disabled. Set STEWARD_ALLOW_PRIVATE_KEY_IMPORT=true and STEWARD_ALLOW_USER_PRIVATE_KEY_IMPORT=true only for audited import operations.",
      },
      403,
    );
  }

  const userId = c.get("userId");
  const policyResponse = await requireUserWalletPrivateKeyPolicy(
    c,
    "keyImport",
  );
  if (policyResponse) return policyResponse;
  const session = c.get("userSession");

  const body = await safeJsonParse<{
    importSessionId?: unknown;
    ephemeralPublicKey?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
    tag?: unknown;
    privateKey?: unknown;
    walletIndex?: unknown;
    wallet_index?: unknown;
  }>(c);
  if (!body || !isPlainObject(body)) {
    return c.json<ApiResponse>(
      { ok: false, error: "JSON request body must be an object" },
      400,
    );
  }
  if ("privateKey" in body) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Submit the encrypted import envelope; plaintext privateKey is rejected",
      },
      400,
    );
  }

  const walletIndex = parseUserWalletIndexSelector(
    body.walletIndex,
    body.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.private_key_import.rejected",
      error: walletIndex.error,
      walletIndex: body.walletIndex,
      wallet_index: body.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  const tenantId = personalTenantId(userId);
  const importSession = await takeUserWalletEncryptedImportSession(
    body.importSessionId,
    {
      tenantId,
      userId,
      walletIndex: walletIndex.value,
      appId: sessionAppClientId(session),
    },
  );
  if (!importSession) {
    return c.json<ApiResponse>(
      { ok: false, error: "Encrypted import session is invalid or expired" },
      400,
    );
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  let privateKey: string;
  try {
    privateKey = decryptUserWalletEncryptedPrivateKey(importSession, body);
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Encrypted import failed";
    return c.json<ApiResponse>({ ok: false, error: msg }, 400);
  }

  const existingWallet = await getUserWallet(
    vault,
    userId,
    tenantId,
    importSession.walletIndex,
  );

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.private_key_import.authorized",
      resourceType: "wallet",
      resourceId: importSession.agentId,
      metadata: {
        chain: importSession.chain,
        walletIndex: importSession.walletIndex,
        appClientId: importSession.appId,
        importSessionId: importSession.id,
        replacingExisting: Boolean(existingWallet),
      },
    });

    const imported = await vault.importKey(
      tenantId,
      importSession.agentId,
      privateKey,
      importSession.chain,
    );
    await applyUserWalletDefaults(userId, tenantId, importSession.walletIndex);

    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.private_key_import",
      resourceType: "wallet",
      resourceId: importSession.agentId,
      metadata: {
        chain: importSession.chain,
        walletIndex: importSession.walletIndex,
        appClientId: importSession.appId,
        importSessionId: importSession.id,
        replacingExisting: Boolean(existingWallet),
        walletAddress: imported.walletAddress,
      },
    });
    if (!existingWallet) {
      dispatchWebhook(tenantId, importSession.agentId, "user.wallet_created", {
        userId,
        walletId: importSession.agentId,
        walletAddress: imported.walletAddress,
        imported: true,
        chain: importSession.chain,
        walletIndex: importSession.walletIndex,
      });
    }
    dispatchWebhook(tenantId, importSession.agentId, "wallet.imported", {
      userId,
      walletId: importSession.agentId,
      walletAddress: imported.walletAddress,
      chain: importSession.chain,
      walletIndex: importSession.walletIndex,
      replacingExisting: Boolean(existingWallet),
    });

    return c.json<
      ApiResponse<{
        agentId: string;
        walletAddress: string;
        chain: "evm" | "solana";
        walletIndex: number;
        imported: true;
      }>
    >({
      ok: true,
      data: {
        agentId: importSession.agentId,
        walletAddress: imported.walletAddress,
        chain: importSession.chain,
        walletIndex: importSession.walletIndex,
        imported: true,
      },
    });
  } catch (e) {
    logger.error(
      {
        details: [
          `[UserWallet] encrypted import failed for user "${userId}"`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:user] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── POST /me/wallet/export ────────────────────────────────────────────────────

user.post("/me/wallet/export", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  if (!allowPrivateKeyExport() || !allowUserPrivateKeyExport()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Private key export is disabled. Set STEWARD_ALLOW_KEY_EXPORT=true, STEWARD_ALLOW_PRIVATE_KEY_EXPORT=true, and STEWARD_ALLOW_USER_PRIVATE_KEY_EXPORT=true only for audited break-glass operations.",
      },
      403,
    );
  }

  const userId = c.get("userId");
  const policyResponse = await requireUserWalletPrivateKeyPolicy(
    c,
    "keyExport",
  );
  if (policyResponse) return policyResponse;

  const parsedBody = await parseOptionalJsonBody<
    { walletIndex?: unknown; wallet_index?: unknown } & Record<string, unknown>
  >(c);
  if (!parsedBody.ok) {
    return c.json<ApiResponse>({ ok: false, error: parsedBody.error }, 400);
  }
  const body = parsedBody.value;
  const plaintextGateError = plaintextKeyExportResponseGateError(body);
  if (plaintextGateError) {
    return c.json<ApiResponse>({ ok: false, error: plaintextGateError }, 403);
  }
  const walletIndex = parseUserWalletIndexSelector(
    body?.walletIndex,
    body?.wallet_index,
  );
  if (!walletIndex.ok) {
    await writeInvalidUserWalletIndexAudit(c, {
      userId,
      action: "user.wallet.private_key_export.rejected",
      error: walletIndex.error,
      walletIndex: body?.walletIndex,
      wallet_index: body?.wallet_index,
    });
    return c.json<ApiResponse>({ ok: false, error: walletIndex.error }, 400);
  }

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Vault not configured" },
      503,
    );
  }

  const wallet = await getUserWallet(
    vault,
    userId,
    undefined,
    walletIndex.value,
  );
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call POST /me/wallet first to provision",
      },
      404,
    );
  }

  const personalTenantId = `personal-${userId}`;

  try {
    await writeUserAudit(c, {
      tenantId: personalTenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.private_key_export.authorized",
      resourceType: "wallet",
      resourceId: wallet.id,
      metadata: { breakGlass: true, walletIndex: walletIndex.value },
    });
    const keys = await vault.exportPrivateKey(personalTenantId, wallet.id, {
      breakGlass: true,
      actorId: userId,
      reason: "personal-wallet break-glass export",
    });
    await writeUserAudit(c, {
      tenantId: personalTenantId,
      actorType: "user",
      actorId: userId,
      action: "user.wallet.private_key_export.succeeded",
      resourceType: "wallet",
      resourceId: wallet.id,
      metadata: { breakGlass: true, walletIndex: walletIndex.value },
    });
    dispatchWebhook(personalTenantId, wallet.id, "private_key.exported", {
      userId,
      walletId: wallet.id,
      breakGlass: true,
      walletIndex: walletIndex.value,
    });

    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json<
      ApiResponse<{
        evm?: { privateKey: string; address: string };
        solana?: { privateKey: string; address: string };
        warning: string;
      }>
    >({
      ok: true,
      data: {
        ...keys,
        warning: "This key controls real funds. Store securely.",
      },
    });
  } catch (e) {
    logger.error(
      {
        details: [
          `[UserWallet] export failed for user "${userId}"`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:user] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── Tenant membership routes ─────────────────────────────────────────────────

/**
 * GET /me/tenants
 * List all tenants the authenticated user belongs to.
 */
user.get("/me/tenants", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const db = getDb();

  const memberships = await db
    .select({
      tenantId: userTenants.tenantId,
      tenantName: tenants.name,
      role: userTenants.role,
      joinedAt: userTenants.createdAt,
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(eq(userTenants.userId, userId));

  return c.json<ApiResponse<typeof memberships>>({
    ok: true,
    data: memberships,
  });
});

/**
 * POST /me/tenants
 * Create a new self-serve tenant owned by the authenticated user.
 */
user.post("/me/tenants", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  if (!userTenantCreationAllowed()) {
    return c.json<ApiResponse>(
      { ok: false, error: "User tenant creation is disabled" },
      403,
    );
  }
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant creation requires a recent MFA step-up session",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    name?: string;
    slug?: string;
    settings?: unknown;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isNonEmptyString(body.name)) {
    return c.json<ApiResponse>(
      { ok: false, error: "name is required and must be a non-empty string" },
      400,
    );
  }

  const tenantId = body.slug ? body.slug.trim() : slugifyTenantId(body.name);
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid tenant slug — must be 1-64 alphanumeric chars (plus _ - . :)",
      },
      400,
    );
  }
  if (isReservedTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant slug is reserved" },
      400,
    );
  }

  const userId = c.get("userId");
  const db = getDb();

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (existing) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant already exists" },
      409,
    );
  }

  const apiKeyPair = generateApiKey();

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "tenant.create.authorized",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: { name: body.name.trim(), selfServe: true },
    });
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "tenant.api_key.create.authorized",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: { selfServe: true },
    });

    const [tenant] = await db
      .insert(tenants)
      .values({
        id: tenantId,
        name: body.name.trim(),
        apiKeyHash: apiKeyPair.hash,
        ownerAddress:
          typeof session.address === "string" ? session.address : undefined,
      })
      .returning();

    if (!tenant) {
      return c.json<ApiResponse>(
        { ok: false, error: "Failed to create tenant" },
        500,
      );
    }

    await db
      .insert(userTenants)
      .values({ userId, tenantId: tenant.id, role: "owner" })
      .onConflictDoNothing();

    try {
      await writeUserAudit(c, {
        tenantId: tenant.id,
        actorType: "user",
        actorId: userId,
        action: "tenant.create",
        resourceType: "tenant",
        resourceId: tenant.id,
        metadata: { name: tenant.name, selfServe: true },
      });
      await writeUserAudit(c, {
        tenantId: tenant.id,
        actorType: "user",
        actorId: userId,
        action: "tenant.api_key.create",
        resourceType: "tenant",
        resourceId: tenant.id,
        metadata: { selfServe: true },
      });
    } catch (auditErr) {
      await db.delete(tenants).where(eq(tenants.id, tenant.id));
      throw auditErr;
    }

    return c.json<
      ApiResponse<{
        tenantId: string;
        id: string;
        name: string;
        role: string;
        apiKey: string;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(
      {
        ok: true,
        data: {
          tenantId: tenant.id,
          id: tenant.id,
          name: tenant.name,
          role: "owner",
          apiKey: apiKeyPair.key,
          createdAt: tenant.createdAt,
          updatedAt: tenant.updatedAt,
        },
      },
      201,
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create tenant";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

/**
 * POST /me/tenants/switch
 * Mint a new session token scoped to an existing tenant membership.
 */
user.post("/me/tenants/switch", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const body = await safeJsonParse<{ tenantId?: string }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isValidTenantId(body.tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId is required" },
      400,
    );
  }

  const userId = c.get("userId");
  const session = c.get("userSession");
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant switching requires a recent MFA step-up session",
      },
      403,
    );
  }
  const db = getDb();

  const [membership] = await db
    .select({ tenantId: userTenants.tenantId, role: userTenants.role })
    .from(userTenants)
    .where(
      and(
        eq(userTenants.userId, userId),
        eq(userTenants.tenantId, body.tenantId),
      ),
    );

  if (!membership) {
    return c.json<ApiResponse>(
      { ok: false, error: "Not a member of this tenant" },
      403,
    );
  }

  if (typeof session.exp !== "number" || !Number.isFinite(session.exp)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Session expiry is required" },
      401,
    );
  }
  const remainingSeconds = Math.floor(session.exp - Date.now() / 1000);
  if (remainingSeconds <= 0) {
    return c.json<ApiResponse>({ ok: false, error: "Session expired" }, 401);
  }
  const {
    exp: _exp,
    iat: _iat,
    nbf: _nbf,
    jti: _jti,
    iss: _iss,
    aud: _aud,
    tenantId: _tenantId,
    activeTenantId: _activeTenantId,
    mfaVerifiedAt: _mfaVerifiedAt,
    mfaMethod: _mfaMethod,
    factorEnrollmentVerifiedAt: _factorEnrollmentVerifiedAt,
    ...sessionClaims
  } = session;
  // MFA freshness is scoped to the tenant where it was performed. A switched
  // tenant token must perform its own step-up before sensitive tenant actions.
  const token = await createSessionToken(
    typeof session.address === "string" ? session.address : "",
    membership.tenantId,
    {
      ...sessionClaims,
      userId,
      tenantId: membership.tenantId,
      activeTenantId: membership.tenantId,
    },
    `${remainingSeconds}s`,
  );

  await writeUserAudit(c, {
    tenantId: membership.tenantId,
    actorType: "user",
    actorId: userId,
    action: "tenant.switch",
    resourceType: "tenant",
    resourceId: membership.tenantId,
  });
  dispatchWebhook(membership.tenantId, userId, "user.authenticated", {
    userId,
    authMethod: "tenant_switch",
  });

  setNoStoreHeaders(c);
  return c.json<
    ApiResponse<{
      token: string;
      tenantId: string;
      activeTenantId: string;
      role: string;
    }>
  >({
    ok: true,
    data: {
      token,
      tenantId: membership.tenantId,
      activeTenantId: membership.tenantId,
      role: membership.role,
    },
  });
});

/**
 * GET /me/tenants/:tenantId
 * Get single tenant membership info for the authenticated user.
 */
user.get("/me/tenants/:tenantId", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const tenantId = c.req.param("tenantId");
  const db = getDb();

  const [membership] = await db
    .select({
      tenantId: userTenants.tenantId,
      tenantName: tenants.name,
      role: userTenants.role,
      joinedAt: userTenants.createdAt,
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(
      and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
    );

  if (!membership) {
    return c.json<ApiResponse>(
      { ok: false, error: "Not a member of this tenant" },
      404,
    );
  }

  return c.json<ApiResponse<typeof membership>>({ ok: true, data: membership });
});

type TenantAdminUserRow = {
  userId: string;
  tenantId: string;
  role: string;
  joinedAt: Date;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  tenantCustomMetadata: Record<string, unknown>;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type TenantAdminInvitationRow = {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: string;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type TenantAdminUserEventRow = {
  id: number;
  seq: number;
  action: string;
  actorType: string;
  actorId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type TenantThirdPartyWalletViolation = {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  walletCount: number;
  wallets: Array<{
    accountId: string;
    provider: "wallet:ethereum" | "wallet:solana";
    providerAccountId: string;
  }>;
};

const TENANT_WALLET_POLICY_BULK_REMEDIATION_LIMIT = 50;

type TenantWalletPolicyRemediationSuccess = {
  deleted: true;
  accountId: string;
  provider: "wallet:ethereum" | "wallet:solana";
  providerAccountId: string;
  issuedBefore: number;
};

type TenantWalletPolicyBulkRemediationResult =
  | ({ ok: true; targetUserId: string } & TenantWalletPolicyRemediationSuccess)
  | {
      ok: false;
      targetUserId: string;
      accountId: string;
      status: number;
      error: string;
    };

function tenantAdminUserSelection() {
  return {
    userId: users.id,
    tenantId: userTenants.tenantId,
    role: userTenants.role,
    joinedAt: userTenants.createdAt,
    email: users.email,
    emailVerified: users.emailVerified,
    name: users.name,
    tenantCustomMetadata: userTenants.customMetadata,
    deactivatedAt: users.deactivatedAt,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  };
}

function tenantAdminInvitationSelection() {
  return {
    id: tenantInvitations.id,
    tenantId: tenantInvitations.tenantId,
    email: tenantInvitations.email,
    role: tenantInvitations.role,
    status: tenantInvitations.status,
    invitedByUserId: tenantInvitations.invitedByUserId,
    acceptedByUserId: tenantInvitations.acceptedByUserId,
    acceptedAt: tenantInvitations.acceptedAt,
    revokedAt: tenantInvitations.revokedAt,
    expiresAt: tenantInvitations.expiresAt,
    createdAt: tenantInvitations.createdAt,
    updatedAt: tenantInvitations.updatedAt,
  };
}

async function requireTenantAdminMfa(
  c: Context<{ Variables: UserVariables }>,
  tenantId: string,
  message: string,
): Promise<
  { ok: true; userId: string; role: string } | { ok: false; response: Response }
> {
  const requesterId = c.get("userId");
  const session = c.get("userSession");
  if (!sessionTenantMatches(session, tenantId)) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Session tenant does not match requested tenant" },
        403,
      ),
    };
  }
  const requesterRole = await requireTenantAdmin(requesterId, tenantId);
  if (!requesterRole) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Tenant admin access required" },
        403,
      ),
    };
  }
  if (!hasRecentMfaStepUp(session)) {
    return {
      ok: false,
      response: c.json<ApiResponse>({ ok: false, error: message }, 403),
    };
  }
  return { ok: true, userId: requesterId, role: requesterRole };
}

async function remediateTenantWalletPolicyAccount(
  c: Context<{ Variables: UserVariables }>,
  params: {
    tenantId: string;
    targetUserId: string;
    accountId: string;
    adminUserId: string;
  },
): Promise<
  | { ok: true; data: TenantWalletPolicyRemediationSuccess }
  | { ok: false; status: number; error: string }
> {
  const { tenantId, targetUserId, accountId, adminUserId } = params;
  const db = getDb();
  const [targetMembership] = await db
    .select({ userId: userTenants.userId })
    .from(userTenants)
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.userId, targetUserId),
      ),
    );
  if (!targetMembership) {
    return { ok: false, status: 404, error: "Tenant user not found" };
  }

  const [initialAccount] = await db
    .select({
      id: accounts.id,
      userId: accounts.userId,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      expiresAt: accounts.expiresAt,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, targetUserId)));
  if (
    !initialAccount ||
    (initialAccount.provider !== "wallet:ethereum" &&
      initialAccount.provider !== "wallet:solana")
  ) {
    return { ok: false, status: 404, error: "Linked wallet account not found" };
  }

  const [targetUser] = await db
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
    })
    .from(users)
    .where(eq(users.id, targetUserId));
  if (!targetUser)
    return { ok: false, status: 404, error: "Tenant user not found" };
  const targetAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, targetUserId));
  const targetPasskeys = await db
    .select({ id: authenticators.id })
    .from(authenticators)
    .where(eq(authenticators.userId, targetUserId));
  const remainingLoginMethodCount =
    primaryLoginMethods(targetUser).length +
    targetAccounts.length +
    targetPasskeys.length -
    1;
  if (remainingLoginMethodCount < 1) {
    return {
      ok: false,
      status: 409,
      error: "Cannot unlink the user's last login method",
    };
  }

  const issuedBefore = Math.floor(Date.now() / 1000) + 1;
  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: adminUserId,
    action: "tenant.wallet_policy.remediation.authorized",
    resourceType: "user",
    resourceId: targetUserId,
    metadata: {
      accountId: initialAccount.id,
      provider: initialAccount.provider,
      providerAccountId: initialAccount.providerAccountId,
      issuedBefore,
    },
  });

  const refreshTokenSnapshot = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.userId, targetUserId));
  const [deleted] = await db
    .delete(accounts)
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.userId, targetUserId),
        or(
          eq(accounts.provider, "wallet:ethereum"),
          eq(accounts.provider, "wallet:solana"),
        ),
      ),
    )
    .returning();
  if (!deleted) {
    return { ok: false, status: 409, error: "Linked wallet account changed" };
  }

  try {
    await revocationStore.revokeUserTokens(targetUserId, issuedBefore);
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, targetUserId));
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: adminUserId,
      action: "tenant.wallet_policy.remediation",
      resourceType: "user",
      resourceId: targetUserId,
      metadata: {
        accountId: deleted.id,
        provider: deleted.provider,
        providerAccountId: deleted.providerAccountId,
        issuedBefore,
      },
    });
  } catch (error) {
    await db.insert(accounts).values({
      id: deleted.id,
      userId: deleted.userId,
      provider: deleted.provider,
      providerAccountId: deleted.providerAccountId,
      accessTokenEncrypted: deleted.accessTokenEncrypted,
      accessTokenIv: deleted.accessTokenIv,
      accessTokenTag: deleted.accessTokenTag,
      accessTokenSalt: deleted.accessTokenSalt,
      refreshTokenEncrypted: deleted.refreshTokenEncrypted,
      refreshTokenIv: deleted.refreshTokenIv,
      refreshTokenTag: deleted.refreshTokenTag,
      refreshTokenSalt: deleted.refreshTokenSalt,
      expiresAt: deleted.expiresAt,
    });
    if (refreshTokenSnapshot.length > 0)
      await db.insert(refreshTokens).values(refreshTokenSnapshot);
    throw error;
  }

  dispatchWebhook(tenantId, targetUserId, "user.unlinked_account", {
    userId: targetUserId,
    provider: deleted.provider,
    accountId: deleted.id,
    remediatedByUserId: adminUserId,
    remediation: "tenant_wallet_policy",
    redacted: true,
  });

  return {
    ok: true,
    data: {
      deleted: true,
      accountId: deleted.id,
      provider: deleted.provider as "wallet:ethereum" | "wallet:solana",
      providerAccountId: deleted.providerAccountId,
      issuedBefore,
    },
  };
}

async function requireTenantUserDirectoryReaderMfa(
  c: Context<{ Variables: UserVariables }>,
  tenantId: string,
  message: string,
): Promise<
  { ok: true; userId: string; role: string } | { ok: false; response: Response }
> {
  const requesterId = c.get("userId");
  const session = c.get("userSession");
  if (!sessionTenantMatches(session, tenantId)) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Session tenant does not match requested tenant" },
        403,
      ),
    };
  }
  const requesterRole = await requireTenantUserDirectoryReader(
    requesterId,
    tenantId,
  );
  if (!requesterRole) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Tenant user directory access required" },
        403,
      ),
    };
  }
  if (!hasRecentMfaStepUp(session)) {
    return {
      ok: false,
      response: c.json<ApiResponse>({ ok: false, error: message }, 403),
    };
  }
  return { ok: true, userId: requesterId, role: requesterRole };
}

/**
 * GET /me/tenants/:tenantId/invitations
 * Tenant-admin invitation list for dashboard views.
 */
user.get("/me/tenants/:tenantId/invitations", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  const admin = await requireTenantAdminMfa(
    c,
    tenantId,
    "Tenant invitations require recent MFA verification",
  );
  if (!admin.ok) return admin.response;

  const status = c.req.query("status")?.trim().toLowerCase() || "pending";
  if (!["pending", "accepted", "revoked", "expired", "all"].includes(status)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid invitation status" },
      400,
    );
  }
  const whereConditions = [eq(tenantInvitations.tenantId, tenantId)];
  if (status !== "all")
    whereConditions.push(eq(tenantInvitations.status, status));
  const rows = await getDb()
    .select(tenantAdminInvitationSelection())
    .from(tenantInvitations)
    .where(and(...whereConditions))
    .limit(clampLimit(c.req.query("limit") ?? null))
    .offset(parseBoundedOffset(c.req.query("offset") ?? null));

  return c.json<
    ApiResponse<{
      invitations: TenantAdminInvitationRow[];
      limit: number;
      offset: number;
    }>
  >({
    ok: true,
    data: {
      invitations: rows,
      limit: clampLimit(c.req.query("limit") ?? null),
      offset: parseBoundedOffset(c.req.query("offset") ?? null),
    },
  });
});

/**
 * POST /me/tenants/:tenantId/invitations
 * Tenant-admin invitation creation. Returns a one-time token for delivery.
 */
user.post("/me/tenants/:tenantId/invitations", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  const admin = await requireTenantAdminMfa(
    c,
    tenantId,
    "Tenant invitation creation requires recent MFA verification",
  );
  if (!admin.ok) return admin.response;

  const body = await safeJsonParse<{
    email?: unknown;
    role?: unknown;
    expiresInSeconds?: unknown;
    sendEmail?: unknown;
  }>(c);
  const email =
    typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json<ApiResponse>(
      { ok: false, error: "valid email is required" },
      400,
    );
  }
  const role = normalizeTenantInvitationRole(body?.role);
  if (!role) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `role must be one of: ${TENANT_INVITATION_ROLES.join(", ")}`,
      },
      400,
    );
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashSha256Hex(token);
  const expiresAt = normalizeInvitationExpiry(body?.expiresInSeconds);
  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: admin.userId,
    action: "tenant.invitation.create.authorized",
    resourceType: "tenant_invitation",
    resourceId: email,
    metadata: { email, role, expiresAt: expiresAt.toISOString() },
  });

  const db = getDb();
  const invitation = await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(tenantInvitations)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          eq(tenantInvitations.email, email),
          eq(tenantInvitations.status, "pending"),
        ),
      );
    const [created] = await tx
      .insert(tenantInvitations)
      .values({
        tenantId,
        email,
        role,
        tokenHash,
        invitedByUserId: admin.userId,
        expiresAt,
      })
      .returning(tenantAdminInvitationSelection());
    return created;
  });

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: admin.userId,
    action: "tenant.invitation.create",
    resourceType: "tenant_invitation",
    resourceId: invitation.id,
    metadata: { email, role, expiresAt: expiresAt.toISOString() },
  });

  let emailSent = false;
  if (body?.sendEmail === true) {
    try {
      const emailAuth = await getEmailAuthForTenant(tenantId);
      await emailAuth.sendTenantInvitation(email, {
        tenantId,
        token,
        expiresAt,
      });
      emailSent = true;
    } catch (error) {
      logger.error(
        {
          details: [
            "[TenantInvitation] Email delivery failed",
            redactedThrownDiagnostics(error),
          ],
        },
        "[Login:user] error",
      );
    }
  }

  setNoStoreHeaders(c);
  return c.json<
    ApiResponse<{
      invitation: TenantAdminInvitationRow;
      token: string;
      emailSent: boolean;
    }>
  >({ ok: true, data: { invitation, token, emailSent } }, 201);
});

/**
 * DELETE /me/tenants/:tenantId/invitations/:invitationId
 * Tenant-admin pending invitation revocation.
 */
user.delete("/me/tenants/:tenantId/invitations/:invitationId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const invitationId = c.req.param("invitationId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(invitationId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid invitation id format" },
      400,
    );
  }
  const admin = await requireTenantAdminMfa(
    c,
    tenantId,
    "Tenant invitation revocation requires recent MFA verification",
  );
  if (!admin.ok) return admin.response;

  const db = getDb();
  const [candidate] = await db
    .select({
      id: tenantInvitations.id,
      email: tenantInvitations.email,
      role: tenantInvitations.role,
      status: tenantInvitations.status,
      revokedAt: tenantInvitations.revokedAt,
      updatedAt: tenantInvitations.updatedAt,
    })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.status, "pending"),
      ),
    )
    .limit(1);
  if (!candidate) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pending invitation not found" },
      404,
    );
  }

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: admin.userId,
    action: "tenant.invitation.revoke.authorized",
    resourceType: "tenant_invitation",
    resourceId: candidate.id,
    metadata: { email: candidate.email, role: candidate.role },
  });

  const [invitation] = await db
    .update(tenantInvitations)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.status, "pending"),
      ),
    )
    .returning(tenantAdminInvitationSelection());
  if (!invitation) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pending invitation not found" },
      404,
    );
  }

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: admin.userId,
      action: "tenant.invitation.revoke",
      resourceType: "tenant_invitation",
      resourceId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
    });
  } catch (error) {
    await db
      .update(tenantInvitations)
      .set({
        status: candidate.status,
        revokedAt: candidate.revokedAt,
        updatedAt: candidate.updatedAt,
      })
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          eq(tenantInvitations.id, invitationId),
        ),
      );
    throw error;
  }

  return c.json<ApiResponse>({ ok: true });
});

/**
 * GET /me/tenants/:tenantId/users
 * Tenant-admin user search for dashboard views. This intentionally returns
 * tenant-scoped fields only and never exposes global linked accounts.
 */
user.get("/me/tenants/:tenantId/users", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  const reader = await requireTenantUserDirectoryReaderMfa(
    c,
    tenantId,
    "Tenant user directory requires recent MFA verification",
  );
  if (!reader.ok) return reader.response;

  const db = getDb();
  const limit = clampLimit(c.req.query("limit") ?? null);
  const offset = parseBoundedOffset(c.req.query("offset") ?? null);
  const email = c.req.query("email")?.trim().toLowerCase();
  const q = c.req.query("q")?.trim().toLowerCase();
  const whereConditions = [eq(userTenants.tenantId, tenantId)];
  if (email) whereConditions.push(eq(users.email, email));
  if (q) {
    const like = `%${escapeLikePattern(q)}%`;
    whereConditions.push(
      requireLoginValue(
        or(
          ilike(users.email, like),
          ilike(users.name, like),
          sql`${users.id}::text ilike ${like}`,
        ),
        "or(\n        ilike(users.email, like),\n        ilike(users.name, like),\n        sql`${users.id}::text ilike ${like}`,\n      )",
      ),
    );
  }

  const rows = await db
    .select(tenantAdminUserSelection())
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(and(...whereConditions))
    .limit(limit)
    .offset(offset);

  return c.json<
    ApiResponse<{ users: TenantAdminUserRow[]; limit: number; offset: number }>
  >({
    ok: true,
    data: { users: rows, limit, offset },
  });
});

/**
 * GET /me/tenants/:tenantId/users/wallet-policy/violations
 * Read-only remediation report for tenants that want to enforce the
 * one-third-party-wallet policy after users may already have multiple wallets.
 */
user.get("/me/tenants/:tenantId/users/wallet-policy/violations", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  const reader = await requireTenantUserDirectoryReaderMfa(
    c,
    tenantId,
    "Tenant wallet policy reports require recent MFA verification",
  );
  if (!reader.ok) return reader.response;

  const limit = clampLimit(c.req.query("limit") ?? null);
  const offset = parseBoundedOffset(c.req.query("offset") ?? null);
  const db = getDb();
  const [config] = await db
    .select({ authAbuseConfig: tenantConfigs.authAbuseConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));
  const rows = await db
    .select({
      userId: userTenants.userId,
      email: users.email,
      name: users.name,
      role: userTenants.role,
      accountId: accounts.id,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
    })
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .innerJoin(accounts, eq(accounts.userId, userTenants.userId))
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        or(
          eq(accounts.provider, "wallet:ethereum"),
          eq(accounts.provider, "wallet:solana"),
        ),
      ),
    )
    .orderBy(userTenants.userId, accounts.provider, accounts.providerAccountId);

  const byUser = new Map<string, TenantThirdPartyWalletViolation>();
  for (const row of rows) {
    const provider =
      row.provider === "wallet:ethereum" || row.provider === "wallet:solana"
        ? row.provider
        : null;
    if (!provider) continue;
    const entry =
      byUser.get(row.userId) ??
      ({
        userId: row.userId,
        email: row.email,
        name: row.name,
        role: row.role,
        walletCount: 0,
        wallets: [],
      } satisfies TenantThirdPartyWalletViolation);
    entry.wallets.push({
      accountId: row.accountId,
      provider,
      providerAccountId: row.providerAccountId,
    });
    entry.walletCount = entry.wallets.length;
    byUser.set(row.userId, entry);
  }

  const allViolations = [...byUser.values()].filter(
    (entry) => entry.wallets.length > 1,
  );
  const violations = allViolations.slice(offset, offset + limit);

  return c.json<
    ApiResponse<{
      tenantId: string;
      policyEnabled: boolean;
      violations: TenantThirdPartyWalletViolation[];
      total: number;
      limit: number;
      offset: number;
    }>
  >({
    ok: true,
    data: {
      tenantId,
      policyEnabled:
        config?.authAbuseConfig?.wallet?.restrictToOneThirdPartyWallet === true,
      violations,
      total: allViolations.length,
      limit,
      offset,
    },
  });
});

/**
 * POST /me/tenants/:tenantId/users/wallet-policy/remediations
 * Audited tenant-admin bulk remediation for selected linked third-party
 * wallets. Returns per-item results so callers can review partial failures.
 */
user.post(
  "/me/tenants/:tenantId/users/wallet-policy/remediations",
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!isValidTenantId(tenantId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid tenant id format" },
        400,
      );
    }
    const admin = await requireTenantAdminMfa(
      c,
      tenantId,
      "Tenant wallet policy remediation requires recent MFA verification",
    );
    if (!admin.ok) return admin.response;

    const body = await safeJsonParse<{ wallets?: unknown; items?: unknown }>(c);
    const rawItems = Array.isArray(body?.wallets)
      ? body.wallets
      : Array.isArray(body?.items)
        ? body.items
        : null;
    if (!rawItems || rawItems.length < 1) {
      return c.json<ApiResponse>(
        { ok: false, error: "wallets must be a non-empty array" },
        400,
      );
    }
    if (rawItems.length > TENANT_WALLET_POLICY_BULK_REMEDIATION_LIMIT) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `wallets is limited to ${TENANT_WALLET_POLICY_BULK_REMEDIATION_LIMIT} items`,
        },
        400,
      );
    }

    const results: TenantWalletPolicyBulkRemediationResult[] = [];
    const seen = new Set<string>();
    for (const rawItem of rawItems) {
      const item =
        rawItem && typeof rawItem === "object"
          ? (rawItem as Record<string, unknown>)
          : null;
      const targetUserId = typeof item?.userId === "string" ? item.userId : "";
      const accountId =
        typeof item?.accountId === "string" ? item.accountId : "";
      if (!isUuid(targetUserId) || !isUuid(accountId)) {
        results.push({
          ok: false,
          targetUserId,
          accountId,
          status: 400,
          error: "Invalid user or account id format",
        });
        continue;
      }
      const dedupeKey = `${targetUserId}:${accountId}`;
      if (seen.has(dedupeKey)) {
        results.push({
          ok: false,
          targetUserId,
          accountId,
          status: 409,
          error: "Duplicate remediation item",
        });
        continue;
      }
      seen.add(dedupeKey);

      const result = await remediateTenantWalletPolicyAccount(c, {
        tenantId,
        targetUserId,
        accountId,
        adminUserId: admin.userId,
      });
      if (result.ok) {
        results.push({ ok: true, targetUserId, ...result.data });
      } else {
        results.push({
          ok: false,
          targetUserId,
          accountId,
          status: result.status,
          error: result.error,
        });
      }
    }

    const succeeded = results.filter((result) => result.ok).length;
    return c.json<
      ApiResponse<{
        tenantId: string;
        results: TenantWalletPolicyBulkRemediationResult[];
        succeeded: number;
        failed: number;
      }>
    >({
      ok: true,
      data: {
        tenantId,
        results,
        succeeded,
        failed: results.length - succeeded,
      },
    });
  },
);

/**
 * DELETE /me/tenants/:tenantId/users/:userId/wallet-policy/wallets/:accountId
 * Audited tenant-admin remediation for existing users with multiple linked
 * third-party wallets after the one-wallet policy is enabled.
 */
user.delete(
  "/me/tenants/:tenantId/users/:targetUserId/wallet-policy/wallets/:accountId",
  async (c) => {
    const tenantId = c.req.param("tenantId");
    const targetUserId = c.req.param("targetUserId");
    const accountId = c.req.param("accountId");
    if (!isValidTenantId(tenantId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid tenant id format" },
        400,
      );
    }
    if (!isUuid(targetUserId) || !isUuid(accountId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid user or account id format" },
        400,
      );
    }
    const admin = await requireTenantAdminMfa(
      c,
      tenantId,
      "Tenant wallet policy remediation requires recent MFA verification",
    );
    if (!admin.ok) return admin.response;

    const result = await remediateTenantWalletPolicyAccount(c, {
      tenantId,
      targetUserId,
      accountId,
      adminUserId: admin.userId,
    });
    if (!result.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: result.error },
        result.status as 400,
      );
    }

    return c.json<ApiResponse<TenantWalletPolicyRemediationSuccess>>({
      ok: true,
      data: result.data,
    });
  },
);

/**
 * GET /me/tenants/:tenantId/users/export
 * Export the tenant-scoped user directory as CSV. The export intentionally
 * excludes global metadata, linked accounts, wallets, and identity graph data.
 */
user.get("/me/tenants/:tenantId/users/export", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  const admin = await requireTenantAdminMfa(
    c,
    tenantId,
    "Tenant user export requires recent MFA verification",
  );
  if (!admin.ok) return admin.response;

  const db = getDb();
  const limit = Math.min(
    clampLimit(c.req.query("limit") ?? null, 1000),
    10_000,
  );
  const email = c.req.query("email")?.trim().toLowerCase();
  const q = c.req.query("q")?.trim().toLowerCase();
  const whereConditions = [eq(userTenants.tenantId, tenantId)];
  if (email) whereConditions.push(eq(users.email, email));
  if (q) {
    const like = `%${escapeLikePattern(q)}%`;
    whereConditions.push(
      requireLoginValue(
        or(
          ilike(users.email, like),
          ilike(users.name, like),
          sql`${users.id}::text ilike ${like}`,
        ),
        "or(\n        ilike(users.email, like),\n        ilike(users.name, like),\n        sql`${users.id}::text ilike ${like}`,\n      )",
      ),
    );
  }

  const rows = await db
    .select(tenantAdminUserSelection())
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(and(...whereConditions))
    .limit(limit);

  const csvRows = [
    tenantUserCsvRow([
      "user_id",
      "tenant_id",
      "role",
      "status",
      "email",
      "email_verified",
      "name",
      "tenant_custom_metadata",
      "joined_at",
      "created_at",
      "updated_at",
      "deactivated_at",
    ]),
    ...rows.map((row) =>
      tenantUserCsvRow([
        row.userId,
        row.tenantId,
        row.role,
        row.deactivatedAt ? "deactivated" : "active",
        row.email,
        row.emailVerified,
        row.name,
        JSON.stringify(row.tenantCustomMetadata ?? {}),
        row.joinedAt,
        row.createdAt,
        row.updatedAt,
        row.deactivatedAt,
      ]),
    ),
  ];

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: admin.userId,
    action: "tenant.member.export",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {
      count: rows.length,
      limitedTo: limit,
      filtered: Boolean(email || q),
    },
  });

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${tenantId}-users.csv"`,
  );
  return c.body(`${csvRows.join("\n")}\n`);
});

/**
 * GET /me/tenants/:tenantId/users/:userId
 * Tenant-admin user read. Keeps global identity graph and linked accounts out
 * of the tenant dashboard surface.
 */
user.get("/me/tenants/:tenantId/users/:targetUserId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const targetUserId = c.req.param("targetUserId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(targetUserId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid user id" }, 400);
  }
  const reader = await requireTenantUserDirectoryReaderMfa(
    c,
    tenantId,
    "Tenant user directory requires recent MFA verification",
  );
  if (!reader.ok) return reader.response;

  const db = getDb();
  const [row] = await db
    .select(tenantAdminUserSelection())
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.userId, targetUserId),
      ),
    );

  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );
  return c.json<ApiResponse<TenantAdminUserRow>>({ ok: true, data: row });
});

/**
 * GET /me/tenants/:tenantId/users/:userId/events
 * Tenant-scoped lifecycle/activity history for a user. Returns only audit rows
 * for this tenant and user resource, avoiding global identity internals.
 */
user.get("/me/tenants/:tenantId/users/:targetUserId/events", async (c) => {
  const tenantId = c.req.param("tenantId");
  const targetUserId = c.req.param("targetUserId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(targetUserId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid user id" }, 400);
  }
  const reader = await requireTenantUserDirectoryReaderMfa(
    c,
    tenantId,
    "Tenant user activity requires recent MFA verification",
  );
  if (!reader.ok) return reader.response;

  const db = getDb();
  const [membership] = await db
    .select({ id: userTenants.id })
    .from(userTenants)
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!membership) {
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );
  }

  const limit = clampLimit(c.req.query("limit") ?? null, 25);
  const offset = parseBoundedOffset(c.req.query("offset") ?? null);
  const auditWhere = and(
    eq(auditEvents.tenantId, tenantId),
    eq(auditEvents.resourceType, "user"),
    eq(auditEvents.resourceId, targetUserId),
  );
  const rows = await db
    .select({
      id: auditEvents.id,
      seq: auditEvents.seq,
      action: auditEvents.action,
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      resourceType: auditEvents.resourceType,
      resourceId: auditEvents.resourceId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(auditWhere)
    .orderBy(desc(auditEvents.seq))
    .limit(limit)
    .offset(offset);
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(auditEvents)
    .where(auditWhere);

  return c.json<
    ApiResponse<{
      events: TenantAdminUserEventRow[];
      limit: number;
      offset: number;
      total: number;
    }>
  >({
    ok: true,
    data: {
      events: rows.map((row) => ({
        id: row.id,
        seq: Number(row.seq),
        action: row.action,
        actorType: row.actorType,
        actorId: row.actorId,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        metadata: row.metadata,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      })),
      limit,
      offset,
      total: Number(total),
    },
  });
});

/**
 * PATCH /me/tenants/:tenantId/users/:userId/role
 * Owner/admin role management for tenant teams. Privileged API access remains
 * restricted to owner/admin; developer/billing/viewer/member are non-admin roles.
 */
user.patch("/me/tenants/:tenantId/users/:targetUserId/role", async (c) => {
  const requesterId = c.get("userId");
  const session = c.get("userSession");
  const tenantId = c.req.param("tenantId");
  const targetUserId = c.req.param("targetUserId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(targetUserId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid user id" }, 400);
  }
  if (!sessionTenantMatches(session, tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Session tenant does not match requested tenant" },
      403,
    );
  }
  const requesterRole = await requireTenantAdmin(requesterId, tenantId);
  if (!requesterRole) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant admin access required" },
      403,
    );
  }
  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant role updates require recent MFA verification",
      },
      403,
    );
  }

  const body = await safeJsonParse<{ role?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const nextRole = normalizeTenantRole(body.role);
  if (!nextRole) {
    return c.json<ApiResponse>(
      { ok: false, error: `role must be one of: ${TENANT_ROLES.join(", ")}` },
      400,
    );
  }
  if (requesterRole !== "owner" && nextRole === "owner") {
    return c.json<ApiResponse>(
      { ok: false, error: "Only owners can grant owner role" },
      403,
    );
  }

  const db = getDb();
  let updated: { row: TenantAdminUserRow; previousRole: string } | null = null;
  try {
    updated = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [membership] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, targetUserId),
          ),
        );
      if (!membership) return null;
      if (
        membership.role === "owner" &&
        requesterRole !== "owner" &&
        nextRole !== "owner"
      ) {
        throw new Error("Only owners can modify owner role");
      }
      if (membership.role === "owner" && nextRole !== "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, targetUserId)) < 1) {
          throw new Error("Cannot demote the sole owner");
        }
      }

      await writeUserAudit(c, {
        tenantId,
        actorType: "user",
        actorId: requesterId,
        action: "tenant.member.role.update.authorized",
        resourceType: "user",
        resourceId: targetUserId,
        metadata: { previousRole: membership.role, nextRole },
      });

      await tx
        .update(userTenants)
        .set({ role: nextRole })
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, targetUserId),
          ),
        );

      const [row] = await tx
        .select(tenantAdminUserSelection())
        .from(userTenants)
        .innerJoin(users, eq(userTenants.userId, users.id))
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, targetUserId),
          ),
        );
      return row ? { row, previousRole: membership.role } : null;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Only owners can modify owner role"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
    }
    if (
      err instanceof Error &&
      err.message === "Cannot demote the sole owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }

  if (!updated)
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: requesterId,
      action: "tenant.member.role.update",
      resourceType: "user",
      resourceId: targetUserId,
      metadata: { previousRole: updated.previousRole, role: updated.row.role },
    });
  } catch (error) {
    await db
      .update(userTenants)
      .set({ role: updated.previousRole })
      .where(
        and(
          eq(userTenants.tenantId, tenantId),
          eq(userTenants.userId, targetUserId),
        ),
      );
    throw error;
  }

  return c.json<ApiResponse<TenantAdminUserRow>>({
    ok: true,
    data: updated.row,
  });
});

/**
 * PATCH /me/tenants/:tenantId/users/:userId/metadata
 * Tenant-admin metadata replacement for dashboard user management. This is
 * limited to the tenant membership metadata and never mutates global user data.
 */
user.patch("/me/tenants/:tenantId/users/:targetUserId/metadata", async (c) => {
  const tenantId = c.req.param("tenantId");
  const targetUserId = c.req.param("targetUserId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(targetUserId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid user id" }, 400);
  }
  const admin = await requireTenantAdminMfa(
    c,
    tenantId,
    "Tenant user metadata updates require recent MFA verification",
  );
  if (!admin.ok) return admin.response;

  const body = await safeJsonParse<{
    tenantCustomMetadata?: Record<string, unknown>;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  if (body.tenantCustomMetadata === undefined) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantCustomMetadata is required" },
      400,
    );
  }
  const metadataError = getTenantMetadataValidationError(
    body.tenantCustomMetadata,
  );
  if (metadataError)
    return c.json<ApiResponse>({ ok: false, error: metadataError }, 400);

  const db = getDb();
  const [existing] = await db
    .select({ customMetadata: userTenants.customMetadata })
    .from(userTenants)
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!existing)
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: admin.userId,
    action: "tenant.member.metadata.update.authorized",
    resourceType: "user",
    resourceId: targetUserId,
    metadata: { updatedTenant: true },
  });

  await db
    .update(userTenants)
    .set({ customMetadata: body.tenantCustomMetadata })
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.userId, targetUserId),
      ),
    );

  const [row] = await db
    .select(tenantAdminUserSelection())
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(
      and(
        eq(userTenants.tenantId, tenantId),
        eq(userTenants.userId, targetUserId),
      ),
    );

  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: admin.userId,
      action: "tenant.member.metadata.update",
      resourceType: "user",
      resourceId: targetUserId,
      metadata: { updatedTenant: true },
    });
  } catch (error) {
    await db
      .update(userTenants)
      .set({ customMetadata: existing.customMetadata })
      .where(
        and(
          eq(userTenants.tenantId, tenantId),
          eq(userTenants.userId, targetUserId),
        ),
      );
    throw error;
  }

  dispatchWebhook(tenantId, targetUserId, "user.updated_account", {
    userId: targetUserId,
    scope: "tenant",
    field: "tenantCustomMetadata",
  });
  return c.json<ApiResponse<TenantAdminUserRow>>({
    ok: true,
    data: row as TenantAdminUserRow,
  });
});

/**
 * PATCH /me/tenants/:tenantId/users/:userId/deactivate
 * Dashboard lifecycle control for app-scoped users. Because deactivatedAt is a
 * global user field, this refuses targets that also belong to another
 * non-personal tenant; cross-tenant lifecycle remains platform-key only.
 */
user.patch(
  "/me/tenants/:tenantId/users/:targetUserId/deactivate",
  async (c) => {
    const tenantId = c.req.param("tenantId");
    const targetUserId = c.req.param("targetUserId");
    if (!isValidTenantId(tenantId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid tenant id format" },
        400,
      );
    }
    if (!isValidUserId(targetUserId)) {
      return c.json<ApiResponse>({ ok: false, error: "Invalid user id" }, 400);
    }
    const admin = await requireTenantAdminMfa(
      c,
      tenantId,
      "Tenant user lifecycle changes require recent MFA verification",
    );
    if (!admin.ok) return admin.response;

    const body = await safeJsonParse<{ deactivated?: boolean }>(c);
    if (!body)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid JSON in request body" },
        400,
      );
    const deactivated = body.deactivated !== false;

    const db = getDb();
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: admin.userId,
      action: deactivated
        ? "tenant.member.deactivate.authorized"
        : "tenant.member.reactivate.authorized",
      resourceType: "user",
      resourceId: targetUserId,
    });

    const result = await db
      .transaction(async (tx) => {
        await lockTenantOwnerLifecycle(tx, tenantId);
        const [membership] = await tx
          .select({ role: userTenants.role })
          .from(userTenants)
          .where(
            and(
              eq(userTenants.tenantId, tenantId),
              eq(userTenants.userId, targetUserId),
            ),
          )
          .limit(1);
        if (!membership) return null;
        if (deactivated && membership.role === "owner") {
          if ((await activeTenantOwnerCount(tx, tenantId, targetUserId)) < 1) {
            throw new Error("Cannot deactivate the sole owner");
          }
        }

        const [otherTenantCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(userTenants)
          .where(
            and(
              eq(userTenants.userId, targetUserId),
              ne(userTenants.tenantId, tenantId),
              sql`${userTenants.tenantId} <> ${`personal-${targetUserId}`}`,
            ),
          );
        if (Number(otherTenantCount?.count ?? 0) > 0) {
          throw new Error(
            "Tenant dashboard lifecycle changes are limited to users without other tenant memberships",
          );
        }

        const [previous] = await tx
          .select({
            deactivatedAt: users.deactivatedAt,
            updatedAt: users.updatedAt,
          })
          .from(users)
          .where(eq(users.id, targetUserId))
          .limit(1);
        if (!previous) return null;

        const issuedBefore =
          await revocationStore.revokeUserTokens(targetUserId);
        await tx
          .update(users)
          .set({
            deactivatedAt: deactivated ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetUserId));
        await tx
          .delete(refreshTokens)
          .where(
            and(
              eq(refreshTokens.tenantId, tenantId),
              eq(refreshTokens.userId, targetUserId),
            ),
          );

        const [row] = await tx
          .select(tenantAdminUserSelection())
          .from(userTenants)
          .innerJoin(users, eq(userTenants.userId, users.id))
          .where(
            and(
              eq(userTenants.tenantId, tenantId),
              eq(userTenants.userId, targetUserId),
            ),
          );
        return { row, previous, issuedBefore };
      })
      .catch((err: unknown) => {
        if (err instanceof Error) {
          if (err.message === "Cannot deactivate the sole owner")
            return err.message;
          if (err.message.startsWith("Tenant dashboard lifecycle changes"))
            return err.message;
        }
        throw err;
      });

    if (typeof result === "string") {
      return c.json<ApiResponse>({ ok: false, error: result }, 409);
    }
    if (result === null || !result.row) {
      return c.json<ApiResponse>(
        { ok: false, error: "User not found in tenant" },
        404,
      );
    }

    try {
      await writeUserAudit(c, {
        tenantId,
        actorType: "user",
        actorId: admin.userId,
        action: deactivated
          ? "tenant.member.deactivate"
          : "tenant.member.reactivate",
        resourceType: "user",
        resourceId: targetUserId,
        metadata: { issuedBefore: result.issuedBefore },
      });
    } catch (error) {
      await db
        .update(users)
        .set({
          deactivatedAt: result.previous.deactivatedAt,
          updatedAt: result.previous.updatedAt,
        })
        .where(eq(users.id, targetUserId));
      throw error;
    }

    dispatchWebhook(tenantId, targetUserId, "user.updated_account", {
      userId: targetUserId,
      scope: "tenant",
      field: "deactivatedAt",
    });
    return c.json<ApiResponse<TenantAdminUserRow>>({
      ok: true,
      data: result.row,
    });
  },
);

/**
 * DELETE /me/tenants/:tenantId/users/:userId
 * Remove a user from the current tenant. This is the dashboard-safe app-level
 * delete equivalent; global hard-delete remains platform-key only.
 */
user.delete("/me/tenants/:tenantId/users/:targetUserId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const targetUserId = c.req.param("targetUserId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(targetUserId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid user id" }, 400);
  }
  const admin = await requireTenantAdminMfa(
    c,
    tenantId,
    "Tenant user removal requires recent MFA verification",
  );
  if (!admin.ok) return admin.response;
  if (admin.userId === targetUserId) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Use the tenant leave flow to remove your own membership",
      },
      400,
    );
  }

  const db = getDb();
  let member: { role: string } | null = null;
  try {
    member = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [current] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, targetUserId),
          ),
        );
      if (!current) return null;
      if (current.role === "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, targetUserId)) < 1) {
          throw new Error("Cannot remove the sole owner");
        }
      }
      return current;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot remove the sole owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }
  if (!member)
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: admin.userId,
    action: "tenant.member.remove.authorized",
    resourceType: "user",
    resourceId: targetUserId,
    metadata: { role: member.role },
  });

  let deleted: {
    membership: {
      id: string;
      userId: string;
      tenantId: string;
      role: string;
      customMetadata: Record<string, unknown>;
      createdAt: Date;
    };
    refreshTokens: Array<{
      id: string;
      userId: string;
      tenantId: string;
      tokenHash: string;
      expiresAt: Date;
      createdAt: Date;
    }>;
  } | null = null;
  try {
    deleted = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [current] = await tx
        .select({
          id: userTenants.id,
          userId: userTenants.userId,
          tenantId: userTenants.tenantId,
          role: userTenants.role,
          customMetadata: userTenants.customMetadata,
          createdAt: userTenants.createdAt,
        })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, targetUserId),
          ),
        );
      if (!current) return null;
      if (current.role === "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, targetUserId)) < 1) {
          throw new Error("Cannot remove the sole owner");
        }
      }
      const tokenSnapshot = await tx
        .select({
          id: refreshTokens.id,
          userId: refreshTokens.userId,
          tenantId: refreshTokens.tenantId,
          tokenHash: refreshTokens.tokenHash,
          expiresAt: refreshTokens.expiresAt,
          createdAt: refreshTokens.createdAt,
        })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tenantId, tenantId),
            eq(refreshTokens.userId, targetUserId),
          ),
        );
      await tx
        .delete(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, targetUserId),
          ),
        )
        .returning({ role: userTenants.role });
      await tx
        .delete(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tenantId, tenantId),
            eq(refreshTokens.userId, targetUserId),
          ),
        );
      return { membership: current, refreshTokens: tokenSnapshot };
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot remove the sole owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }
  if (!deleted)
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );

  const revokedBefore = await revocationStore.revokeUserTokens(targetUserId);
  try {
    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: admin.userId,
      action: "tenant.member.remove",
      resourceType: "user",
      resourceId: targetUserId,
      metadata: {
        role: deleted.membership.role,
        revokedUserTokensIssuedBefore: revokedBefore,
      },
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx
        .insert(userTenants)
        .values(deleted.membership)
        .onConflictDoNothing({
          target: [userTenants.userId, userTenants.tenantId],
        });
      if (deleted.refreshTokens.length > 0) {
        await tx
          .insert(refreshTokens)
          .values(deleted.refreshTokens)
          .onConflictDoNothing({ target: refreshTokens.tokenHash });
      }
    });
    throw error;
  }

  dispatchWebhook(tenantId, targetUserId, "user.updated_account", {
    userId: targetUserId,
    scope: "tenant",
    field: "tenantMembership",
  });
  return c.json<ApiResponse>({ ok: true });
});

/**
 * POST /me/tenants/:tenantId/invitations/accept
 * Accept a pending tenant invitation using a one-time token. The token is
 * scoped to the authenticated user's verified email and cannot grant owner.
 */
user.post("/me/tenants/:tenantId/invitations/accept", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const tenantId = c.req.param("tenantId");
  const body = await safeJsonParse<{ token?: string }>(c);

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (isReservedTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Personal tenants cannot be joined by invitation" },
      403,
    );
  }
  if (
    !body?.token ||
    typeof body.token !== "string" ||
    !/^[a-f0-9]{64}$/i.test(body.token)
  ) {
    return c.json<ApiResponse>({ ok: false, error: "token is required" }, 400);
  }

  const db = getDb();
  const [userRecord] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId));
  const email = userRecord?.email?.toLowerCase().trim();
  if (!email || !userRecord?.emailVerified) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Invitation acceptance requires a verified email session",
      },
      403,
    );
  }

  const tokenHash = hashSha256Hex(body.token);
  const [candidate] = await db
    .select({ id: tenantInvitations.id, role: tenantInvitations.role })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.email, email),
        eq(tenantInvitations.tokenHash, tokenHash),
        eq(tenantInvitations.status, "pending"),
        gte(tenantInvitations.expiresAt, new Date()),
      ),
    );
  if (!candidate) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired invitation" },
      404,
    );
  }

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "tenant.invitation.accept.authorized",
    resourceType: "tenant_invitation",
    resourceId: candidate.id,
    metadata: { email, role: candidate.role },
  });

  const accepted = await db.transaction(async (tx) => {
    const [existingMembership] = await tx
      .select({ role: userTenants.role })
      .from(userTenants)
      .where(
        and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
      )
      .limit(1);
    if (existingMembership) {
      return {
        id: candidate.id,
        role: existingMembership.role,
        alreadyMember: true,
      };
    }
    const [invitation] = await tx
      .update(tenantInvitations)
      .set({
        status: "accepted",
        acceptedByUserId: userId,
        acceptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tenantInvitations.id, candidate.id),
          eq(tenantInvitations.tenantId, tenantId),
          eq(tenantInvitations.email, email),
          eq(tenantInvitations.tokenHash, tokenHash),
          eq(tenantInvitations.status, "pending"),
          gte(tenantInvitations.expiresAt, new Date()),
        ),
      )
      .returning({ id: tenantInvitations.id, role: tenantInvitations.role });
    if (!invitation) return null;
    await tx
      .insert(userTenants)
      .values({ userId, tenantId, role: invitation.role })
      .onConflictDoNothing();
    return { ...invitation, alreadyMember: false };
  });
  if (!accepted) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired invitation" },
      404,
    );
  }

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "tenant.invitation.accept",
    resourceType: "tenant_invitation",
    resourceId: accepted.id,
    metadata: { email, role: accepted.role },
  });
  return c.json({
    ok: true,
    tenantId,
    role: accepted.role,
    invitationId: accepted.id,
    ...(accepted.alreadyMember ? { alreadyMember: true } : {}),
  });
});

/**
 * POST /me/tenants/:tenantId/join
 * Join a tenant that has join_mode = 'open'.
 */
user.post("/me/tenants/:tenantId/join", async (c) => {
  const personalSessionResponse = requirePersonalUserSession(c);
  if (personalSessionResponse) return personalSessionResponse;
  const userId = c.get("userId");
  const tenantId = c.req.param("tenantId");
  const db = getDb();

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (isReservedTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Personal tenants cannot be self-joined" },
      403,
    );
  }

  // 1. Verify tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  // 2. Check if already a member
  const [existing] = await db
    .select({ id: userTenants.id })
    .from(userTenants)
    .where(
      and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
    );

  if (existing) {
    return c.json({ ok: true, tenantId, role: "member", alreadyMember: true });
  }

  // 3. Check join_mode
  const [config] = await db
    .select({ joinMode: tenantConfigs.joinMode })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  const joinMode = config?.joinMode;

  if (joinMode === "invite") {
    const body = await safeJsonParse<{ token?: string }>(c);
    if (
      !body?.token ||
      typeof body.token !== "string" ||
      !/^[a-f0-9]{64}$/i.test(body.token)
    ) {
      return c.json<ApiResponse>(
        { ok: false, error: "Tenant invitation token is required to join" },
        403,
      );
    }

    const [userRecord] = await db
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId));
    const email = userRecord?.email?.toLowerCase().trim();
    if (!email || !userRecord?.emailVerified) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Tenant invitation acceptance requires a verified email session",
        },
        403,
      );
    }

    const tokenHash = hashSha256Hex(body.token);
    const [candidate] = await db
      .select({ id: tenantInvitations.id, role: tenantInvitations.role })
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          eq(tenantInvitations.email, email),
          eq(tenantInvitations.tokenHash, tokenHash),
          eq(tenantInvitations.status, "pending"),
          gte(tenantInvitations.expiresAt, new Date()),
        ),
      );
    if (!candidate) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Tenant '${tenantId}' requires an invitation to join`,
        },
        403,
      );
    }

    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "tenant.member.accept_invite.authorized",
      resourceType: "tenant_invitation",
      resourceId: candidate.id,
      metadata: { email, role: candidate.role },
    });

    const accepted = await db.transaction(async (tx) => {
      const [invitation] = await tx
        .update(tenantInvitations)
        .set({
          status: "accepted",
          acceptedByUserId: userId,
          acceptedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tenantInvitations.id, candidate.id),
            eq(tenantInvitations.tenantId, tenantId),
            eq(tenantInvitations.email, email),
            eq(tenantInvitations.tokenHash, tokenHash),
            eq(tenantInvitations.status, "pending"),
            gte(tenantInvitations.expiresAt, new Date()),
          ),
        )
        .returning({ id: tenantInvitations.id, role: tenantInvitations.role });
      if (!invitation) return null;
      await tx
        .insert(userTenants)
        .values({ userId, tenantId, role: invitation.role })
        .onConflictDoNothing();
      return invitation;
    });
    if (!accepted) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Tenant '${tenantId}' requires an invitation to join`,
        },
        403,
      );
    }

    await writeUserAudit(c, {
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "tenant.member.accept_invite",
      resourceType: "tenant_invitation",
      resourceId: accepted.id,
      metadata: { email, role: accepted.role },
    });

    return c.json({ ok: true, tenantId, role: accepted.role });
  }

  if (joinMode !== "open") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: joinMode
          ? `Tenant is not open for joining (mode: ${joinMode})`
          : "Tenant is not configured for self-join",
      },
      403,
    );
  }

  await writeUserAudit(c, {
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "tenant.member.join",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { role: "member" },
  });
  // 4. Create membership
  await db
    .insert(userTenants)
    .values({ userId, tenantId, role: "member" })
    .onConflictDoNothing();

  return c.json({ ok: true, tenantId, role: "member" });
});

/**
 * DELETE /me/tenants/:tenantId/leave
 * Leave a tenant. Cannot leave personal tenant.
 */
user.delete("/me/tenants/:tenantId/leave", async (c) => {
  const userId = c.get("userId");
  const session = c.get("userSession");
  const tenantId = c.req.param("tenantId");

  if (!hasRecentMfaStepUp(session)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Leaving a tenant requires a recent MFA step-up session",
      },
      403,
    );
  }

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!sessionTenantMatches(session, tenantId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant leave requires a session scoped to the target tenant",
      },
      403,
    );
  }

  // Cannot leave personal tenant
  if (tenantId === `personal-${userId}`) {
    return c.json<ApiResponse>(
      { ok: false, error: "Cannot leave your personal tenant" },
      400,
    );
  }

  const db = getDb();
  let deletedMembership: { role: string } | null | undefined;
  try {
    deletedMembership = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      await lockUserSession(tx, userId);
      const [membership] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.userId, userId),
            eq(userTenants.tenantId, tenantId),
          ),
        );

      if (!membership) return null;
      if (membership.role === "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, userId)) < 1) {
          throw new Error("Cannot leave tenant as the sole owner");
        }
      }

      await writeUserAudit(c, {
        tenantId,
        actorType: "user",
        actorId: userId,
        action: "tenant.member.leave",
        resourceType: "tenant",
        resourceId: tenantId,
      });

      const [deleted] = await tx
        .delete(userTenants)
        .where(
          and(
            eq(userTenants.userId, userId),
            eq(userTenants.tenantId, tenantId),
          ),
        )
        .returning({ role: userTenants.role });
      await tx
        .delete(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tenantId, tenantId),
            eq(refreshTokens.userId, userId),
          ),
        );
      return deleted ?? null;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot leave tenant as the sole owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }

  if (!deletedMembership) {
    return c.json<ApiResponse>(
      { ok: false, error: "Not a member of this tenant" },
      404,
    );
  }

  return c.json<ApiResponse>({ ok: true });
});

export { user as userRoutes };
