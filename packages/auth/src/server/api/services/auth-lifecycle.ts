/** Owns login stores and configuration-dependent providers across runtime restarts. */
import { randomBytes } from "node:crypto";
import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import {
  ACCESS_TOKEN_EXPIRY,
  buildBackend,
  ChallengeStore,
  EmailAuth,
  type EmailAuthConfig,
  hashSha256Hex,
  isDevSecretAllowed,
  type MagicLinkTemplateData,
  type ManagedSmsOtpProvider,
  MemoryBackend,
  MockEmailProvider,
  MockSmsProvider,
  magicLinkTemplateValues,
  type OtpTemplateData,
  otpTemplateValues,
  PasskeyAuth,
  PhoneAuth,
  ResendProvider,
  renderCustomTemplate,
  SmsChallengeInProgressError,
  type SmsProvider,
  SmsVerificationNotAttemptedError,
  type StoreBackend,
  signAccessToken,
  TokenStore,
  TwilioSmsProvider,
  TwilioVerifyProvider,
} from "../../auth/index.ts";
import {
  type accounts,
  getDb,
  type TenantEmailConfig,
} from "../../db/index.ts";
import type {
  TenantAuthAbuseConfig,
  TenantTestAccountConfig,
} from "../../shared/index.ts";
import { runtimeEnvironmentValue } from "../../shared/runtime-env.ts";
import { KeyStore } from "../../wallet/index.ts";
import { defaultAuthTenantId } from "../services/default-auth-tenant";

export const SMS_VERIFY_MAX_FAILED_ATTEMPTS = 5;

const SMS_VERIFY_FAILED_ATTEMPT_TTL_MS = 10 * 60 * 1000;

function smsVerifyAttemptKey(phone: string, purpose: string): string {
  return `sms-verify-attempts:${hashSha256Hex(`${purpose}:${phone}`)}`;
}

export function smsVerifyAttemptSlotKey(
  phone: string,
  purpose: string,
  slot: number,
): string {
  return `${smsVerifyAttemptKey(phone, purpose)}:${slot}`;
}

type SmsVerifyAttemptClaim = {
  key: string;
  token: string;
};

/**
 * Atomically reserve one of the five verification-attempt slots. Using
 * set-if-absent slots keeps the limit correct under concurrent requests on
 * every shipped backend without relying on a read-then-write counter.
 */
export async function claimSmsVerifyAttempt(
  phone: string,
  purpose: string,
): Promise<SmsVerifyAttemptClaim | null> {
  for (let slot = 1; slot <= SMS_VERIFY_MAX_FAILED_ATTEMPTS; slot++) {
    const key = smsVerifyAttemptSlotKey(phone, purpose, slot);
    const token = `sms-verify-attempt:${randomBytes(16).toString("hex")}`;
    if (
      await getMfaBackend().setIfNotExists(
        key,
        token,
        SMS_VERIFY_FAILED_ATTEMPT_TTL_MS,
      )
    ) {
      return { key, token };
    }
  }
  return null;
}

/** Release only the exact slot generation claimed by this request. */
async function releaseSmsVerifyAttempt(
  claim: SmsVerifyAttemptClaim,
): Promise<boolean> {
  try {
    return await getMfaBackend().compareDelete(claim.key, claim.token);
  } catch {
    // Rollback is best-effort and generation-exact. A storage outage keeps the
    // slot consumed (fail closed) without replacing the original provider error.
    return false;
  }
}

/**
 * Roll back claim-first accounting only when no provider check could have run.
 * Timeout/5xx/malformed outcomes retain the slot because the remote service may
 * already have evaluated the guess.
 */
export async function releaseUnattemptedSmsVerifyClaim(
  claim: SmsVerifyAttemptClaim,
  error: unknown,
): Promise<boolean> {
  if (
    !(error instanceof SmsChallengeInProgressError) &&
    !(error instanceof SmsVerificationNotAttemptedError)
  ) {
    return false;
  }
  return releaseSmsVerifyAttempt(claim);
}

export async function clearSmsVerifyFailures(
  phone: string,
  purpose: string,
): Promise<void> {
  await Promise.all(
    Array.from({ length: SMS_VERIFY_MAX_FAILED_ATTEMPTS }, (_, index) =>
      getMfaBackend().delete(
        smsVerifyAttemptSlotKey(phone, purpose, index + 1),
      ),
    ),
  );
}

export function bootstrapRows<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] } | null)?.rows ?? [])
  ) as T[];
}

type AuthTenantConfigSubject = {
  auth_abuse_config: TenantAuthAbuseConfig;
  allowed_origins: string[];
  email_config: TenantEmailConfig | null;
  oidc_providers: unknown;
  test_account: TenantTestAccountConfig;
  allowed_redirect_urls: string[];
};

