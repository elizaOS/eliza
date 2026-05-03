/**
 * auth.ts — Complete authentication route group
 *
 * Mounts at /auth via `app.route("/auth", authRoutes)` in packages/api/src/index.ts.
 *
 * Routes
 * ──────
 * GET  /nonce                       — fresh nonce for SIWE
 * POST /verify                      — SIWE signature verification, returns JWT
 * GET  /session                     — inspect current JWT session
 * GET  /providers                   — available auth methods (passkey/email/siwe/google/discord)
 * POST /logout                      — client-side logout (no-op server side)
 *
 * POST /passkey/register/options    — { email } → WebAuthn creation options
 * POST /passkey/register/verify     — { email, response } → { token, user }
 * POST /passkey/login/options       — { email } → WebAuthn request options
 * POST /passkey/login/verify        — { email, response } → { token, user }
 *
 * POST /email/send                  — { email } → { ok, expiresAt }
 * POST /email/verify                — { token, email } → { token (JWT), user }
 * GET  /callback/email              — ?token=...&email=... → 302 redirect with session tokens
 *
 * Tenant context
 * ──────────────
 * All email/passkey routes accept an optional tenant hint via:
 *   - Header: X-Steward-Tenant: <tenantId>
 *   - Body field: tenantId: "<tenantId>"
 * If neither is present the user's personal tenant (personal-<userId>) is used
 * as the fallback so existing integrations continue to work unchanged.
 *
 * On each auth event (signup or login):
 *   1. The user record is created/found globally in `users`.
 *   2. A `user_tenants` link is upserted for the resolved tenant (role = "member").
 *   3. The JWT's `tenantId` claim is the resolved tenant, not the personal tenant.
 */

// node:crypto under Cloudflare nodejs_compat (GA Sept 2024):
//   - randomBytes        — supported.
//   - createPublicKey    — supported, including ed25519 JWK import (workerd
//                          shipped X25519/Ed25519 in late 2024).
//   - verify             — supported for ed25519. The (null, msg, key, sig)
//                          signature is the standard Node form.
// If any of these fail at runtime on Workers, fall back to tweetnacl for
// ed25519 verify (lightweight, edge-compatible).
import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import {
  buildBackend,
  ChallengeStore,
  EmailAuth,
  generateApiKey,
  getEnabledProviders,
  getProviderConfig,
  hashSha256Hex,
  isBuiltInProvider,
  OAuthClient,
  PasskeyAuth,
  ResendProvider,
  TokenStore,
  uint8ArrayToBase64url,
} from "@stwd/auth";
import {
  accounts,
  authenticators,
  getDb,
  refreshTokens,
  type TenantEmailConfig,
  tenantConfigs,
  tenants,
  users,
  userTenants,
} from "@stwd/db";
import type { ApiResponse } from "@stwd/shared";
import { KeyStore, provisionUserWallet, Vault } from "@stwd/vault";
import bs58 from "bs58";
import { and, eq, gte, lt } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { generateNonce, SiweMessage } from "siwe";

// ─── Constants ────────────────────────────────────────────────────────────────

const _DEFAULT_TENANT_ID = process.env.STEWARD_DEFAULT_TENANT_ID || "default";

// ─── IP-based auth rate limiting ─────────────────────────────────────────────

/**
 * Check a per-IP rate limit for auth endpoints, backed by the Redis sliding
 * window. When Redis is unavailable the request is allowed — the existing
 * Bun-side global rate limiter (in index.ts) and the upstream platform
 * (Cloudflare, ALB, etc.) are still in front of this. We deliberately do not
 * keep an in-memory fallback Map: it is incorrect across multiple instances
 * and impossible on Cloudflare Workers (no shared state across isolates).
 *
 * @param c        - Hono context (used to read client IP headers)
 * @param endpoint - Short name used as part of the Redis key
 * @param windowMs - Window length in milliseconds
 * @param max      - Maximum allowed requests in the window
 */
async function checkAuthRateLimit(
  c: Context,
  endpoint: string,
  windowMs: number,
  max: number,
): Promise<{ allowed: boolean; retryAfterSecs?: number }> {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "unknown";
  const key = `ratelimit:auth:${endpoint}:${ip}:${windowMs}`;

  try {
    const redisMw = await import("../middleware/redis.js");
    if (!redisMw.isRedisAvailable()) return { allowed: true };

    const { checkRateLimit } = await import("@stwd/redis");
    const result = await checkRateLimit(key, windowMs, max);
    if (!result.allowed) {
      return {
        allowed: false,
        retryAfterSecs: Math.ceil(result.resetMs / 1000),
      };
    }
    return { allowed: true };
  } catch {
    // Treat Redis errors as soft-fail (allow the request) so a transient
    // Redis outage doesn't lock users out of authentication.
    return { allowed: true };
  }
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

// JWT secret: all modules MUST use STEWARD_SESSION_SECRET (with STEWARD_MASTER_PASSWORD fallback)
// to ensure tokens minted by auth routes validate in user routes and vice versa.
const jwtSecretSource = process.env.STEWARD_SESSION_SECRET || process.env.STEWARD_MASTER_PASSWORD;
if (!process.env.STEWARD_SESSION_SECRET && process.env.STEWARD_MASTER_PASSWORD) {
  console.warn(
    "⚠️ STEWARD_SESSION_SECRET not set, falling back to master password. Set a separate JWT secret for production.",
  );
}
if (!jwtSecretSource) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "⛔ STEWARD_SESSION_SECRET (or STEWARD_MASTER_PASSWORD) must be set in production",
    );
  }
  console.warn(
    "⚠️  [DEV ONLY] Using insecure 'dev-secret' for JWT signing. Set STEWARD_SESSION_SECRET before going to production!",
  );
}
const JWT_SECRET = new TextEncoder().encode(jwtSecretSource || "dev-secret");
const JWT_ISSUER = "steward";

/** Access token lifetime: 15 minutes */
const ACCESS_TOKEN_EXPIRY = "15m";
const ACCESS_TOKEN_EXPIRY_SECONDS = 900;

/** Refresh token lifetime: 30 days */
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

export async function createSessionToken(
  address: string,
  tenantId: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  return new SignJWT({ address, tenantId, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(JWT_SECRET);
}

// ─── Refresh token helpers ────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return hashSha256Hex(raw);
}

/**
 * Generate a random refresh token, persist its hash in DB, return the raw value.
 * The raw token is sent to the client; only the hash is stored server-side.
 */
async function createRefreshToken(userId: string, tenantId: string): Promise<string> {
  const db = getDb();
  const raw = randomBytes(40).toString("hex");
  const id = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000);
  await db
    .insert(refreshTokens)
    .values({ id, userId, tenantId, tokenHash: hashToken(raw), expiresAt });
  return raw;
}

/**
 * Atomically consume a raw refresh token.
 * Deletes and returns the row in one statement so concurrent refresh attempts
 * cannot both validate the same one-time token and mint parallel successors.
 */
