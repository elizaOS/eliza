/**
 * Authorizes the staging-only API-key-to-browser-session bridge against
 * primary Cloud identity state. It never creates or repairs identities: a
 * source key, active user and organization, matching Steward projection, and
 * pre-existing tenant mapping must all already exist.
 */

import { apiKeysRepository, appsRepository, usersRepository } from "../../db/repositories";
import type { ApiKey } from "../../db/repositories/api-keys";
import { ssoBridgeRepository } from "../../db/repositories/sso-bridge";
import type { UserWithOrganization } from "../../db/repositories/users";
import { sha256Hex } from "../crypto/worker";
import { timingSafeEqualSecret } from "./cron";

export const STAGING_SESSION_EXCHANGE_VERSION = "v1" as const;
export const STAGING_SESSION_TOKEN_TYP = "eliza-staging-session+jwt";
export const STAGING_SESSION_MAX_TTL_SECONDS = 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const SIGNING_KEY_ID_RE = /^staging-qa-v1-[A-Za-z0-9._-]{1,48}$/;
const CREDENTIAL_FINGERPRINT_DOMAIN = "eliza:staging-session-exchange:v1:api-key-generation";

export interface StagingSessionBinding {
  version: typeof STAGING_SESSION_EXCHANGE_VERSION;
  apiKeyId: string;
  cloudUserId: string;
  organizationId: string;
  /** HMAC of (key id, current key hash); changes when the row is regenerated. */
  credentialFingerprint: string;
  /** Absolute session window. Re-minting can never move either bound. */
  sessionIssuedAt: number;
  sessionMaxExpiresAt: number;
}

export interface StagingSessionBindingEnv {
  NODE_ENV?: string;
  ENVIRONMENT?: string;
  STEWARD_TENANT_ID?: string;
  STEWARD_JWT_SECRET?: string;
  STEWARD_SESSION_SECRET?: string;
  ELIZA_SERVICE_JWT_SECRET?: string;
  STAGING_SESSION_EXCHANGE_ENABLED?: string;
  STAGING_SESSION_EXCHANGE_VERSION?: string;
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET?: string;
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID?: string;
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS?: string;
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS?: string;
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS?: string;
}

export interface StagingSessionSigningConfig {
  secret: string;
  keyId: string;
}

export interface ExistingStagingSessionSubject {
  binding: StagingSessionBinding;
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
  tenantId: string;
  issuedAt: number;
  expiration: number;
}

export class StagingSessionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingSessionConfigurationError";
  }
}

export class StagingSessionEligibilityError extends Error {
  readonly reason:
    | "source_key"
    | "allowlist"
    | "user"
    | "organization"
    | "steward_identity"
    | "tenant";

  constructor(reason: StagingSessionEligibilityError["reason"]) {
    super("Staging session subject is not eligible");
    this.name = "StagingSessionEligibilityError";
    this.reason = reason;
  }
}

function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

function parseExactUuidAllowlist(raw: string | undefined, label: string): Set<string> {
  const values = raw
    ?.split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values || values.length === 0) {
    throw new StagingSessionConfigurationError(`${label} is missing`);
  }
  if (values.length > 100 || values.some((value) => value === "*" || !UUID_RE.test(value))) {
    throw new StagingSessionConfigurationError(`${label} must contain 1-100 exact UUIDs only`);
  }
  return new Set(values.map(normalizeUuid));
}

function readTenantId(env: StagingSessionBindingEnv): string {
  const tenantId = env.STEWARD_TENANT_ID?.trim();
  if (!tenantId) {
    throw new StagingSessionConfigurationError("STEWARD_TENANT_ID is missing");
  }
  return tenantId;
}

export function readStagingSessionSigningConfig(
  env: StagingSessionBindingEnv,
): StagingSessionSigningConfig {
  const secret = env.STAGING_SESSION_EXCHANGE_SIGNING_SECRET?.trim();
  const keyId = env.STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID?.trim();
  if (!secret || secret.length < 32) {
    throw new StagingSessionConfigurationError(
      "STAGING_SESSION_EXCHANGE_SIGNING_SECRET is missing or too short",
    );
  }
  if (!keyId || !SIGNING_KEY_ID_RE.test(keyId)) {
    throw new StagingSessionConfigurationError(
      "STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID is invalid",
    );
  }

  // A dedicated key is the rollback boundary: an older Steward-only verifier
  // must be cryptographically unable to accept a QA token whose custom claims
  // it does not know how to revalidate.
  if (
    secret === env.STEWARD_JWT_SECRET?.trim() ||
    secret === env.STEWARD_SESSION_SECRET?.trim() ||
    secret === env.ELIZA_SERVICE_JWT_SECRET?.trim()
  ) {
    throw new StagingSessionConfigurationError("staging session signing key must be dedicated");
  }
  return { secret, keyId };
}