type AuthAppClientSubject = {
  id: string;
  allowed_redirect_urls: string[];
  login_methods: TenantAuthAbuseConfig["loginMethods"] | null;
  allowed_bundle_ids: string[];
  allowed_package_names: string[];
};

export async function authTenantConfigSubject(
  tenantId: string,
): Promise<AuthTenantConfigSubject | null> {
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_tenant_config_subject(${tenantId})`,
  );
  return bootstrapRows<AuthTenantConfigSubject>(result)[0] ?? null;
}

export async function authAppClientSubjects(
  tenantId: string,
): Promise<AuthAppClientSubject[]> {
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_app_clients_subject(${tenantId})`,
  );
  return bootstrapRows<AuthAppClientSubject>(result);
}

export async function createSessionToken(
  address: string,
  tenantId: string,
  extra?: Record<string, unknown>,
  expiresIn: string = ACCESS_TOKEN_EXPIRY,
): Promise<string> {
  return signAccessToken({ address, tenantId, ...extra }, expiresIn);
}

let _nonceBackend: import("../../auth/index.ts").StoreBackend | null = null;

export function getNonceBackend(): import("../../auth/index.ts").StoreBackend {
  if (_nonceBackend) return _nonceBackend;
  // Lazily fall back to a fresh in-memory backend if initAuthStores() hasn't
  // been called yet (e.g. tests or Workers cold-boot before middleware runs).
  // initAuthStores() will replace this with a Redis or Postgres-backed one.
  // Imported via require to avoid a circular dep with @stwd/auth at module init.
  const { MemoryBackend } =
    require("../../auth/index.ts") as typeof import("../../auth/index.ts");
  _nonceBackend = new MemoryBackend();
  return _nonceBackend;
}

// ─── PasskeyAuth singleton ────────────────────────────────────────────────────

// ─── Store backend initialization ────────────────────────────────────────────

let _challengeStore: ChallengeStore | null = null;

let _tokenStore: TokenStore | null = null;

let _oauthCodeStore: ChallengeStore | null = null;

let _mfaBackend: StoreBackend | null = null;

let _importSessionBackend: StoreBackend | null = null;

let _authStoreSources: AuthStoreSources = {
  challenge: "memory",
  token: "memory",
  siweNonce: "memory",
  mfa: "memory",
  importSession: "memory",
};

let _phoneAuth: PhoneAuth | null = null;

type AuthStoreSource = "redis" | "postgres" | "pglite" | "memory";

type AuthStoreSources = {
  challenge: AuthStoreSource;
  token: AuthStoreSource;
  siweNonce: AuthStoreSource;
  mfa: AuthStoreSource;
  importSession: AuthStoreSource;
};

/**
 * One-time OAuth nonce-exchange codes (response_type=code) live for 60s —
 * long enough for the user's browser to redirect back and the caller's
 * backend to POST the code to /oauth/exchange, short enough that a captured
 * code in an access log or Referer leak is useless by the time anyone reads
 * it. Codes are single-use (consume() deletes on first read).
 */
export const OAUTH_CODE_TTL_MS = 60 * 1000;

/**
 * Initialize auth token/challenge stores with the best available backend.
 * Call this during server startup AFTER initRedis() has been called.
 *
 * @param usePostgres  Pass true if the DB connection is known to be available.
 */