async function consumeRefreshToken(raw: string): Promise<typeof refreshTokens.$inferSelect | null> {
  const db = getDb();
  const now = new Date();
  const [record] = await db
    .delete(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hashToken(raw)), gte(refreshTokens.expiresAt, now)))
    .returning();

  // Best-effort cleanup for expired rows so they do not linger forever.
  if (!record) {
    await db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hashToken(raw)), lt(refreshTokens.expiresAt, now)));
    return null;
  }

  return record;
}

/** Build the standard dual-token auth response. */
function buildAuthResponse(
  token: string,
  refreshToken: string,
  user: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: true,
    token,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    user,
  };
}

export async function verifySessionToken(token: string): Promise<{
  address: string;
  tenantId: string;
  userId?: string;
  email?: string;
} | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
    });
    return payload as {
      address: string;
      tenantId: string;
      userId?: string;
      email?: string;
    };
  } catch {
    return null;
  }
}

// ─── Nonce store (SIWE / SIWS) ───────────────────────────────────────────────
//
// Backed by the same StoreBackend abstraction the challenge/token stores use,
// so nonces persist across instances on Workers (Upstash) and across restarts
// in production (Postgres `auth_kv_store`). The default is in-memory for
// dev/test — initAuthStores() upgrades it once Redis/Postgres availability
// is known.
//
// TTL matches the previous Map GC interval (5 minutes), enforced by the
// backend itself so no setInterval cleanup is needed.

const SIWE_NONCE_TTL_MS = 5 * 60 * 1000;
let _nonceBackend: import("@stwd/auth").StoreBackend | null = null;

function getNonceBackend(): import("@stwd/auth").StoreBackend {
  if (_nonceBackend) return _nonceBackend;
  // Lazily fall back to a fresh in-memory backend if initAuthStores() hasn't
  // been called yet (e.g. tests or Workers cold-boot before middleware runs).
  // initAuthStores() will replace this with a Redis or Postgres-backed one.
  // Imported via require to avoid a circular dep with @stwd/auth at module init.
  const { MemoryBackend } = require("@stwd/auth") as typeof import("@stwd/auth");
  _nonceBackend = new MemoryBackend();
  return _nonceBackend;
}

async function setSiweNonce(nonce: string): Promise<void> {
  await getNonceBackend().set(nonce, "1", SIWE_NONCE_TTL_MS);
}

/**
 * Atomically consume a SIWE nonce. Returns true if the nonce was present and
 * unexpired (and is now deleted), false otherwise.
 *
 * The check-then-delete is not strictly atomic across instances — Upstash and
 * Postgres do both, but with a small window. For SIWE this is acceptable: the
 * surrounding signature check is the actual authentication, and a leaked nonce
 * is useless without the corresponding wallet signature.
 */
async function consumeSiweNonce(nonce: string): Promise<boolean> {
  const backend = getNonceBackend();
  const value = await backend.get(nonce);
  if (!value) return false;
  await backend.delete(nonce);
  return true;
}

// ─── PasskeyAuth singleton ────────────────────────────────────────────────────

// ─── Store backend initialization ────────────────────────────────────────────

let _challengeStore: ChallengeStore | null = null;
let _tokenStore: TokenStore | null = null;

/**
 * Initialize auth token/challenge stores with the best available backend.
 * Call this during server startup AFTER initRedis() has been called.
 *
 * @param usePostgres  Pass true if the DB connection is known to be available.
 */
export async function initAuthStores(usePostgres = false): Promise<void> {
  const { getRedisClient } = await import("../middleware/redis.js");
  const redisClient = getRedisClient();

  const [
    { backend: challengeBackend, source: challengeSource },
    { backend: tokenBackend, source: tokenSource },
    { backend: nonceBackend, source: nonceSource },
  ] = await Promise.all([
    buildBackend("challenge", redisClient, usePostgres),
    buildBackend("token", redisClient, usePostgres),
    buildBackend("siwe-nonce", redisClient, usePostgres),
  ]);

  console.log(
    `[steward:auth] challenge store: ${challengeSource}, token store: ${tokenSource}, ` +
      `siwe-nonce store: ${nonceSource}`,
  );

  _challengeStore = new ChallengeStore({ backend: challengeBackend });
  _tokenStore = new TokenStore({ backend: tokenBackend });
  _nonceBackend = nonceBackend;

  // Reset singletons so they pick up the new stores on next use
  _passkeyAuth = null;
  _passkeyAuthByOrigin.clear();
  _emailAuthByTenant.clear();
}

function getChallengeStore(): ChallengeStore {
  _challengeStore ??= new ChallengeStore();
  return _challengeStore;
}

function getTokenStore(): TokenStore {
  _tokenStore ??= new TokenStore();
  return _tokenStore;
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
 */
function getPasskeyAuth(requestOrigin?: string): PasskeyAuth {
  const defaultRpID = process.env.PASSKEY_RP_ID || "steward.fi";
  const defaultOrigin = process.env.PASSKEY_ORIGIN || "https://steward.fi";
  const rpName = process.env.PASSKEY_RP_NAME || "Steward";

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

  // Parse origin to get rpID (hostname)
  let rpID = defaultRpID;
  try {
    rpID = new URL(requestOrigin).hostname;
  } catch {
    return getPasskeyAuth(); // invalid origin, fall back to default
  }

  // Validate against allowed origins
  const allowed = (process.env.PASSKEY_ALLOWED_ORIGINS || defaultOrigin)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(requestOrigin) && rpID !== defaultRpID) {
    return getPasskeyAuth(); // not in allowed list, use default
  }

  // Cache per rpID
  const cached = _passkeyAuthByOrigin.get(rpID);
  if (cached) return cached;

  const auth = new PasskeyAuth({
    rpName,
    rpID,
    origin: requestOrigin,
    challengeStore: getChallengeStore(),
  });
  _passkeyAuthByOrigin.set(rpID, auth);
  return auth;
}

// ─── EmailAuth cache ──────────────────────────────────────────────────────────

const _emailAuthByTenant = new Map<string, Promise<EmailAuth>>();
let _emailKeyStore: KeyStore | null = null;

function getEmailKeyStore(): KeyStore {
  if (_emailKeyStore) return _emailKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("STEWARD_MASTER_PASSWORD is required");
    }
    _emailKeyStore = new KeyStore("dev-secret");
    return _emailKeyStore;
  }

  _emailKeyStore = new KeyStore(masterPassword);
  return _emailKeyStore;
}

