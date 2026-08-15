/**
 * Steward JWT Verification with Redis Caching
 *
 * Steward issues JWTs after authentication; this module verifies them
 * with caching to avoid redundant crypto operations.
 *
 * Performance impact:
 * - Cache hit (in-memory): ~0ms
 * - Cache hit (Redis): ~5ms
 * - Cache miss: ~1-5ms (local JWT verify, no third-party API call)
 *
 * Security considerations:
 * - Short TTL (5 minutes) limits exposure if a token is revoked
 * - Token is hashed for cache key (raw token never stored)
 * - Only essential claims are cached
 * - Falls back gracefully on missing secret (logs warning, returns null)
 */

import { createHash } from "crypto";
import { decodeProtectedHeader, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { cache } from "../cache/client";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import {
  readStagingSessionSigningConfig,
  STAGING_SESSION_EXCHANGE_VERSION,
  STAGING_SESSION_TOKEN_TYP,
  type StagingSessionBinding,
  type StagingSessionBindingEnv,
  StagingSessionConfigurationError,
  validateStagingSessionBinding,
} from "./staging-session-binding";

/**
 * Timeout for LOGIN-PATH calls to the Steward upstream: the OAuth code
 * exchange (nonce-exchange), the refresh rotation, and the `/steward/*`
 * proxy the magic-link send/verify ride. Steward's Railway service has been
 * observed taking 10-15s server-side on these endpoints; a 10s abort turned
 * slow-but-SUCCESSFUL logins into 502 steward_upstream_unavailable. 25s sits
 * above the observed worst case while still bounding the Worker invocation.
 * Read-side helpers (services/steward-client.ts) keep their short timeouts on
 * purpose — they degrade to null instead of failing the user's request.
 */
export const STEWARD_AUTH_UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Claims extracted from a verified Steward JWT.
 * Maps to the fields Steward encodes in its session tokens.
 */
export interface StewardTokenClaims {
  /** Steward user ID (sub claim) */
  userId: string;
  /** User email, if present */
  email?: string;
  /** Wallet address, if present */
  address?: string;
  /** Wallet address, if present */
  walletAddress?: string;
  /** Wallet chain, if present */
  walletChain?: "ethereum" | "solana";
  /** Tenant/org scope, if present */
  tenantId?: string;
  /**
   * True when the token was minted by the cross-host SSO bridge exchange
   * (auth/sso-bridge). Bridge-issued tokens are subject to the fail-closed
   * logout-marker gate on the session-sync endpoint; ordinary tokens are not.
   */
  bridged?: boolean;
  /**
   * Present only on the disabled-by-default staging QA session exchange.
   * Every verification revalidates this source API key and identity binding
   * against primary storage; ordinary Steward tokens never carry it.
   */
  stagingSessionBinding?: StagingSessionBinding;
  /** Token expiration (unix timestamp) */
  expiration: number;
  /** Token issued-at (unix timestamp) */
  issuedAt: number;
}

/**
 * Cached representation of verified Steward claims.
 */
interface CachedStewardClaims {
  userId: string;
  email?: string;
  address?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
  tenantId?: string;
  bridged?: boolean;
  stagingSessionBinding?: StagingSessionBinding;
  expiration: number;
  issuedAt: number;
  cachedAt: number;
}

/**
 * Env shape required to verify a Steward JWT. Callers pass the per-request
 * env (e.g. Hono `c.env` on Workers, or `process.env` on Node) so the
 * verifier never reads ambient global env unless explicitly passed.
 */
export interface StewardVerifyEnv extends StagingSessionBindingEnv {
  STEWARD_SESSION_SECRET?: string;
  STEWARD_JWT_SECRET?: string;
  /**
   * Org tenant this deployment serves. When set, a token is rejected unless its
   * tenant is exactly this OR the caller's own `personal-<userId>` tenant — so
   * a token minted for another tenant can't authenticate here.
   */
  STEWARD_TENANT_ID?: string;
}

export interface StewardVerifyOptions {
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /**
   * Skip the distributed verification memo after the in-isolate check. Local
   * signature verification is cheaper than a second Worker KV round-trip and
   * keeps inference-session authorization to one remote cache decision.
   */
  skipDistributedCache?: boolean;
}

export const STEWARD_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

// Cache the encoded secret keyed by raw value, so repeated requests with the
// same secret skip the TextEncoder allocation. Bounded at one entry — secrets
// don't rotate on every request, and a stale entry just costs one re-encode.
let _jwtSecretCache: { raw: string; key: Uint8Array } | null = null;

function encodeSecret(raw: string): Uint8Array {
  if (_jwtSecretCache && _jwtSecretCache.raw === raw) {
    return _jwtSecretCache.key;
  }
  const key = new TextEncoder().encode(raw);
  _jwtSecretCache = { raw, key };
  return key;
}

function resolveJwtSecret(env: StewardVerifyEnv): Uint8Array | null {
  // Mirror @stwd/auth getJwtSecret() preference order:
  // STEWARD_JWT_SECRET is canonical, STEWARD_SESSION_SECRET is the deprecated
  // backwards-compat fallback. Reading them in the wrong order causes silent
  // verify failures when a deployment sets both (signer uses JWT_SECRET,
  // verifier ends up using SESSION_SECRET). See steward-fi/auth/src/jwt.ts.
  const raw = env.STEWARD_JWT_SECRET || env.STEWARD_SESSION_SECRET || "";

  if (!raw) {
    logger.warn("[StewardClient] No STEWARD_JWT_SECRET or STEWARD_SESSION_SECRET configured");
    return null;
  }

  return encodeSecret(raw);
}

interface StagingTokenHeader {
  isCandidate: boolean;
  keyId?: string;
}

function readStagingTokenHeader(token: string): StagingTokenHeader {
  try {
    const header = decodeProtectedHeader(token);
    if (header.typ !== STAGING_SESSION_TOKEN_TYP) {
      return { isCandidate: false };
    }
    return {
      isCandidate: true,
      ...(typeof header.kid === "string" ? { keyId: header.kid } : {}),
    };
  } catch {
    // error-policy:J3 an undecodable protected header is not a QA candidate;
    // normal jose verification below still rejects the malformed token.
    return { isCandidate: false };
  }
}

/**
 * Cheap, untrusted classification used only to force QA revalidation before
 * outer user/session caches. It never authenticates a token.
 */
export function isStagingSessionTokenCandidate(token: string): boolean {
  return readStagingTokenHeader(token).isCandidate;
}

function resolveStagingTokenSecret(
  env: StewardVerifyEnv,
  keyId: string | undefined,
): Uint8Array | null {
  try {
    const config = readStagingSessionSigningConfig(env);
    if (keyId !== config.keyId) return null;
    return encodeSecret(config.secret);
  } catch (error) {
    if (error instanceof StagingSessionConfigurationError) return null;
    throw error;
  }
}

export async function mintStewardTokenFromClaims(
  env: StewardVerifyEnv,
  claims: StewardTokenClaims,
  ttlSeconds = STEWARD_ACCESS_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number; expiresIn: number } | null> {
  const now = Math.floor(Date.now() / 1000);
  let secret: Uint8Array | null;
  let protectedHeader: { alg: "HS256"; typ: string; kid?: string };
  let requestedTtl = Math.max(1, Math.floor(ttlSeconds));

  if (claims.stagingSessionBinding) {
    let config;
    try {
      config = readStagingSessionSigningConfig(env);
    } catch (error) {
      if (error instanceof StagingSessionConfigurationError) return null;
      throw error;
    }
    if (claims.stagingSessionBinding.version !== STAGING_SESSION_EXCHANGE_VERSION) {
      return null;
    }
    const absoluteRemaining = claims.stagingSessionBinding.sessionMaxExpiresAt - now;
    if (absoluteRemaining <= 0) return null;
    requestedTtl = Math.min(requestedTtl, absoluteRemaining);
    secret = encodeSecret(config.secret);
    protectedHeader = {
      alg: "HS256",
      typ: STAGING_SESSION_TOKEN_TYP,
      kid: config.keyId,
    };
  } else {
    secret = resolveJwtSecret(env);
    if (!secret) return null;
    protectedHeader = { alg: "HS256", typ: "JWT" };
  }

  const expiresIn = Math.max(1, requestedTtl);
  const expiresAt = now + expiresIn;
  const payload: Record<string, unknown> = {
    userId: claims.userId,
  };
  if (claims.email) payload.email = claims.email;
  const walletAddress = claims.walletAddress ?? claims.address;
  if (walletAddress) {
    payload.address = walletAddress;
    payload.walletAddress = walletAddress;
  }
  if (claims.walletChain) payload.walletChain = claims.walletChain;
  if (claims.tenantId) {
    payload.tenantId = claims.tenantId;
    payload.tenant_id = claims.tenantId;
  }
  // The bridge stamp survives re-mints (steward-refresh re-mints from verified
  // claims): a session that entered an origin through the bridge stays subject
  // to the cross-host logout barrier for its whole cookie-planting lifetime.
  if (claims.bridged) payload.bridged = true;
  if (claims.stagingSessionBinding) {
    payload.eliza_staging_session = claims.stagingSessionBinding;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader(protectedHeader)
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(secret);

  return { token, expiresAt, expiresIn };
}

/**
 * Hash a token for use as cache key.
 * Never store raw tokens; use SHA256 hash truncated to 32 chars.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").substring(0, 32);
}

/**
 * In-memory LRU cache for Steward token verification (30s TTL, max 200).
 * Eliminates Redis round-trip for repeated requests within the same
 * serverless function instance.
 */
const IN_MEMORY_STEWARD_CACHE = new InMemoryLRUCache<StewardTokenClaims>(200, 30_000);

/**
 * Extract StewardTokenClaims from a raw jose JWTPayload.
 */
function extractStagingSessionBinding(payload: JWTPayload): StagingSessionBinding | undefined {
  const raw = payload.eliza_staging_session;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid staging session binding claim");
  }
  const record = raw as Record<string, unknown>;
  if (
    record.version !== STAGING_SESSION_EXCHANGE_VERSION ||
    typeof record.apiKeyId !== "string" ||
    typeof record.cloudUserId !== "string" ||
    typeof record.organizationId !== "string" ||
    typeof record.credentialFingerprint !== "string" ||
    typeof record.sessionIssuedAt !== "number" ||
    typeof record.sessionMaxExpiresAt !== "number"
  ) {
    throw new Error("Invalid staging session binding claim");
  }
  return {
    version: STAGING_SESSION_EXCHANGE_VERSION,
    apiKeyId: record.apiKeyId,
    cloudUserId: record.cloudUserId,
    organizationId: record.organizationId,
    credentialFingerprint: record.credentialFingerprint,
    sessionIssuedAt: record.sessionIssuedAt,
    sessionMaxExpiresAt: record.sessionMaxExpiresAt,
  };
}

function extractClaims(payload: JWTPayload): StewardTokenClaims {
  const walletAddress = (payload.walletAddress ?? payload.address ?? payload.publicKey) as
    | string
    | undefined;
  const walletChain = (payload.walletChain ?? payload.wallet_chain) as
    | "ethereum"
    | "solana"
    | undefined;
  const stagingSessionBinding = extractStagingSessionBinding(payload);

  return {
    userId: (payload.sub ?? payload.userId ?? "") as string,
    email: payload.email as string | undefined,
    address: walletAddress,
    walletAddress,
    walletChain,
    tenantId: (payload.tenantId ?? payload.tenant_id) as string | undefined,
    ...(payload.bridged === true ? { bridged: true } : {}),
    ...(stagingSessionBinding ? { stagingSessionBinding } : {}),
    expiration: payload.exp ?? 0,
    issuedAt: payload.iat ?? 0,
  };
}

async function validateOptionalStagingBinding(
  env: StewardVerifyEnv,
  claims: StewardTokenClaims,
): Promise<boolean> {
  if (!claims.stagingSessionBinding) return true;
  return await validateStagingSessionBinding({
    env,
    binding: claims.stagingSessionBinding,
    stewardUserId: claims.userId,
    tenantId: claims.tenantId,
    issuedAt: claims.issuedAt,
    expiration: claims.expiration,
  });
}

function claimsMatchTokenClass(header: StagingTokenHeader, claims: StewardTokenClaims): boolean {
  return header.isCandidate === Boolean(claims.stagingSessionBinding);
}

async function verifyStewardTokenWithoutCaches(input: {
  env: StewardVerifyEnv;
  token: string;
  secret: Uint8Array;
  stagingHeader: StagingTokenHeader;
  tokenHash: string;
}): Promise<StewardTokenClaims | null> {
  const { payload } = await jwtVerify(input.token, input.secret, {
    algorithms: ["HS256"],
  });
  const claims = extractClaims(payload);

  if (!claims.userId) {
    logger.warn("[StewardClient] JWT valid but missing userId/sub claim");
    return null;
  }

  // A QA binding is accepted only under the dedicated typ+kid+key path, and
  // a token selecting that path must carry the binding. This prevents a
  // normal Steward signer from manufacturing an un-revalidated QA claim or
  // a dedicated token from degrading into an ordinary session.
  if (!claimsMatchTokenClass(input.stagingHeader, claims)) {
    logger.debug("[StewardClient] Token class and claims do not match");
    return null;
  }

  if (!(await validateOptionalStagingBinding(input.env, claims))) {
    logger.debug("[StewardClient] Staging session source binding is no longer valid");
    return null;
  }

  // Steward issues per-user personal tenants scoped inside the org tenant.
  // Apply tenant scope before any caller can use or cache the claims.
  const expectedTenant = input.env.STEWARD_TENANT_ID;
  if (
    expectedTenant &&
    claims.tenantId &&
    claims.tenantId !== expectedTenant &&
    claims.tenantId !== `personal-${claims.userId}`
  ) {
    logger.debug("[StewardClient] Token tenant not permitted for this deployment", {
      tokenHash: input.tokenHash.substring(0, 8),
    });
    return null;
  }

  return claims;
}

/**
 * Verify a Steward JWT with caching.
 *
 * Cache layers (fastest to slowest):
 * 1. In-memory LRU: ~0ms (same serverless instance, 30s TTL)
 * 2. Redis: ~5ms (cross-instance, 5min TTL)
 * 3. Local jose verify: ~1-5ms (no third-party API call)
 *
 * @param env - Object exposing STEWARD_SESSION_SECRET / STEWARD_JWT_SECRET.
 *   Pass Hono `c.env` on Workers, or `process.env` on Node. Callers
 *   that still rely on the legacy global may pass `process.env` explicitly.
 */
export async function verifyStewardTokenCached(
  env: StewardVerifyEnv,
  token: string,
  options: StewardVerifyOptions = {},
): Promise<StewardTokenClaims | null> {
  const stagingHeader = readStagingTokenHeader(token);
  const secret = stagingHeader.isCandidate
    ? resolveStagingTokenSecret(env, stagingHeader.keyId)
    : resolveJwtSecret(env);
  if (!secret) return null;

  const tokenHash = hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  const startTime = Date.now();

  try {
    // The exact pre-QA rollback reads the ordinary Steward cache before
    // verifying a signature. A dedicated-key token must therefore never read
    // or populate that namespace (nor the shared in-isolate memo): otherwise a
    // rollback could accept the cached claims with a key it cannot verify.
    if (stagingHeader.isCandidate) {
      logger.debug("[StewardClient] Verifying staging session without legacy caches", {
        tokenHash: tokenHash.substring(0, 8),
      });
      return await verifyStewardTokenWithoutCaches({
        env,
        token,
        secret,
        stagingHeader,
        tokenHash,
      });
    }

    const cacheKey = CacheKeys.session.steward(tokenHash);

    // 0. Check in-memory cache first
    const inMemoryCached = IN_MEMORY_STEWARD_CACHE.get(tokenHash);
    if (inMemoryCached && inMemoryCached.expiration > now) {
      logger.debug("[StewardClient] ✓ In-memory cache hit", {
        tokenHash: tokenHash.substring(0, 8),
        durationMs: Date.now() - startTime,
      });
      if (!claimsMatchTokenClass(stagingHeader, inMemoryCached)) return null;
      return (await validateOptionalStagingBinding(env, inMemoryCached)) ? inMemoryCached : null;
    }

    // 1. Check the distributed memo unless the caller deliberately prefers
    // local crypto to a second network lookup (the inference hot path).
    const cached = options.skipDistributedCache
      ? null
      : await cache.get<CachedStewardClaims>(cacheKey);
    if (cached && cached.expiration > now) {
      logger.debug("[StewardClient] ✓ Redis cache hit", {
        tokenHash: tokenHash.substring(0, 8),
        userId: cached.userId.substring(0, 20),
        durationMs: Date.now() - startTime,
      });

      const claims: StewardTokenClaims = {
        userId: cached.userId,
        email: cached.email,
        address: cached.address,
        walletAddress: cached.walletAddress,
        walletChain: cached.walletChain,
        tenantId: cached.tenantId,
        ...(cached.bridged === true ? { bridged: true } : {}),
        ...(cached.stagingSessionBinding
          ? { stagingSessionBinding: cached.stagingSessionBinding }
          : {}),
        expiration: cached.expiration,
        issuedAt: cached.issuedAt,
      };

      // Populate in-memory cache from Redis hit
      if (!claimsMatchTokenClass(stagingHeader, claims)) return null;
      if (!(await validateOptionalStagingBinding(env, claims))) return null;
      IN_MEMORY_STEWARD_CACHE.set(tokenHash, claims);
      return claims;
    }

    if (cached) {
      // Removes expired cache entries
      await cache.del(cacheKey);
    }

    // 2. Cache miss: verify JWT with jose
    logger.debug("[StewardClient] Cache miss, verifying JWT locally", {
      tokenHash: tokenHash.substring(0, 8),
    });

    const claims = await verifyStewardTokenWithoutCaches({
      env,
      token,
      secret,
      stagingHeader,
      tokenHash,
    });
    if (!claims) return null;

    // 3. Cache the result
    const tokenRemainingSeconds = claims.expiration - now;
    const effectiveTtl = Math.min(CacheTTL.session.steward, tokenRemainingSeconds);

    if (effectiveTtl > 0) {
      const cachedClaims: CachedStewardClaims = {
        ...claims,
        cachedAt: Date.now(),
      };

      const cacheWrite = cache.set(cacheKey, cachedClaims, effectiveTtl).catch((error) => {
        // error-policy:J7 token verification already succeeded locally; cache
        // population is diagnostic acceleration and must remain observable.
        logger.warn("[StewardClient] Failed to cache verified token", {
          tokenHash: tokenHash.substring(0, 8),
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (options.executionCtx) {
        options.executionCtx.waitUntil(cacheWrite);
      } else {
        await cacheWrite;
      }

      logger.debug("[StewardClient] ✓ Cached verification result", {
        tokenHash: tokenHash.substring(0, 8),
        userId: claims.userId.substring(0, 20),
        ttlSeconds: effectiveTtl,
        durationMs: Date.now() - startTime,
      });
    }

    // Also cache in-memory
    IN_MEMORY_STEWARD_CACHE.set(tokenHash, claims);

    return claims;
  } catch (error) {
    const isExpectedFailure =
      error instanceof Error &&
      (error.message.includes("JWSInvalid") ||
        error.message.includes("JWTExpired") ||
        error.message.includes("JWTClaimValidationFailed") ||
        error.message.includes("Invalid Compact JWS") ||
        error.message.includes("signature verification failed") ||
        ("code" in error &&
          (error.code === "ERR_JWS_INVALID" ||
            error.code === "ERR_JWT_EXPIRED" ||
            error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ||
            error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED")));

    if (isExpectedFailure) {
      logger.debug(
        "[StewardClient] Token verification failed (invalid/expired):",
        error instanceof Error ? error.message : "Unknown error",
      );
      return null;
    }

    logger.error(
      "[StewardClient] ✗ Unexpected verification error:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return null;
  }
}

/**
 * Invalidate the cache for a specific Steward token.
 * Call on logout to ensure immediate token invalidation.
 */
export async function invalidateStewardTokenCache(token: string): Promise<void> {
  // QA verification never owns entries in rollback-readable session caches.
  // Preserve that isolation on logout instead of addressing legacy keys.
  if (isStagingSessionTokenCandidate(token)) {
    logger.debug("[StewardClient] Staging session has no legacy cache to invalidate");
    return;
  }

  const tokenHash = hashToken(token);

  IN_MEMORY_STEWARD_CACHE.delete(tokenHash);

  await Promise.all([
    cache.del(CacheKeys.session.steward(tokenHash)),
    cache.del(CacheKeys.session.user(tokenHash)),
  ]);

  logger.debug("[StewardClient] ✓ Invalidated token cache (in-memory + Redis)", {
    tokenHash: tokenHash.substring(0, 8),
  });
}