export async function initAuthStores(usePostgres = false): Promise<void> {
  releaseAuthStores();
  const { getRedisClient } = await import("../middleware/redis.js");
  const redisClient = getRedisClient();

  const [
    { backend: challengeBackend, source: challengeSource },
    { backend: tokenBackend, source: tokenSource },
    { backend: nonceBackend, source: nonceSource },
    { backend: mfaBackend, source: mfaSource },
    { backend: importSessionBackend, source: importSessionSource },
  ] = await Promise.all([
    buildBackend("challenge", redisClient, usePostgres),
    buildBackend("token", redisClient, usePostgres),
    buildBackend("siwe-nonce", redisClient, usePostgres),
    buildBackend("mfa", redisClient, usePostgres),
    buildBackend("import-session", redisClient, usePostgres),
  ]);

  logger.info(
    {
      details: [
        `[steward:auth] challenge store: ${challengeSource}, token store: ${tokenSource}, ` +
          `siwe-nonce store: ${nonceSource}, mfa store: ${mfaSource}, ` +
          `import-session store: ${importSessionSource}`,
      ],
    },
    "[Login:auth] info",
  );

  _challengeStore = new ChallengeStore({ backend: challengeBackend });
  _tokenStore = new TokenStore({ backend: tokenBackend });
  _nonceBackend = nonceBackend;
  _mfaBackend = mfaBackend;
  _authStoreSources = {
    challenge: challengeSource,
    token: tokenSource,
    siweNonce: nonceSource,
    mfa: mfaSource,
    importSession: importSessionSource,
  };
  // Reuse the challenge backend (Redis when available) for OAuth nonce codes
  // so they survive worker restarts and round-robin between isolates. The
  // 60s TTL is enforced at write time by ChallengeStore.
  _oauthCodeStore = new ChallengeStore({
    backend: challengeBackend,
    ttlMs: OAUTH_CODE_TTL_MS,
  });
  // Verified-email grants share the challenge backend (Redis-backed in prod)
  // so an OTP verified on one worker can register a passkey on another.
  _emailGrantStore = new ChallengeStore({
    backend: challengeBackend,
    ttlMs: EMAIL_GRANT_TTL_MS,
  });
  _importSessionBackend = importSessionBackend;

  const { initUserLinkChallengeStores } = await import(
    "../services/account-link-stores.js"
  );
  initUserLinkChallengeStores(challengeBackend);

  // Reset singletons so they pick up the new stores on next use
  _passkeyAuth = null;
  _phoneAuth = null;
  _passkeyAuthByOrigin.clear();
  _emailAuthByTenant.clear();
}

export function getChallengeStore(): ChallengeStore {
  _challengeStore ??= new ChallengeStore();
  return _challengeStore;
}

export function getOAuthCodeStore(): ChallengeStore {
  _oauthCodeStore ??= new ChallengeStore({ ttlMs: OAUTH_CODE_TTL_MS });
  return _oauthCodeStore;
}

// ── Verified-email grants (Privy-style OTP signup) ──────────────────────────
//
// POST /email/otp/verify exchanges a correct 6-digit code for a short-lived,
// single-use grant proving ownership of {email, tenantId}. The passkey
// register endpoints accept this grant in place of a session so a BRAND-NEW
// user can go email -> code -> Touch ID without ever holding a session,
// while keeping unverified registration (account pre-hijack) impossible.

export const EMAIL_GRANT_TTL_MS = 5 * 60 * 1000;

let _emailGrantStore: ChallengeStore | null = null;

export function getEmailGrantStore(): ChallengeStore {
  _emailGrantStore ??= new ChallengeStore({ ttlMs: EMAIL_GRANT_TTL_MS });
  return _emailGrantStore;
}

export function emailGrantKey(grant: string): string {
  return `email-otp-grant:${hashSha256Hex(grant)}`;
}

export type EmailGrantScope = "personal" | "tenant";

/**
 * Test-only seam for exercising verified-email enrollment routes without
 * sending or scraping an OTP. Production grants are still issued exclusively
 * by /email/otp/verify.
 */
export async function _seedEmailGrantForTests(
  grant: string,
  email: string,
  tenantId: string,
  scope: EmailGrantScope = "tenant",
): Promise<void> {
  await getEmailGrantStore().set(
    emailGrantKey(grant),
    JSON.stringify({ email: email.toLowerCase().trim(), tenantId, scope }),
  );
}

function getTokenStore(): TokenStore {
  _tokenStore ??= new TokenStore();
  return _tokenStore;
}

export function getMfaBackend(): StoreBackend {
  if (_mfaBackend) return _mfaBackend;
  const { MemoryBackend } =
    require("../../auth/index.ts") as typeof import("../../auth/index.ts");
  _mfaBackend = new MemoryBackend();
  return _mfaBackend;
}

export function getImportSessionBackend(): StoreBackend {
  if (_importSessionBackend) return _importSessionBackend;
  const { MemoryBackend } =
    require("../../auth/index.ts") as typeof import("../../auth/index.ts");
  _importSessionBackend = new MemoryBackend();
  return _importSessionBackend;
}

function getAuthStoreSources(): AuthStoreSources {
  return { ..._authStoreSources };
}

/**
 * Refuse ephemeral auth state in production and Workers deployments. Losing or
 * partitioning challenge, token, nonce, MFA, or import-session state across
 * processes can break single-use guarantees. A single-instance deployment may
 * explicitly acknowledge that trade-off, but it must never happen silently.
 */