function buildGlobalEmailAuth(overrides?: { baseUrl?: string; callbackPath?: string }): EmailAuth {
  const resendKey = process.env.RESEND_API_KEY;
  const provider = resendKey
    ? new ResendProvider({
        apiKey: resendKey,
        from: process.env.EMAIL_FROM || "login@steward.fi",
      })
    : undefined;

  return new EmailAuth({
    from: process.env.EMAIL_FROM || "login@steward.fi",
    baseUrl: overrides?.baseUrl?.replace(/\/$/, "") || process.env.APP_URL || "https://steward.fi",
    callbackPath: overrides?.callbackPath,
    provider,
    tokenStore: getTokenStore(),
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

async function loadTenantEmailConfig(tenantId: string): Promise<TenantEmailConfig | null> {
  const db = getDb();
  const [row] = await db
    .select({ emailConfig: tenantConfigs.emailConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  return row?.emailConfig ?? null;
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

  if (!emailConfig || !emailConfig.apiKeyEncrypted) {
    // No per-tenant Resend config (or only magic-link override) — use the
    // global env-backed provider but still honor the per-tenant magic-link
    // overrides if present.
    return buildGlobalEmailAuth({
      baseUrl: magicLinkBaseUrl,
      callbackPath,
    });
  }

  // We've already returned via buildGlobalEmailAuth above when apiKeyEncrypted
  // is missing, so it's safe to assume `emailConfig.from + apiKeyEncrypted`
  // are both present here.
  const from = emailConfig.from || process.env.EMAIL_FROM || "login@steward.fi";
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
    magicLinkBaseUrl?.replace(/\/$/, "") || process.env.APP_URL || "https://steward.fi";

  return new EmailAuth({
    from,
    baseUrl,
    callbackPath,
    provider,
    tokenStore: getTokenStore(),
    templateId: emailConfig.templateId,
    subjectOverride: emailConfig.subjectOverride,
    replyTo: emailConfig.replyTo,
  });
}

export async function getEmailAuthForTenant(tenantId: string): Promise<EmailAuth> {
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

export function clearEmailAuthTenantCacheForTests(): void {
  _emailAuthByTenant.clear();
}

// ─── Vault helper ─────────────────────────────────────────────────────────────

function getVault(): Vault {
  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) throw new Error("STEWARD_MASTER_PASSWORD is required");
  return new Vault({
    masterPassword,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.CHAIN_ID || "84532", 10),
  });
}

// ─── Tenant resolution ────────────────────────────────────────────────────────

/**
 * Resolve the tenant the user is signing into.
 * Priority: X-Steward-Tenant header > body.tenantId > personal-<userId> fallback.
 * Returns null if the resolved tenant doesn't exist in the DB (caller should 404).
 */
type TenantResolutionOk = { ok: true; tenantId: string; isPersonal: boolean };
type TenantResolutionErr = { ok: false; status: 403 | 404; error: string };
type TenantResolutionResult = TenantResolutionOk | TenantResolutionErr;

/**
 * Resolve and validate the tenant a user is authenticating into.
 *
 * Priority: X-Steward-Tenant header > body.tenantId > personal-<userId> fallback.
 *
 * When an explicit tenantId is requested:
 *   1. Verify the tenant exists in the `tenants` table (404 if not)
 *   2. Check if user already has a user_tenants link (always allowed if so)
 *   3. Look up join_mode from tenant_configs (default 'open')
 *   4. If join_mode is 'open', auto-link is allowed
 *   5. If join_mode is 'invite', 403 (must be pre-invited)
 *   6. If join_mode is 'closed', 403 always
 */
async function resolveAndValidateTenant(
  c: Context,
  userId: string,
  bodyTenantId?: string,
): Promise<TenantResolutionResult> {
  const headerTenant = c.req.header("X-Steward-Tenant")?.trim();
  const requested = headerTenant || bodyTenantId?.trim() || undefined;

  if (!requested) {
    return { ok: true, tenantId: `personal-${userId}`, isPersonal: true };
  }

  const db = getDb();

  // 1. Verify the tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, requested));
  if (!tenant) {
    return { ok: false, status: 404, error: `Tenant '${requested}' not found` };
  }

  // 2. Check if user already has a link (always allowed regardless of join_mode)
  const [existingLink] = await db
    .select({ id: userTenants.id })
    .from(userTenants)
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, requested)));

  if (existingLink) {
    return { ok: true, tenantId: requested, isPersonal: false };
  }

  // 3. No existing link; check join_mode from tenant_configs
  const [config] = await db
    .select({ joinMode: tenantConfigs.joinMode })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, requested));

  const joinMode = config?.joinMode ?? "open"; // default open if no config row

  if (joinMode === "open") {
    return { ok: true, tenantId: requested, isPersonal: false };
  }

  if (joinMode === "invite") {
    return {
      ok: false,
      status: 403,
      error: `Tenant '${requested}' requires an invitation to join`,
    };
  }

  // joinMode === "closed"
  return {
    ok: false,
    status: 403,
    error: `Tenant '${requested}' is not accepting new members`,
  };
}

// ─── User / tenant provisioning helpers ──────────────────────────────────────

async function findOrCreateUser(email: string): Promise<typeof users.$inferSelect> {
  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing;
  const [newUser] = await db.insert(users).values({ email, emailVerified: false }).returning();
  return newUser;
}

async function findOrCreateWalletUser(
  walletAddress: string,
  walletChain: "ethereum" | "solana",
): Promise<typeof users.$inferSelect> {
  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
  if (existing) {
    if (existing.walletChain !== walletChain) {
      await db.update(users).set({ walletChain }).where(eq(users.id, existing.id));
      const [updated] = await db.select().from(users).where(eq(users.id, existing.id));
      return updated ?? { ...existing, walletChain };
    }
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({
      walletAddress,
      walletChain,
      email: null,
      emailVerified: false,
    })
    .returning();
  return created;
}

type WalletTenantResult = {
  tenant: typeof tenants.$inferSelect;
  isNewTenant: boolean;
  rawApiKey?: string;
};

async function findOrCreateWalletTenant(opts: {
  ownerAddress: string;
  tenantId: string;
  tenantName: string;
}): Promise<WalletTenantResult> {
  const db = getDb();
  const [existingTenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.ownerAddress, opts.ownerAddress));
  if (existingTenant) {
    return { tenant: existingTenant, isNewTenant: false };
  }

  const apiKeyPair = generateApiKey();
  const [newTenant] = await db
    .insert(tenants)
    .values({
      id: opts.tenantId,
      name: opts.tenantName,
      apiKeyHash: apiKeyPair.hash,
      ownerAddress: opts.ownerAddress,
    })
    .onConflictDoNothing()
    .returning();

  if (newTenant) {
    return { tenant: newTenant, isNewTenant: true, rawApiKey: apiKeyPair.key };
  }

  const [retryTenant] = await db.select().from(tenants).where(eq(tenants.id, opts.tenantId));
  if (!retryTenant) {
    throw new Error("Failed to create tenant");
  }

  return { tenant: retryTenant, isNewTenant: false };
}

function getAllowedSiweDomains(): string[] | null {
  const raw = process.env.SIWE_ALLOWED_DOMAINS?.trim();
  if (!raw) return null;
  const domains = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return domains.length > 0 ? domains : null;
}

type ParsedSiwsMessage = {
  domain: string;
  publicKey: string;
  nonce: string;
  issuedAt?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  statement?: string;
};

const ALLOWED_SOLANA_CHAIN_IDS = new Set(["solana", "mainnet", "devnet"]);

function isAllowedSiwsUri(uri: string | undefined, domain: string): boolean {
  if (!uri) return false;
  try {
    const parsedUri = new URL(uri);
    return parsedUri.protocol === "https:" && parsedUri.host === domain;
  } catch {
    return false;
  }
}

function isAllowedSiwsChainId(chainId: string | undefined): boolean {
  if (!chainId) return true;
  return ALLOWED_SOLANA_CHAIN_IDS.has(chainId.trim().toLowerCase());
}