export function isStagingSessionSigningConfigured(env: StagingSessionBindingEnv): boolean {
  try {
    readStagingSessionSigningConfig(env);
    return true;
  } catch (error) {
    if (error instanceof StagingSessionConfigurationError) return false;
    throw error;
  }
}

export function isStagingSessionExchangeEnabled(env: StagingSessionBindingEnv): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.ENVIRONMENT === "staging" &&
    env.STAGING_SESSION_EXCHANGE_ENABLED === "true" &&
    env.STAGING_SESSION_EXCHANGE_VERSION === STAGING_SESSION_EXCHANGE_VERSION
  );
}

function readAllowlists(env: StagingSessionBindingEnv): {
  apiKeyIds: Set<string>;
  userIds: Set<string>;
  organizationIds: Set<string>;
} {
  return {
    apiKeyIds: parseExactUuidAllowlist(
      env.STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS,
      "STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS",
    ),
    userIds: parseExactUuidAllowlist(
      env.STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS,
      "STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS",
    ),
    organizationIds: parseExactUuidAllowlist(
      env.STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS,
      "STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS",
    ),
  };
}

function isRealStewardUserId(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    ![
      "system:",
      "anonymous:",
      "affiliate:",
      "wallet:",
      "email:",
      "telegram:",
      "discord:",
      "phone:",
      "whatsapp:",
      "svc_",
    ].some((prefix) => normalized.startsWith(prefix))
  );
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function credentialFingerprint(
  secret: string,
  apiKey: Pick<ApiKey, "id" | "key_hash">,
): Promise<string> {
  if (!HEX_64_RE.test(apiKey.key_hash)) {
    throw new StagingSessionEligibilityError("source_key");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(
    `${CREDENTIAL_FINGERPRINT_DOMAIN}\0${apiKey.id}\0${apiKey.key_hash}`,
  );
  return hex(await crypto.subtle.sign("HMAC", key, message));
}

async function hashPresentedApiKey(apiKey: string): Promise<string> {
  return sha256Hex(apiKey);
}

interface ExistingStagingSessionSubjectInput {
  env: StagingSessionBindingEnv;
  apiKeyId: string;
  expectedCloudUserId?: string;
  expectedOrganizationId?: string;
  now?: Date;
}

type SourceCredentialProof =
  | { kind: "binding_revalidation" }
  | { kind: "mint"; presentedApiKeyHash: string };

async function loadExistingStagingSessionSubject(
  input: ExistingStagingSessionSubjectInput,
  sourceCredentialProof: SourceCredentialProof,
): Promise<ExistingStagingSessionSubject> {
  if (!isStagingSessionExchangeEnabled(input.env)) {
    throw new StagingSessionConfigurationError("staging session exchange is disabled");
  }

  const signing = readStagingSessionSigningConfig(input.env);
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const tenantId = readTenantId(input.env);
  const allowlists = readAllowlists(input.env);
  const apiKey = await apiKeysRepository.findActiveByIdConsistent(input.apiKeyId, now);

  if (!apiKey) throw new StagingSessionEligibilityError("source_key");
  if (
    sourceCredentialProof.kind === "mint" &&
    (!HEX_64_RE.test(apiKey.key_hash) ||
      !timingSafeEqualSecret(
        sourceCredentialProof.presentedApiKeyHash,
        apiKey.key_hash.toLowerCase(),
      ))
  ) {
    // The ordinary API-key gate may have returned a 10-minute cached row for
    // this id. Mint authority comes only from the raw credential matching the
    // CURRENT primary row, so rotation cannot upgrade a stale cached key into
    // a session bound to the new generation.
    throw new StagingSessionEligibilityError("source_key");
  }
  if (
    (input.expectedCloudUserId && apiKey.user_id !== input.expectedCloudUserId) ||
    (input.expectedOrganizationId && apiKey.organization_id !== input.expectedOrganizationId)
  ) {
    throw new StagingSessionEligibilityError("source_key");
  }
  if (
    !allowlists.apiKeyIds.has(normalizeUuid(apiKey.id)) ||
    !allowlists.userIds.has(normalizeUuid(apiKey.user_id)) ||
    !allowlists.organizationIds.has(normalizeUuid(apiKey.organization_id))
  ) {
    throw new StagingSessionEligibilityError("allowlist");
  }
  if (await appsRepository.findByApiKeyIdForWrite(apiKey.id)) {
    // App credentials share the api_keys table but intentionally carry a
    // narrower capability than a full Cloud user session. Even an operator
    // accidentally adding one to the QA allowlist must not widen its scope.
    throw new StagingSessionEligibilityError("source_key");
  }
  if (apiKey.name.startsWith("agent-sandbox:")) {
    // Provisioner-managed inference credentials are tied to one sandbox and
    // may never be promoted into a browser session, even by config mistake.
    throw new StagingSessionEligibilityError("source_key");
  }

  const user = await usersRepository.findWithOrganizationForWrite(apiKey.user_id);
  if (
    !user ||
    !user.is_active ||
    user.is_anonymous ||
    user.deleted_at !== null ||
    (user.expires_at !== null && user.expires_at.getTime() <= now.getTime()) ||
    user.organization_id !== apiKey.organization_id
  ) {
    throw new StagingSessionEligibilityError("user");
  }
  if (!user.organization || !user.organization.is_active) {
    throw new StagingSessionEligibilityError("organization");
  }

  const stewardUserId = user.steward_user_id.trim();
  if (!isRealStewardUserId(stewardUserId)) {
    throw new StagingSessionEligibilityError("steward_identity");
  }
  const identity = await usersRepository.findIdentityByStewardIdForWrite(stewardUserId);
  if (!identity || identity.user_id !== user.id || identity.steward_user_id !== stewardUserId) {
    throw new StagingSessionEligibilityError("steward_identity");
  }

  const organizationTenantId = user.organization.steward_tenant_id?.trim();
  if (!organizationTenantId || organizationTenantId !== tenantId) {
    throw new StagingSessionEligibilityError("tenant");
  }

  const apiKeyExpiresAt = apiKey.expires_at
    ? Math.floor(new Date(apiKey.expires_at).getTime() / 1000)
    : Number.POSITIVE_INFINITY;
  const expiration = Math.min(nowSeconds + STAGING_SESSION_MAX_TTL_SECONDS, apiKeyExpiresAt);
  if (expiration <= nowSeconds) {
    throw new StagingSessionEligibilityError("source_key");
  }

  const walletChain =
    user.wallet_chain_type === "ethereum" || user.wallet_chain_type === "solana"
      ? user.wallet_chain_type
      : undefined;

  return {
    binding: {
      version: STAGING_SESSION_EXCHANGE_VERSION,
      apiKeyId: apiKey.id,
      cloudUserId: user.id,
      organizationId: user.organization.id,
      credentialFingerprint: await credentialFingerprint(signing.secret, apiKey),
      sessionIssuedAt: nowSeconds,
      sessionMaxExpiresAt: expiration,
    },
    stewardUserId,
    ...(user.email ? { email: user.email } : {}),
    ...(user.wallet_address ? { walletAddress: user.wallet_address } : {}),
    ...(walletChain ? { walletChain } : {}),
    tenantId,
    issuedAt: nowSeconds,
    expiration,
  };
}

/**
 * Resolves the Cloud user named by an already-verified QA binding directly
 * from primary storage. Callers must use this instead of Steward-id caches or
 * JIT synchronization so a relinked identity can never change the user/org
 * authorized by the signed binding between verification and route handling.
 */
export async function loadVerifiedStagingSessionUser(input: {
  binding: StagingSessionBinding;
  stewardUserId: string;
  now?: Date;
}): Promise<UserWithOrganization | null> {
  const now = input.now ?? new Date();
  const user = await usersRepository.findWithOrganizationForWrite(input.binding.cloudUserId);
  if (
    !user ||
    !user.is_active ||
    user.is_anonymous ||
    user.deleted_at !== null ||
    (user.expires_at !== null && user.expires_at.getTime() <= now.getTime()) ||
    user.organization_id !== input.binding.organizationId ||
    !user.organization ||
    !user.organization.is_active ||
    user.organization.id !== input.binding.organizationId ||
    user.steward_user_id.trim() !== input.stewardUserId
  ) {
    return null;
  }
  return user;
}

/**
 * Loads a mint subject only after the raw credential presented on this request
 * hashes to the current primary API-key row. The raw key is neither returned
 * nor persisted in the exchange code or session binding.
 */
export async function loadExistingStagingSessionSubjectForMint(
  input: ExistingStagingSessionSubjectInput & { presentedApiKey: string },
): Promise<ExistingStagingSessionSubject> {
  const { presentedApiKey, ...subjectInput } = input;
  return await loadExistingStagingSessionSubject(subjectInput, {
    kind: "mint",
    presentedApiKeyHash: await hashPresentedApiKey(presentedApiKey),
  });
}

/**
 * Revalidates a signed staging-session binding for every token verification.
 * This deliberately bypasses replica and API-key caches, so regenerating or
 * revoking the source key, deactivating the user/org, changing either
 * allowlist, disabling the route, or logging out invalidates the session.
 */
export async function validateStagingSessionBinding(input: {
  env: StagingSessionBindingEnv;
  binding: StagingSessionBinding;
  stewardUserId: string;
  tenantId: string | undefined;
  issuedAt: number;
  expiration: number;
  now?: Date;
}): Promise<boolean> {
  if (!isStagingSessionExchangeEnabled(input.env)) return false;
  try {
    readStagingSessionSigningConfig(input.env);
  } catch (error) {
    if (error instanceof StagingSessionConfigurationError) return false;
    throw error;
  }
  if (
    input.binding.version !== STAGING_SESSION_EXCHANGE_VERSION ||
    !UUID_RE.test(input.binding.apiKeyId) ||
    !UUID_RE.test(input.binding.cloudUserId) ||
    !UUID_RE.test(input.binding.organizationId) ||
    !HEX_64_RE.test(input.binding.credentialFingerprint)
  ) {
    return false;
  }

  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const absoluteWindow = input.binding.sessionMaxExpiresAt - input.binding.sessionIssuedAt;
  if (
    !Number.isInteger(input.binding.sessionIssuedAt) ||
    !Number.isInteger(input.binding.sessionMaxExpiresAt) ||
    input.binding.sessionIssuedAt > nowSeconds + 5 ||
    absoluteWindow <= 0 ||
    absoluteWindow > STAGING_SESSION_MAX_TTL_SECONDS ||
    input.binding.sessionMaxExpiresAt <= nowSeconds ||
    !Number.isInteger(input.issuedAt) ||
    !Number.isInteger(input.expiration) ||
    input.issuedAt < input.binding.sessionIssuedAt ||
    input.issuedAt > nowSeconds + 5 ||
    input.expiration <= input.issuedAt ||
    input.expiration > input.binding.sessionMaxExpiresAt
  ) {
    return false;
  }

  let subject: ExistingStagingSessionSubject;
  try {
    subject = await loadExistingStagingSessionSubject(
      {
        env: input.env,
        apiKeyId: input.binding.apiKeyId,
        expectedCloudUserId: input.binding.cloudUserId,
        expectedOrganizationId: input.binding.organizationId,
        now,
      },
      { kind: "binding_revalidation" },
    );
  } catch (error) {
    if (
      error instanceof StagingSessionConfigurationError ||
      error instanceof StagingSessionEligibilityError
    ) {
      return false;
    }
    throw error;
  }

  if (
    subject.stewardUserId !== input.stewardUserId ||
    subject.tenantId !== input.tenantId ||
    subject.binding.credentialFingerprint !== input.binding.credentialFingerprint ||
    input.binding.sessionMaxExpiresAt > subject.expiration
  ) {
    return false;
  }

  const marker = await ssoBridgeRepository.getLogoutMarkerForWrite(input.stewardUserId);
  if (marker && input.binding.sessionIssuedAt * 1000 <= marker.logged_out_at.getTime()) {
    return false;
  }
  return true;
}