export function assertAuthStoresAreSafe(
  sources: AuthStoreSources = getAuthStoreSources(),
): void {
  const requiresDurableStores =
    process.env.NODE_ENV === "production" ||
    process.env.STEWARD_RUNTIME === "workers";
  if (
    !requiresDurableStores ||
    process.env.STEWARD_ALLOW_MEMORY_AUTH_STORES === "true"
  )
    return;

  const memoryStores = Object.entries(sources)
    .filter(([, source]) => source === "memory")
    .map(([name]) => name);
  if (memoryStores.length > 0) {
    throw new Error(
      `Durable auth storage is required; memory-backed stores: ${memoryStores.join(", ")}. ` +
        "Configure Redis/Postgres or explicitly set STEWARD_ALLOW_MEMORY_AUTH_STORES=true " +
        "for a single-instance deployment.",
    );
  }
}

export function encryptImportSessionJson(value: unknown): string {
  return JSON.stringify(getOAuthKeyStore().encrypt(JSON.stringify(value)));
}

export function decryptImportSessionJson<T>(value: string): T {
  const encrypted = JSON.parse(value) as {
    ciphertext: string;
    iv: string;
    tag: string;
    salt: string;
  };
  return JSON.parse(getOAuthKeyStore().decrypt(encrypted)) as T;
}

let _passkeyAuth: PasskeyAuth | null = null;

const _passkeyAuthByOrigin = new Map<string, PasskeyAuth>();

/**
 * Get PasskeyAuth for a specific origin (multi-tenant passkey support).
 * Derives rpID from the Origin header so passkeys work on waifu.fun,
 * elizacloud.ai, or any other tenant domain.
 *
 * Allowed origins: PASSKEY_ALLOWED_ORIGINS env (comma-separated),
 * defaults to PASSKEY_ORIGIN.
 *
 * rpID resolution rule (apex-folding):
 *   When the request hostname is a strict subdomain of an allowed origin's
 *   hostname (e.g. request `www.waifu.fun`, allowed `https://waifu.fun`),
 *   we use the SHORTER allowed hostname as rpID. This keeps a single
 *   credential valid across apex + www and avoids breaking users who
 *   registered under one form when their canonical host changes (e.g.
 *   apex 307s to www, or vice versa).
 *
 *   WebAuthn allows rpID to be any registrable suffix of the request
 *   origin hostname, and the resulting credential is then scoped to
 *   apex + all subdomains.
 */
function resolveRpID(
  requestHostname: string,
  allowedOrigins: string[],
  fallback: string,
): string {
  let best = requestHostname;
  for (const o of allowedOrigins) {
    let host: string;
    try {
      host = new URL(o).hostname;
    } catch {
      continue;
    }
    if (host === requestHostname) {
      // Exact match. Prefer shortest match seen so far so apex wins over www.
      if (host.length < best.length || best === requestHostname) best = host;
    } else if (
      requestHostname.endsWith(`.${host}`) &&
      // shortest match wins
      (best === requestHostname || host.length < best.length)
    ) {
      best = host;
    }
  }
  if (!best) return fallback;
  return best;
}

export function getPasskeyAuth(requestOrigin?: string): PasskeyAuth {
  const defaultRpID = process.env.PASSKEY_RP_ID || "eliza.app";
  const defaultOrigin = process.env.PASSKEY_ORIGIN || "https://eliza.app";
  const rpName = process.env.PASSKEY_RP_NAME || "elizaOS";

  // If no origin provided, use the default singleton
  if (!requestOrigin) {
    if (!_passkeyAuth) {
      const origins = (process.env.PASSKEY_ALLOWED_ORIGINS || defaultOrigin)
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      _passkeyAuth = new PasskeyAuth({
        rpName,
        rpID: defaultRpID,
        origin: origins.length > 1 ? origins : defaultOrigin,
        challengeStore: getChallengeStore(),
      });
    }
    return _passkeyAuth;
  }

  // Parse origin to get hostname
  let requestHostname: string;
  try {
    requestHostname = new URL(requestOrigin).hostname;
  } catch {
    return getPasskeyAuth(); // invalid origin, fall back to default
  }

  // Validate against allowed origins
  const allowed = (process.env.PASSKEY_ALLOWED_ORIGINS || defaultOrigin)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(requestOrigin) && requestHostname !== defaultRpID) {
    return getPasskeyAuth(); // not in allowed list, use default
  }

  // Apex-fold: if the request hostname is a subdomain of any allowed origin,
  // use the allowed origin's apex hostname as rpID so the credential is
  // shared across apex + all subdomains.
  const rpID = resolveRpID(requestHostname, allowed, defaultRpID);

  // Cache per rpID
  const cached = _passkeyAuthByOrigin.get(rpID);
  if (cached) return cached;

  // Origin list passed to PasskeyAuth covers all variants the browser may
  // present (apex + www) so SimpleWebAuthn accepts assertions from either.
  const acceptedOrigins = allowed.length > 0 ? allowed : [requestOrigin];

  const auth = new PasskeyAuth({
    rpName,
    rpID,
    origin: acceptedOrigins,
    challengeStore: getChallengeStore(),
  });
  _passkeyAuthByOrigin.set(rpID, auth);
  return auth;
}