function parseSiwsMessage(message: string): ParsedSiwsMessage | null {
  const lines = message.split(/\r?\n/);
  if (lines.length < 2) return null;

  const firstLine = lines[0]?.trim();
  const publicKey = lines[1]?.trim();
  const match = firstLine?.match(/^(.*) wants you to sign in with your Solana account:$/);
  if (!match || !publicKey) return null;

  const statementLines: string[] = [];
  const fields = new Map<string, string>();
  let inFields = false;

  for (const rawLine of lines.slice(2)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fieldMatch = line.match(/^([A-Za-z ]+):\s*(.+)$/);
    if (fieldMatch) {
      inFields = true;
      fields.set(fieldMatch[1].toLowerCase().replace(/\s+/g, ""), fieldMatch[2]);
      continue;
    }

    if (!inFields) {
      statementLines.push(line);
    }
  }

  const nonce = fields.get("nonce");
  if (!nonce) return null;

  return {
    domain: match[1].trim(),
    publicKey,
    nonce,
    issuedAt: fields.get("issuedat"),
    uri: fields.get("uri"),
    version: fields.get("version"),
    chainId: fields.get("chainid"),
    statement: statementLines.length > 0 ? statementLines.join("\n") : undefined,
  };
}

function verifySolanaMessageSignature(
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

    return verifySignature(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
  } catch {
    return false;
  }
}

/**
 * Ensure the user's personal tenant exists.
 * Used as a fallback when no explicit tenant is requested AND as the home for
 * the user's provisioned wallet agent (wallet always lives under personal tenant).
 */
async function ensurePersonalTenant(userId: string, displayName: string): Promise<string> {
  const db = getDb();
  const tenantId = `personal-${userId}`;
  const { hash } = generateApiKey();
  await db
    .insert(tenants)
    .values({ id: tenantId, name: displayName, apiKeyHash: hash })
    .onConflictDoNothing();
  return tenantId;
}

/**
 * Link a user to a tenant in the user_tenants junction table (idempotent).
 * If the tenant doesn't exist yet, silently skips — caller must ensure the
 * tenant exists before calling this.
 */
async function ensureUserTenantLink(
  userId: string,
  tenantId: string,
  role: string = "member",
): Promise<void> {
  const db = getDb();
  await db.insert(userTenants).values({ userId, tenantId, role }).onConflictDoNothing();
}

/**
 * Provision the user's personal wallet (idempotent).
 * The wallet agent always lives under `personal-<userId>` regardless of which
 * tenant the user authenticated through — the JWT tenantId is the requesting
 * tenant, but the wallet itself stays in the personal namespace.
 */
async function provisionWalletForUser(
  userId: string,
  email: string,
): Promise<{ walletAddress: string; personalTenantId: string }> {
  const personalTenantId = await ensurePersonalTenant(userId, email);
  const vault = getVault();
  const result = await provisionUserWallet(vault, userId, email, personalTenantId);
  const db = getDb();
  await db
    .update(users)
    .set({
      walletAddress: result.walletAddress,
      stewardWalletId: result.agentId,
    })
    .where(eq(users.id, userId));
  // Also link user to their personal tenant
  await ensureUserTenantLink(userId, personalTenantId, "owner");
  return { walletAddress: result.walletAddress, personalTenantId };
}

// ─── Request body helper ──────────────────────────────────────────────────────

async function safeJsonParse<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

type CompletedEmailAuthResult =
  | {
      ok: true;
      token: string;
      refreshToken: string;
      user: { id: string; email: string; walletAddress?: string | null };
    }
  | { ok: false; status: 403 | 404; error: string };

async function completeEmailAuth(
  c: Context,
  email: string,
  tenantId?: string,
): Promise<CompletedEmailAuthResult> {
  const user = await findOrCreateUser(email);
  const db = getDb();
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));

  // Provision wallet (idempotent, always under personal tenant)
  let walletAddress = user.walletAddress;
  try {
    const w = await provisionWalletForUser(user.id, email);
    walletAddress = w.walletAddress;
  } catch (err) {
    console.error("[EmailAuth] Wallet provision failed:", err);
  }

  // Resolve requesting tenant and link user
  const tenantResult = await resolveAndValidateTenant(c, user.id, tenantId);
  if (!tenantResult.ok) {
    return { ok: false, status: tenantResult.status, error: tenantResult.error };
  }
  const { tenantId: resolvedTenantId } = tenantResult;
  await ensureUserTenantLink(user.id, resolvedTenantId);

  const token = await createSessionToken(walletAddress ?? "", resolvedTenantId, {
    userId: user.id,
    email,
  });
  const refreshToken = await createRefreshToken(user.id, resolvedTenantId);

  return {
    ok: true,
    token,
    refreshToken,
    user: { id: user.id, email, walletAddress },
  };
}

function getEmailAuthRedirectBaseUrl(): string {
  return (process.env.EMAIL_AUTH_REDIRECT_BASE_URL || "https://www.elizacloud.ai").replace(
    /\/$/,
    "",
  );
}