// ─── EmailAuth cache ──────────────────────────────────────────────────────────

const _emailAuthByTenant = new Map<string, Promise<EmailAuth>>();

let _emailKeyStore: KeyStore | null = null;

let _oauthKeyStore: KeyStore | null = null;

function getEmailKeyStore(): KeyStore {
  if (_emailKeyStore) return _emailKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (!isDevSecretAllowed()) {
      throw new Error(
        "STEWARD_MASTER_PASSWORD is required. For local development only, set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev key.",
      );
    }
    _emailKeyStore = new KeyStore("dev-secret");
    return _emailKeyStore;
  }

  _emailKeyStore = new KeyStore(masterPassword);
  return _emailKeyStore;
}

export function getOAuthKeyStore(): KeyStore {
  if (_oauthKeyStore) return _oauthKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (!isDevSecretAllowed()) {
      throw new Error(
        "STEWARD_MASTER_PASSWORD is required to encrypt OAuth provider tokens. For local development only, set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev key.",
      );
    }
    _oauthKeyStore = new KeyStore("dev-secret");
    return _oauthKeyStore;
  }

  _oauthKeyStore = new KeyStore(masterPassword);
  return _oauthKeyStore;
}

type OAuthEncryptedTokenFields = Pick<
  typeof accounts.$inferInsert,
  | "accessTokenEncrypted"
  | "accessTokenIv"
  | "accessTokenTag"
  | "accessTokenSalt"
  | "refreshTokenEncrypted"
  | "refreshTokenIv"
  | "refreshTokenTag"
  | "refreshTokenSalt"
>;

export function encryptOAuthProviderTokens(
  accessToken: string,
  refreshToken?: string | null,
): OAuthEncryptedTokenFields {
  const keyStore = getOAuthKeyStore();
  const encryptedAccessToken = keyStore.encrypt(accessToken);
  const encryptedRefreshToken = refreshToken
    ? keyStore.encrypt(refreshToken)
    : null;

  return {
    accessTokenEncrypted: encryptedAccessToken.ciphertext,
    accessTokenIv: encryptedAccessToken.iv,
    accessTokenTag: encryptedAccessToken.tag,
    accessTokenSalt: encryptedAccessToken.salt,
    refreshTokenEncrypted: encryptedRefreshToken?.ciphertext ?? null,
    refreshTokenIv: encryptedRefreshToken?.iv ?? null,
    refreshTokenTag: encryptedRefreshToken?.tag ?? null,
    refreshTokenSalt: encryptedRefreshToken?.salt ?? null,
  };
}

export function isMockEmailEnabled(): boolean {
  if (
    process.env.EMAIL_PROVIDER === "mock" &&
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "EMAIL_PROVIDER=mock is forbidden in production. Unset EMAIL_PROVIDER or set RESEND_API_KEY.",
    );
  }
  return (
    process.env.EMAIL_PROVIDER === "mock" &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * Build EmailAuth renderer overrides from deployer-supplied raw templates
 * (tenant_configs.email_config.templates). Branded markup is instance CONFIG,
 * not repo code: when a tenant carries its own subject/text/html we render it
 * with {{placeholder}} substitution; otherwise fall through to the built-in
 * templateId resolution.
 */
function buildTemplateRenderers(templates: TenantEmailConfig["templates"]): {
  templateRenderer?: EmailAuthConfig["templateRenderer"];
  otpTemplateRenderer?: EmailAuthConfig["otpTemplateRenderer"];
} {
  if (!templates) return {};
  const magicLink = templates.magicLink;
  const otp = templates.otp;
  return {
    ...(magicLink
      ? {
          templateRenderer: (
            _templateId: string | undefined,
            data: MagicLinkTemplateData,
          ) => renderCustomTemplate(magicLink, magicLinkTemplateValues(data)),
        }
      : {}),
    ...(otp
      ? {
          otpTemplateRenderer: (
            _templateId: string | undefined,
            data: OtpTemplateData,
          ) => renderCustomTemplate(otp, otpTemplateValues(data)),
        }
      : {}),
  };
}

function globalEmailMagicLinkBaseUrl(): string {
  const emailBaseUrl = runtimeEnvironmentValue(
    "EMAIL_MAGIC_LINK_BASE_URL",
  )?.trim();
  if (emailBaseUrl) {
    const parsed = new URL(emailBaseUrl);
    const normalized = emailBaseUrl.replace(/\/$/, "");
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== normalized
    ) {
      throw new Error(
        "EMAIL_MAGIC_LINK_BASE_URL must be a credential-free HTTP(S) origin",
      );
    }
    return parsed.origin;
  }

  return (
    runtimeEnvironmentValue("APP_URL")?.trim().replace(/\/$/, "") ||
    "https://eliza.app"
  );
}

function globalEmailMagicLinkCallbackPath(): string | undefined {
  const callbackPath = runtimeEnvironmentValue(
    "EMAIL_MAGIC_LINK_CALLBACK_PATH",
  )?.trim();
  if (!callbackPath) return undefined;
  if (!callbackPath.startsWith("/") || callbackPath.startsWith("//")) {
    throw new Error(
      "EMAIL_MAGIC_LINK_CALLBACK_PATH must be a root-relative path",
    );
  }
  return callbackPath;
}

function globalEmailBrandName(): string | undefined {
  const brandName = runtimeEnvironmentValue("EMAIL_BRAND_NAME")?.trim();
  if (!brandName) return undefined;
  if (brandName.length > 100 || /[\r\n]/.test(brandName)) {
    throw new Error(
      "EMAIL_BRAND_NAME must be a single-line string of at most 100 characters",
    );
  }
  return brandName;
}

function buildGlobalEmailAuth(overrides?: {
  baseUrl?: string;
  callbackPath?: string;
  templateId?: string;
  brandName?: string;
  subjectOverride?: string;
  replyTo?: string;
  templates?: TenantEmailConfig["templates"];
}): EmailAuth {
  const resendKey = process.env.RESEND_API_KEY;
  // Mock takes precedence in non-production for deterministic e2e testing.
  const provider = isMockEmailEnabled()
    ? new MockEmailProvider()
    : resendKey
      ? new ResendProvider({
          apiKey: resendKey,
          from: process.env.EMAIL_FROM || "login@eliza.app",
        })
      : undefined;

  return new EmailAuth({
    from: process.env.EMAIL_FROM || "login@eliza.app",
    baseUrl:
      overrides?.baseUrl?.replace(/\/$/, "") || globalEmailMagicLinkBaseUrl(),
    callbackPath: overrides?.callbackPath || globalEmailMagicLinkCallbackPath(),
    provider,
    tokenStore: getTokenStore(),
    templateId: overrides?.templateId,
    brandName: overrides?.brandName || globalEmailBrandName(),
    subjectOverride: overrides?.subjectOverride,
    replyTo: overrides?.replyTo,
    ...buildTemplateRenderers(overrides?.templates),
  });
}

function parseEncryptedEmailApiKey(value: string): {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
} {
  const parsed = JSON.parse(value) as Partial<{
    ciphertext: string;
    iv: string;
    tag: string;
    salt: string;
  }>;

  if (!parsed.ciphertext || !parsed.iv || !parsed.tag || !parsed.salt) {
    throw new Error("Invalid tenant email config encryption payload");
  }

  return {
    ciphertext: parsed.ciphertext,
    iv: parsed.iv,
    tag: parsed.tag,
    salt: parsed.salt,
  };
}

async function loadTenantEmailConfig(
  tenantId: string,
): Promise<TenantEmailConfig | null> {
  return (await authTenantConfigSubject(tenantId))?.email_config ?? null;
}