function buildEmailAuthRedirectUrl(params?: Record<string, string | undefined>): string {
  const redirectUrl = new URL("/login", `${getEmailAuthRedirectBaseUrl()}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) redirectUrl.searchParams.set(key, value);
  }
  return redirectUrl.toString();
}

function redirectEmailAuthFailure(c: Context, reason: string): Response {
  return c.redirect(
    buildEmailAuthRedirectUrl({
      error: "email_auth_failed",
      reason,
    }),
    302,
  );
}

// ─── Route group ──────────────────────────────────────────────────────────────

const auth = new Hono();

// ── SIWE ──────────────────────────────────────────────────────────────────────

/**
 * GET /nonce
 * Returns a fresh one-time nonce for SIWE message construction.
 */
auth.get("/nonce", async (c) => {
  const nonce = generateNonce();
  await setSiweNonce(nonce);
  return c.json({ nonce });
});

/**
 * POST /verify
 * Body: { message: string; signature: string }
 * Verifies SIWE, auto-creates tenant (per wallet address), returns JWT.
 *
 * SIWE flow is wallet-address-centric: each unique address gets its own tenant.
 * If X-Steward-Tenant is provided and the tenant exists, the user is also linked
 * to that tenant and the JWT reflects the requested tenant instead.
 */
auth.post("/verify", async (c) => {
  const db = getDb();
  const body = await safeJsonParse<{ message: string; signature: string }>(c);
  if (!body?.message || !body?.signature) {
    return c.json<ApiResponse>({ ok: false, error: "message and signature are required" }, 400);
  }

  let siweMessage: SiweMessage;
  try {
    siweMessage = new SiweMessage(body.message);
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Invalid SIWE message format" }, 400);
  }

  const allowedDomains = getAllowedSiweDomains();
  if (allowedDomains && !allowedDomains.includes(siweMessage.domain)) {
    return c.json<ApiResponse>({ ok: false, error: "SIWE domain not allowed" }, 401);
  }

  const nonceOk = await consumeSiweNonce(siweMessage.nonce);
  if (!nonceOk) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired nonce" }, 401);
  }

  try {
    await siweMessage.verify({ signature: body.signature });
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Invalid signature" }, 401);
  }

  const address = siweMessage.address.toLowerCase();
  let tenantResult: WalletTenantResult;
  try {
    tenantResult = await findOrCreateWalletTenant({
      ownerAddress: address,
      tenantId: `t-${address.slice(2, 10)}`,
      tenantName: `${address.slice(0, 6)}...${address.slice(-4)}`,
    });
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Failed to create tenant" }, 500);
  }

  const requestedTenantId = c.req.header("X-Steward-Tenant");
  let effectiveTenantId = tenantResult.tenant.id;
  if (requestedTenantId && requestedTenantId !== tenantResult.tenant.id) {
    const [requestedTenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, requestedTenantId));
    if (requestedTenant) {
      effectiveTenantId = requestedTenantId;
    }
  }

  const user = await findOrCreateWalletUser(address, "ethereum");
  await ensureUserTenantLink(
    user.id,
    effectiveTenantId,
    effectiveTenantId === tenantResult.tenant.id ? "owner" : "member",
  );

  const token = await createSessionToken(address, effectiveTenantId, {
    userId: user.id,
  });
  const refreshToken = await createRefreshToken(user.id, effectiveTenantId);

  const responseData: Record<string, unknown> = {
    ok: true,
    token,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    userId: user.id,
    address,
    walletChain: "ethereum",
    tenant: { id: tenantResult.tenant.id, name: tenantResult.tenant.name },
  };

  if (tenantResult.isNewTenant && tenantResult.rawApiKey) {
    (responseData.tenant as Record<string, unknown>).apiKey = tenantResult.rawApiKey;
  }

  return c.json(responseData);
});

auth.post("/verify/solana", async (c) => {
  const db = getDb();
  const body = await safeJsonParse<{ message: string; signature: string; publicKey: string }>(c);
  if (!body?.message || !body?.signature || !body?.publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "message, signature, and publicKey are required" },
      400,
    );
  }

  const parsed = parseSiwsMessage(body.message);
  if (!parsed) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid SIWS message format" }, 400);
  }

  if (parsed.publicKey !== body.publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "publicKey does not match signed message" },
      401,
    );
  }

  const allowedDomains = getAllowedSiweDomains();
  if (allowedDomains && !allowedDomains.includes(parsed.domain)) {
    return c.json<ApiResponse>({ ok: false, error: "SIWS domain not allowed" }, 401);
  }

  if (!isAllowedSiwsUri(parsed.uri, parsed.domain)) {
    return c.json<ApiResponse>({ ok: false, error: "SIWS uri must match the signed domain" }, 401);
  }

  if (parsed.version !== "1") {
    return c.json<ApiResponse>({ ok: false, error: 'SIWS version must be "1"' }, 401);
  }

  if (!isAllowedSiwsChainId(parsed.chainId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "SIWS chainId must be one of: solana, mainnet, devnet" },
      401,
    );
  }

  const nonceOk = await consumeSiweNonce(parsed.nonce);
  if (!nonceOk) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired nonce" }, 401);
  }

  if (!verifySolanaMessageSignature(body.message, body.signature, body.publicKey)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid signature" }, 401);
  }

  let tenantResult: WalletTenantResult;
  try {
    tenantResult = await findOrCreateWalletTenant({
      ownerAddress: `solana:${body.publicKey}`,
      tenantId: `solana:${body.publicKey}`,
      tenantName: `${body.publicKey.slice(0, 4)}...${body.publicKey.slice(-4)}`,
    });
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Failed to create tenant" }, 500);
  }

  const requestedTenantId = c.req.header("X-Steward-Tenant");
  let effectiveTenantId = tenantResult.tenant.id;
  if (requestedTenantId && requestedTenantId !== tenantResult.tenant.id) {
    const [requestedTenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, requestedTenantId));
    if (requestedTenant) {
      effectiveTenantId = requestedTenantId;
    }
  }

  const user = await findOrCreateWalletUser(body.publicKey, "solana");
  await ensureUserTenantLink(
    user.id,
    effectiveTenantId,
    effectiveTenantId === tenantResult.tenant.id ? "owner" : "member",
  );

  const token = await createSessionToken(body.publicKey, effectiveTenantId, {
    userId: user.id,
  });
  const refreshToken = await createRefreshToken(user.id, effectiveTenantId);

  const responseData: Record<string, unknown> = {
    ok: true,
    token,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    userId: user.id,
    address: body.publicKey,
    publicKey: body.publicKey,
    walletChain: "solana",
    tenant: { id: tenantResult.tenant.id, name: tenantResult.tenant.name },
  };

  if (tenantResult.isNewTenant && tenantResult.rawApiKey) {
    (responseData.tenant as Record<string, unknown>).apiKey = tenantResult.rawApiKey;
  }

  return c.json(responseData);
});

/**
 * GET /session
 * Requires: Authorization: Bearer <token>
 */
auth.get("/session", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return c.json({ authenticated: false });

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);
  if (!payload) return c.json({ authenticated: false });

  return c.json({
    authenticated: true,
    address: payload.address,
    tenantId: payload.tenantId,
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
  });
});

/**
 * POST /logout
 * JWT is stateless — client drops the token.
 */
auth.post("/logout", (c) => c.json<ApiResponse>({ ok: true }));

/**
 * POST /refresh
 * Body: { refreshToken: string }
 * Validates the refresh token, rotates it (one-time use), issues new access + refresh tokens.
 * Supports silent re-auth without user interaction when the access token nears expiry.
 */
auth.post("/refresh", async (c) => {
  const rl = await checkAuthRateLimit(c, "refresh", 60_000, 30);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{ refreshToken: string }>(c);
  if (!body?.refreshToken) {
    return c.json<ApiResponse>({ ok: false, error: "refreshToken is required" }, 400);
  }

  const record = await consumeRefreshToken(body.refreshToken);
  if (!record) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired refresh token" }, 401);
  }

  const db = getDb();

  // Fetch user for token claims
  const [user] = await db.select().from(users).where(eq(users.id, record.userId));
  const walletAddress = user?.walletAddress ?? "";
  const email = user?.email ?? undefined;

  // Issue new access token (15min)
  const newAccessToken = await createSessionToken(walletAddress, record.tenantId, {
    userId: record.userId,
    ...(email ? { email } : {}),
  });

  // Issue new refresh token (rotation)
  const newRefreshToken = await createRefreshToken(record.userId, record.tenantId);

  return c.json({
    ok: true,
    token: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
  });
});

/**
 * POST /revoke
 * Body: { refreshToken: string }
 * Revokes a specific refresh token (sign out from this session/device).
 */
auth.post("/revoke", async (c) => {
  const body = await safeJsonParse<{ refreshToken: string }>(c);
  if (!body?.refreshToken) {
    return c.json<ApiResponse>({ ok: false, error: "refreshToken is required" }, 400);
  }

  const db = getDb();
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(body.refreshToken)));

  return c.json<ApiResponse>({ ok: true });
});

/**
 * DELETE /sessions
 * Requires: Authorization: Bearer <access-token>
 * Revokes ALL refresh tokens for the authenticated user (sign out everywhere / all devices).
 */
auth.delete("/sessions", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>({ ok: false, error: "Authorization header required" }, 401);
  }

  const payload = await verifySessionToken(authHeader.slice(7));
  if (!payload) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired token" }, 401);
  }

  if (!payload.userId) {
    return c.json<ApiResponse>({ ok: false, error: "Token does not contain userId" }, 400);
  }

  const db = getDb();
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, payload.userId));

  return c.json<ApiResponse>({ ok: true });
});

// ── Passkey registration ───────────────────────────────────────────────────────

/**
 * POST /passkey/register/options
 * Body: { email }
 * Finds or creates user, returns WebAuthn registration options.
 */
auth.post("/passkey/register/options", async (c) => {
  const body = await safeJsonParse<{
    email: string;
    authenticatorAttachment?: "platform" | "cross-platform";
  }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const user = await findOrCreateUser(email);

  const db = getDb();
  const existingCreds = await db
    .select({ credentialId: authenticators.credentialId })
    .from(authenticators)
    .where(eq(authenticators.userId, user.id));

  const attachment =
    body.authenticatorAttachment === "platform" || body.authenticatorAttachment === "cross-platform"
      ? body.authenticatorAttachment
      : undefined;

  const options = await getPasskeyAuth(c.req.header("origin")).generateRegistrationOptions(
    user.id,
    email,
    existingCreds.map((cred) => cred.credentialId),
    attachment ? { authenticatorAttachment: attachment } : undefined,
  );

  return c.json(options);
});

/**
 * POST /passkey/register/verify
 * Body: { email, response, tenantId? }
 * Headers: X-Steward-Tenant (optional)
 * Verifies registration, stores credential, provisions wallet, returns JWT.
 */
auth.post("/passkey/register/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "passkey-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    response: Record<string, unknown>;
    tenantId?: string;
  }>(c);

  if (!body?.email || !body?.response) {
    return c.json<ApiResponse>({ ok: false, error: "email and response are required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "User not found — call /passkey/register/options first",
      },
      404,
    );
  }

  let verification: Awaited<ReturnType<PasskeyAuth["verifyRegistration"]>>;
  try {
    verification = await getPasskeyAuth(c.req.header("origin")).verifyRegistration(
      user.id,
      body.response as unknown as Parameters<PasskeyAuth["verifyRegistration"]>[1],
    );
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Verification failed",
      },
      400,
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json<ApiResponse>({ ok: false, error: "Registration verification failed" }, 400);
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await db
    .insert(authenticators)
    .values({
      userId: user.id,
      credentialId: credential.id,
      credentialPublicKey: uint8ArrayToBase64url(credential.publicKey),
      counter: credential.counter,
      credentialDeviceType,
      credentialBackedUp,
      transports:
        (body.response.response as { transports?: string[] } | undefined)?.transports ?? [],
    })
    .onConflictDoNothing();

  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));

  // Provision the user's personal wallet (idempotent)
  let walletAddress = user.walletAddress;
  try {
    const w = await provisionWalletForUser(user.id, email);
    walletAddress = w.walletAddress;
  } catch (err) {
    console.error("[PasskeyAuth] Wallet provision failed on register:", err);
  }

  // Resolve which tenant this auth is for and link the user
  const tenantResult = await resolveAndValidateTenant(c, user.id, body.tenantId);
  if (!tenantResult.ok) {
    return c.json<ApiResponse>({ ok: false, error: tenantResult.error }, tenantResult.status);
  }
  const { tenantId } = tenantResult;
  await ensureUserTenantLink(user.id, tenantId);

  const token = await createSessionToken(walletAddress ?? "", tenantId, {
    userId: user.id,
    email,
  });
  const registerRefreshToken = await createRefreshToken(user.id, tenantId);

  return c.json(
    buildAuthResponse(token, registerRefreshToken, {
      id: user.id,
      email,
      walletAddress,
    }),
  );
});

// ── Passkey authentication ────────────────────────────────────────────────────

/**
 * POST /passkey/login/options
 * Body: { email }
 * Returns WebAuthn authentication options with allowed credentials.
 */
auth.post("/passkey/login/options", async (c) => {
  const body = await safeJsonParse<{ email: string }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    return c.json<ApiResponse>({ ok: false, error: "No account found for this email" }, 404);
  }

  const creds = await db
    .select({ credentialId: authenticators.credentialId })
    .from(authenticators)
    .where(eq(authenticators.userId, user.id));

  if (creds.length === 0) {
    return c.json<ApiResponse>({ ok: false, error: "No passkeys registered for this email" }, 404);
  }

  const options = await getPasskeyAuth(c.req.header("origin")).generateAuthenticationOptions(
    email,
    {
      allowCredentials: creds.map((cred) => ({ id: cred.credentialId })),
    },
  );

  return c.json(options);
});

/**
 * POST /passkey/login/verify
 * Body: { email, response, tenantId? }
 * Headers: X-Steward-Tenant (optional)
 * Verifies authentication, updates counter, links user to tenant, returns JWT.
 */
auth.post("/passkey/login/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "passkey-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    response: { id: string; [key: string]: unknown };
    tenantId?: string;
  }>(c);

  if (!body?.email || !body?.response) {
    return c.json<ApiResponse>({ ok: false, error: "email and response are required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  }

  const [cred] = await db
    .select()
    .from(authenticators)
    .where(
      and(eq(authenticators.userId, user.id), eq(authenticators.credentialId, body.response.id)),
    );

  if (!cred) {
    return c.json<ApiResponse>({ ok: false, error: "Credential not found" }, 404);
  }

  let verification: Awaited<ReturnType<PasskeyAuth["verifyAuthentication"]>>;
  try {
    verification = await getPasskeyAuth(c.req.header("origin")).verifyAuthentication(
      body.response as unknown as Parameters<PasskeyAuth["verifyAuthentication"]>[0],
      undefined,
      cred.credentialPublicKey,
      cred.counter,
      email,
    );
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Authentication failed",
      },
      400,
    );
  }

  if (!verification.verified) {
    return c.json<ApiResponse>({ ok: false, error: "Authentication verification failed" }, 401);
  }

  // Update counter to prevent replay attacks
  await db
    .update(authenticators)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(authenticators.id, cred.id));

  // Ensure wallet is provisioned (idempotent)
  let walletAddress = user.walletAddress;
  if (!walletAddress) {
    try {
      const w = await provisionWalletForUser(user.id, email);
      walletAddress = w.walletAddress;
    } catch (err) {
      console.error("[PasskeyAuth] Wallet provision failed on login:", err);
    }
  } else {
    // Wallet exists — still ensure personal tenant is in place
    await ensurePersonalTenant(user.id, email);
  }

  // Resolve the requesting tenant and auto-link if user isn't already a member
  const tenantResult = await resolveAndValidateTenant(c, user.id, body.tenantId);
  if (!tenantResult.ok) {
    return c.json<ApiResponse>({ ok: false, error: tenantResult.error }, tenantResult.status);
  }
  const { tenantId } = tenantResult;
  await ensureUserTenantLink(user.id, tenantId);

  const token = await createSessionToken(walletAddress ?? "", tenantId, {
    userId: user.id,
    email,
  });
  const loginRefreshToken = await createRefreshToken(user.id, tenantId);

  return c.json(
    buildAuthResponse(token, loginRefreshToken, {
      id: user.id,
      email,
      walletAddress,
    }),
  );
});

// ── Email magic link ──────────────────────────────────────────────────────────

/**
 * POST /email/send
 * Body: { email, tenantId? }
 * Sends a magic link email, returns expiry time.
 */
auth.post("/email/send", async (c) => {
  const rl = await checkAuthRateLimit(c, "email-send", 60_000, 3);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{ email: string; tenantId?: string }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const resolvedTenantId = c.req.header("X-Steward-Tenant") || body.tenantId || _DEFAULT_TENANT_ID;
  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  const { expiresAt } = await emailAuth.sendMagicLink(email);

  return c.json<ApiResponse<{ expiresAt: string }>>({
    ok: true,
    data: { expiresAt: expiresAt.toISOString() },
  });
});

/**
 * GET /callback/email
 * Query: ?token=<token>&email=<email>&tenantId=<tenantId?>
 * Mirrors POST /email/verify for browser clicks from magic link emails,
 * but redirects to the dashboard login page instead of returning JSON.
 */
auth.get("/callback/email", async (c) => {
  const token = c.req.query("token");
  const emailParam = c.req.query("email");
  const tenantId = c.req.query("tenantId");

  if (!token || !emailParam) {
    return redirectEmailAuthFailure(c, "missing_params");
  }

  const email = emailParam.toLowerCase().trim();

  let result: Awaited<ReturnType<EmailAuth["verifyMagicLink"]>>;
  try {
    const emailAuth = await getEmailAuthForTenant(tenantId || _DEFAULT_TENANT_ID);
    result = await emailAuth.verifyMagicLink(token);
  } catch {
    return redirectEmailAuthFailure(c, "invalid_link");
  }

  if (!result.valid) {
    return redirectEmailAuthFailure(c, "invalid_link");
  }

  if (result.email.toLowerCase().trim() !== email) {
    return redirectEmailAuthFailure(c, "email_mismatch");
  }

  const authResult = await completeEmailAuth(c, email, tenantId);
  if (!authResult.ok) {
    const reason = authResult.status === 404 ? "tenant_not_found" : "tenant_forbidden";
    return redirectEmailAuthFailure(c, reason);
  }

  return c.redirect(
    buildEmailAuthRedirectUrl({
      token: authResult.token,
      refreshToken: authResult.refreshToken,
    }),
    302,
  );
});

/**
 * POST /email/verify
 * Body: { token, email, tenantId? }
 * Headers: X-Steward-Tenant (optional)
 * Verifies the magic link token, provisions user + wallet, links to tenant, returns JWT.
 */
auth.post("/email/verify", async (c) => {
  const body = await safeJsonParse<{
    token: string;
    email: string;
    tenantId?: string;
  }>(c);
  if (!body?.token || !body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "token and email are required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const resolvedTenantId = c.req.header("X-Steward-Tenant") || body.tenantId || _DEFAULT_TENANT_ID;
  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  const result = await emailAuth.verifyMagicLink(body.token);

  if (!result.valid || result.email.toLowerCase().trim() !== email) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired magic link" }, 401);
  }

  const authResult = await completeEmailAuth(c, email, body.tenantId);
  if (!authResult.ok) {
    return c.json<ApiResponse>({ ok: false, error: authResult.error }, authResult.status);
  }

  return c.json(buildAuthResponse(authResult.token, authResult.refreshToken, authResult.user));
});

// ── OAuth providers list ─────────────────────────────────────────────────────

/**
 * GET /providers
 * Returns which auth methods are enabled based on environment configuration.
 * Used by the React widget to decide which login buttons to show.
 *
 * Response: { passkey: true, email: bool, siwe: true, siws: true, google: bool, discord: bool, github: bool, oauth: string[] }
 */
auth.get("/providers", (c) => {
  const oauthProviders = getEnabledProviders();
  return c.json({
    passkey: true,
    email: Boolean(process.env.RESEND_API_KEY),
    siwe: true,
    siws: true,
    google: oauthProviders.includes("google"),
    discord: oauthProviders.includes("discord"),
    github: oauthProviders.includes("github"),
    oauth: oauthProviders,
  });
});

// ── OAuth authorization-code flow ─────────────────────────────────────────────

/**
 * GET /oauth/:provider/authorize
 * Query: ?redirect_uri=<url>&tenant_id=<id>
 *
 * Generates an OAuth authorization URL, stores the CSRF state in the challenge
 * store (keyed as `oauth:<state>`), then redirects the user to the provider.
 */
auth.get("/oauth/:provider/authorize", async (c) => {
  const providerName = c.req.param("provider");
  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>({ ok: false, error: `Unknown provider: ${providerName}` }, 400);
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Provider not configured",
      },
      503,
    );
  }

  const redirectUri = c.req.query("redirect_uri");
  // Accept both `tenant_id` (snake_case, canonical) and `tenantId` (camelCase)
  // so integrators sending either shape land on the right tenant. Whitespace
  // is trimmed defensively for the same reason we trim headers elsewhere.
  const tenantId = c.req.query("tenant_id")?.trim() || c.req.query("tenantId")?.trim() || undefined;

  if (!redirectUri) {
    return c.json<ApiResponse>({ ok: false, error: "redirect_uri is required" }, 400);
  }

  // Generate a cryptographically random state value
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const callbackUrl = buildOAuthCallbackUrl(c, providerName);
  const { url: authUrl, codeVerifier } = oauthClient.generateAuthUrl(state, callbackUrl);

  // Store state metadata in the challenge store — include PKCE verifier when present
  const statePayload = JSON.stringify({
    provider: providerName,
    tenantId,
    redirectUri,
    ...(codeVerifier ? { codeVerifier } : {}),
  });
  getChallengeStore().set(`oauth:${state}`, statePayload);

  return c.redirect(authUrl, 302);
});

/**
 * GET /oauth/:provider/callback
 * Handles the redirect from the OAuth provider.
 *
 * Flow:
 *   1. Validate state (CSRF)
 *   2. Exchange code for access token
 *   3. Fetch user profile from provider
 *   4. Find/create user by email
 *   5. Upsert entry in `accounts` table
 *   6. Link user to requested tenant
 *   7. Mint JWT → redirect to app redirect_uri with ?token=<jwt>
 */
auth.get("/oauth/:provider/callback", async (c) => {
  const providerName = c.req.param("provider");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    return c.json<ApiResponse>({ ok: false, error: `OAuth error: ${errorParam}` }, 400);
  }

  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>({ ok: false, error: `Unknown provider: ${providerName}` }, 400);
  }

  if (!code || !state) {
    return c.json<ApiResponse>({ ok: false, error: "code and state are required" }, 400);
  }

  // Validate and consume the state (one-time use)
  const rawPayload = await getChallengeStore().consume(`oauth:${state}`);
  if (!rawPayload) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired OAuth state" }, 401);
  }

  let stateData: {
    provider: string;
    tenantId?: string;
    redirectUri: string;
    codeVerifier?: string;
  };
  try {
    stateData = JSON.parse(rawPayload) as typeof stateData;
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Malformed OAuth state payload" }, 400);
  }

  if (stateData.provider !== providerName) {
    return c.json<ApiResponse>({ ok: false, error: "Provider mismatch in state" }, 400);
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Provider not configured",
      },
      503,
    );
  }

  const callbackUrl = buildOAuthCallbackUrl(c, providerName);

  // Exchange code for access token — pass codeVerifier for PKCE providers (e.g. Twitter)
  let tokenResponse: Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
  try {
    tokenResponse = await oauthClient.exchangeCode(code, callbackUrl, stateData.codeVerifier);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Token exchange failed",
      },
      502,
    );
  }

  // Fetch user info from provider
  let providerUser: Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
  try {
    providerUser = await oauthClient.getUserInfo(tokenResponse.access_token);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to fetch user info",
      },
      502,
    );
  }

  // Twitter and some providers do not return an email address.
  // Generate a synthetic internal email so findOrCreateUser() can still work.
  // This email is never displayed or sent — it is purely an internal identity key.
  if (!providerUser.email) {
    if (!providerUser.id) {
      return c.json<ApiResponse>(
        { ok: false, error: "Provider returned neither email nor user ID" },
        400,
      );
    }
    providerUser = {
      ...providerUser,
      email: `${providerName}.${providerUser.id}@id.steward.internal`,
    };
  }

  // Create/find user + provision wallet + link tenant
  const result = await provisionOAuthUser({
    c,
    providerName,
    providerUser,
    tokenResponse,
    tenantId: stateData.tenantId,
  });

  if (!result.ok) {
    return c.json<ApiResponse>({ ok: false, error: result.error }, 500);
  }

  // Redirect to the app with the JWT
  const redirectUrl = new URL(stateData.redirectUri);
  redirectUrl.searchParams.set("token", result.token);
  redirectUrl.searchParams.set("refreshToken", result.refreshToken);
  return c.redirect(redirectUrl.toString(), 302);
});

/**
 * POST /oauth/:provider/token
 * SPA / popup flow — the client has already obtained the code.
 *
 * Body: { code: string; redirectUri: string; tenantId?: string; codeVerifier?: string }
 * Returns: { ok: true; token: string; user: { id, email, walletAddress } }
 */
auth.post("/oauth/:provider/token", async (c) => {
  const providerName = c.req.param("provider");
  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>({ ok: false, error: `Unknown provider: ${providerName}` }, 400);
  }

  const body = await safeJsonParse<{
    code: string;
    redirectUri: string;
    tenantId?: string;
    codeVerifier?: string;
  }>(c);

  if (!body?.code || !body?.redirectUri) {
    return c.json<ApiResponse>({ ok: false, error: "code and redirectUri are required" }, 400);
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Provider not configured",
      },
      503,
    );
  }

  let tokenResponse: Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
  try {
    tokenResponse = await oauthClient.exchangeCode(body.code, body.redirectUri, body.codeVerifier);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Token exchange failed",
      },
      502,
    );
  }

  let providerUser: Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
  try {
    providerUser = await oauthClient.getUserInfo(tokenResponse.access_token);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to fetch user info",
      },
      502,
    );
  }

  // Twitter and some providers do not return an email address.
  // Generate a synthetic internal email so findOrCreateUser() can still work.
  if (!providerUser.email) {
    if (!providerUser.id) {
      return c.json<ApiResponse>(
        { ok: false, error: "Provider returned neither email nor user ID" },
        400,
      );
    }
    providerUser = {
      ...providerUser,
      email: `${providerName}.${providerUser.id}@id.steward.internal`,
    };
  }

  const result = await provisionOAuthUser({
    c,
    providerName,
    providerUser,
    tokenResponse,
    tenantId: body.tenantId,
  });

  if (!result.ok) {
    return c.json<ApiResponse>({ ok: false, error: result.error }, 500);
  }

  return c.json(
    buildAuthResponse(result.token, result.refreshToken, result.user as Record<string, unknown>),
  );
});

// ─── OAuth helper: provision user + account + tenant link ─────────────────────

type OAuthUserInfo = Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
type OAuthTokenResponse = Awaited<ReturnType<OAuthClient["exchangeCode"]>>;

async function provisionOAuthUser(opts: {
  c: Context;
  providerName: string;
  providerUser: OAuthUserInfo;
  tokenResponse: OAuthTokenResponse;
  tenantId?: string;
}): Promise<
  | {
      ok: true;
      token: string;
      refreshToken: string;
      user: { id: string; email: string; walletAddress?: string | null };
    }
  | { ok: false; error: string }
> {
  const { c, providerName, providerUser, tokenResponse, tenantId } = opts;
  const db = getDb();
  const email = providerUser.email.toLowerCase().trim();

  try {
    // 1. Find or create global user record
    const user = await findOrCreateUser(email);

    // Update name/image if we have richer data from the provider and the user doesn't have it yet
    const updates: Partial<typeof users.$inferInsert> = {};
    if (!user.name && providerUser.name) updates.name = providerUser.name;
    if (!user.image && providerUser.picture) updates.image = providerUser.picture;
    if (!user.emailVerified && providerUser.verified_email) updates.emailVerified = true;
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, user.id));
    }

    // 2. Upsert the OAuth account link (provider + providerAccountId → user)
    await db
      .insert(accounts)
      .values({
        userId: user.id,
        provider: providerName,
        providerAccountId: providerUser.id,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? null,
        expiresAt: tokenResponse.expires_in
          ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
          : null,
      })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.providerAccountId],
        set: {
          userId: user.id,
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token ?? null,
          expiresAt: tokenResponse.expires_in
            ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
            : null,
        },
      });

    // 3. Provision personal wallet (idempotent)
    let walletAddress = user.walletAddress;
    try {
      const w = await provisionWalletForUser(user.id, email);
      walletAddress = w.walletAddress;
    } catch (err) {
      console.error(`[OAuthAuth:${providerName}] Wallet provision failed:`, err);
    }

    // 4. Resolve requesting tenant and link user
    const tenantResult = await resolveAndValidateTenant(c, user.id, tenantId);
    if (!tenantResult.ok) {
      return { ok: false as const, error: tenantResult.error };
    }
    const resolvedTenantId = tenantResult.tenantId;
    await ensureUserTenantLink(user.id, resolvedTenantId);

    // 5. Mint JWT + refresh token
    const token = await createSessionToken(walletAddress ?? "", resolvedTenantId, {
      userId: user.id,
      email,
    });
    const oauthRefreshToken = await createRefreshToken(user.id, resolvedTenantId);

    return {
      ok: true,
      token,
      refreshToken: oauthRefreshToken,
      user: { id: user.id, email, walletAddress },
    };
  } catch (err) {
    console.error(`[OAuthAuth:${providerName}] provisionOAuthUser failed:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Internal server error",
    };
  }
}

/**
 * Build the canonical OAuth callback URL for the given provider.
 * Uses the APP_URL env var (preferred) or reconstructs from the request host.
 */
function buildOAuthCallbackUrl(c: Context, providerName: string): string {
  const appUrl = process.env.APP_URL
    ? process.env.APP_URL.replace(/\/$/, "")
    : `${c.req.header("x-forwarded-proto") ?? "https"}://${c.req.header("host") ?? "localhost"}`;
  return `${appUrl}/auth/oauth/${providerName}/callback`;
}

export { auth as authRoutes };