async function createEmailAuthForTenant(tenantId: string): Promise<EmailAuth> {
  const emailConfig = await loadTenantEmailConfig(tenantId);

  // Per-tenant magic-link override: when a tenant supplies its own
  // `magicLinkBaseUrl` we build the link against that origin so the click
  // lands on the tenant's app (e.g. https://waifu.fun/auth/email/verify)
  // instead of Steward's built-in callback (which redirects to
  // EMAIL_AUTH_REDIRECT_BASE_URL and is hard-defaulted to elizacloud.ai).
  const magicLinkBaseUrl = emailConfig?.magicLinkBaseUrl;
  const callbackPath = magicLinkBaseUrl
    ? emailConfig?.magicLinkCallbackPath || "/auth/email/verify"
    : undefined; // let EmailAuth fall through to its DEFAULT_CALLBACK

  if (!emailConfig?.apiKeyEncrypted) {
    // No per-tenant Resend config (or only magic-link override) — use the
    // global env-backed provider but still honor the per-tenant magic-link
    // AND template overrides if present. Without the template pass-through a
    // tenant that sets only `templateId` (no own Resend key) silently got the
    // Steward-branded default email instead of its configured branding.
    return buildGlobalEmailAuth({
      baseUrl: magicLinkBaseUrl,
      callbackPath,
      templateId: emailConfig?.templateId,
      brandName: emailConfig?.brandName,
      subjectOverride: emailConfig?.subjectOverride,
      replyTo: emailConfig?.replyTo,
      templates: emailConfig?.templates,
    });
  }

  // We've already returned via buildGlobalEmailAuth above when apiKeyEncrypted
  // is missing, so it's safe to assume `emailConfig.from + apiKeyEncrypted`
  // are both present here.
  const from = emailConfig.from || process.env.EMAIL_FROM || "login@eliza.app";
  const provider =
    emailConfig.provider === "resend" && emailConfig.apiKeyEncrypted
      ? new ResendProvider({
          apiKey: getEmailKeyStore().decrypt(
            parseEncryptedEmailApiKey(emailConfig.apiKeyEncrypted),
          ),
          from,
          replyTo: emailConfig.replyTo,
        })
      : undefined;

  const baseUrl =
    magicLinkBaseUrl?.replace(/\/$/, "") || globalEmailMagicLinkBaseUrl();

  return new EmailAuth({
    from,
    baseUrl,
    callbackPath: callbackPath || globalEmailMagicLinkCallbackPath(),
    provider,
    tokenStore: getTokenStore(),
    templateId: emailConfig.templateId,
    brandName: emailConfig.brandName || globalEmailBrandName(),
    subjectOverride: emailConfig.subjectOverride,
    replyTo: emailConfig.replyTo,
    ...buildTemplateRenderers(emailConfig.templates),
  });
}

export async function getEmailAuthForTenant(
  tenantId: string,
): Promise<EmailAuth> {
  const cached = _emailAuthByTenant.get(tenantId);
  if (cached) return cached;

  const pending = createEmailAuthForTenant(tenantId).catch((error) => {
    _emailAuthByTenant.delete(tenantId);
    throw error;
  });
  _emailAuthByTenant.set(tenantId, pending);
  return pending;
}

export function invalidateEmailAuthForTenant(tenantId: string): void {
  _emailAuthByTenant.delete(tenantId);
}

export function getPhoneAuth(): PhoneAuth {
  if (_phoneAuth) return _phoneAuth;

  let provider: SmsProvider | undefined;
  let managedProvider: ManagedSmsOtpProvider | undefined;
  if (
    process.env.SMS_PROVIDER === "mock" &&
    process.env.NODE_ENV !== "production"
  ) {
    provider = new MockSmsProvider();
  } else {
    managedProvider = buildTwilioVerifyProviderFromEnvironment();
    if (
      !managedProvider &&
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM
    ) {
      provider = new TwilioSmsProvider({
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        from: process.env.TWILIO_FROM,
      });
    } else if (!managedProvider && process.env.NODE_ENV === "production") {
      throw new Error("SMS provider not configured");
    }
  }

  _phoneAuth = new PhoneAuth({
    provider,
    managedProvider,
    tokenStore: new TokenStore({ backend: getMfaBackend() }),
  });
  return _phoneAuth;
}

export function buildTwilioVerifyProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TwilioVerifyProvider | undefined {
  const verifyConfigured =
    env.TWILIO_VERIFY_SERVICE_SID !== undefined ||
    env.TWILIO_VERIFY_TOKEN_TTL_SECONDS !== undefined;
  if (!verifyConfigured) return undefined;
  return new TwilioVerifyProvider({
    accountSid: env.TWILIO_ACCOUNT_SID ?? "",
    authToken: env.TWILIO_AUTH_TOKEN ?? "",
    serviceSid: env.TWILIO_VERIFY_SERVICE_SID ?? "",
    tokenTtlSeconds: Number(env.TWILIO_VERIFY_TOKEN_TTL_SECONDS),
  });
}

const OAUTH_REDIRECT_ALLOWLIST_ENV_KEYS = [
  "STEWARD_OAUTH_ALLOWED_REDIRECTS",
  "STEWARD_OAUTH_REDIRECT_ALLOWLIST",
] as const;

function parseOAuthRedirectAllowlistEnv(): string[] {
  const entries = new Set<string>();

  for (const envName of OAUTH_REDIRECT_ALLOWLIST_ENV_KEYS) {
    const raw = process.env[envName];
    if (!raw) continue;

    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed && trimmed !== "*") {
        entries.add(trimmed);
      }
    }
  }

  return [...entries];
}

function parseOAuthRedirectUri(redirectUri: string): URL {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    throw new Error("redirect_uri must be a valid absolute URL");
  }

  if (redirectUrl.protocol === "http:") {
    const host = redirectUrl.hostname.toLowerCase();
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLoopback) {
      throw new Error(
        "redirect_uri must use https except for loopback development origins",
      );
    }
  } else if (redirectUrl.protocol !== "https:") {
    throw new Error("redirect_uri must use https");
  }

  if (redirectUrl.username || redirectUrl.password) {
    throw new Error("redirect_uri must not contain credentials");
  }

  return redirectUrl;
}

function isOAuthRedirectEntryMatch(
  redirectUrl: URL,
  allowedEntry: string,
): boolean {
  let allowedUrl: URL;
  try {
    allowedUrl = new URL(allowedEntry);
  } catch {
    return false;
  }

  if (allowedUrl.protocol !== "https:" && allowedUrl.protocol !== "http:") {
    return false;
  }

  const isOriginOnly =
    allowedUrl.pathname === "/" &&
    !allowedUrl.search &&
    !allowedUrl.hash &&
    !allowedUrl.username;

  if (isOriginOnly) {
    return (
      allowedUrl.origin === redirectUrl.origin &&
      redirectUrl.pathname === "/" &&
      !redirectUrl.search &&
      !redirectUrl.hash
    );
  }

  return (
    allowedUrl.origin === redirectUrl.origin &&
    allowedUrl.pathname === redirectUrl.pathname &&
    allowedUrl.search === redirectUrl.search
  );
}

export function normalizePublicClientId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,63}$/.test(id) ? id : undefined;
}

async function getAllowedOAuthRedirectEntries(
  tenantId?: string,
  clientId?: string,
): Promise<string[]> {
  const explicitTenantId = tenantId?.trim() || undefined;
  const resolvedTenantId = explicitTenantId || defaultAuthTenantId();
  const entries = new Set<string>();

  const normalizedClientId = normalizePublicClientId(clientId);
  const appClientRows = await authAppClientSubjects(resolvedTenantId);

  if (normalizedClientId) {
    const client = appClientRows.find(
      (candidate) => candidate.id === normalizedClientId,
    );
    if (client) {
      for (const entry of client.allowed_redirect_urls ?? []) {
        const trimmed = entry.trim();
        if (trimmed && trimmed !== "*") entries.add(trimmed);
      }
    }
    return [...entries];
  }

  const config = await authTenantConfigSubject(resolvedTenantId);
  for (const entry of config?.allowed_redirect_urls ?? []) {
    const trimmed = entry.trim();
    if (trimmed && trimmed !== "*") {
      entries.add(trimmed);
    }
  }

  for (const client of appClientRows) {
    for (const entry of client.allowed_redirect_urls ?? []) {
      const trimmed = entry.trim();
      if (trimmed && trimmed !== "*") entries.add(trimmed);
    }
  }

  if (!explicitTenantId) {
    for (const entry of parseOAuthRedirectAllowlistEnv()) {
      entries.add(entry);
    }
  }

  return [...entries];
}

export async function assertAllowedOAuthRedirectUri(
  redirectUri: string,
  tenantId?: string,
  clientId?: string,
): Promise<URL> {
  const redirectUrl = parseOAuthRedirectUri(redirectUri);
  const allowlist = await getAllowedOAuthRedirectEntries(tenantId, clientId);

  if (allowlist.length === 0) {
    throw new Error(
      "OAuth redirect_uri allowlist is not configured for this tenant. Configure tenant allowedRedirectUrls or STEWARD_OAUTH_ALLOWED_REDIRECTS.",
    );
  }

  if (
    !allowlist.some((entry) => isOAuthRedirectEntryMatch(redirectUrl, entry))
  ) {
    throw new Error("redirect_uri is not allowed for this tenant");
  }

  return redirectUrl;
}
export { getChallengeStore as getAuthChallengeStore };

/** Release only owned memory; durable challenges remain available after restart. */
export function releaseAuthStores(): void {
  _authStoreSources = {
    challenge: "memory",
    token: "memory",
    siweNonce: "memory",
    mfa: "memory",
    importSession: "memory",
  };
  for (const store of [
    _challengeStore,
    _tokenStore,
    _oauthCodeStore,
    _emailGrantStore,
  ])
    store?.destroy();
  for (const backend of [_nonceBackend, _mfaBackend, _importSessionBackend]) {
    if (backend instanceof MemoryBackend) backend.destroy();
  }
  _challengeStore = null;
  _tokenStore = null;
  _oauthCodeStore = null;
  _emailGrantStore = null;
  _nonceBackend = null;
  _mfaBackend = null;
  _importSessionBackend = null;
  _phoneAuth = null;
  _passkeyAuth = null;
  _emailKeyStore = null;
  _oauthKeyStore = null;
  _passkeyAuthByOrigin.clear();
  _emailAuthByTenant.clear();
}
