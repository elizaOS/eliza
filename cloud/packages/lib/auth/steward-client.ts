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
import { type JWTPayload, jwtVerify } from "jose";
import { cache } from "@/lib/cache/client";
import { InMemoryLRUCache } from "@/lib/cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";

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
  expiration: number;
  issuedAt: number;
  cachedAt: number;
}

/**
 * Env shape required to verify a Steward JWT. Callers pass the per-request
 * env (e.g. Hono `c.env` on Workers, or `process.env` on Node) so the
 * verifier never reads ambient global env unless explicitly passed.
 */
export interface StewardVerifyEnv {
  STEWARD_SESSION_SECRET?: string;
  STEWARD_JWT_SECRET?: string;
}

// Cache the encoded secret keyed by raw value, so repeated requests with the
// same secret skip the TextEncoder allocation. Bounded at one entry — secrets
// don't rotate on every request, and a stale entry just costs one re-encode.
let _jwtSecretCache: { raw: string; key: Uint8Array } | null = null;

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

  if (_jwtSecretCache && _jwtSecretCache.raw === raw) {
    return _jwtSecretCache.key;
  }

  const key = new TextEncoder().encode(raw);
  _jwtSecretCache = { raw, key };
  return key;
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
function extractClaims(payload: JWTPayload): StewardTokenClaims {
  const walletAddress = (payload.walletAddress ?? payload.address ?? payload.publicKey) as
    | string
    | undefined;
  const walletChain = (payload.walletChain ?? payload.wallet_chain) as
    | "ethereum"
    | "solana"
    | undefined;

  return {
    userId: (payload.sub ?? payload.userId ?? "") as string,
    email: payload.email as string | undefined,
    address: walletAddress,
    walletAddress,
    walletChain,
    tenantId: (payload.tenantId ?? payload.tenant_id) as string | undefined,
    expiration: payload.exp ?? 0,
    issuedAt: payload.iat ?? 0,
  };
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
 * @param token - The Steward JWT from Authorization header
 * @returns Verified claims or null if invalid/expired/missing secret
 */
export async function verifyStewardTokenCached(
  env: StewardVerifyEnv,
  token: string,
): Promise<StewardTokenClaims | null> {
  const secret = resolveJwtSecret(env);
  if (!secret) return null;

  const tokenHash = hashToken(token);
  const cacheKey = CacheKeys.session.steward(tokenHash);
  const now = Math.floor(Date.now() / 1000);
  const startTime = Date.now();

  try {
    // 0. Check in-memory cache first
    const inMemoryCached = IN_MEMORY_STEWARD_CACHE.get(tokenHash);
    if (inMemoryCached && inMemoryCached.expiration > now) {
      logger.debug("[StewardClient] ✓ In-memory cache hit", {
        tokenHash: tokenHash.substring(0, 8),
        durationMs: Date.now() - startTime,
      });
      return inMemoryCached;
    }

    // 1. Check Redis cache
    const cached = await cache.get<CachedStewardClaims>(cacheKey);
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
        expiration: cached.expiration,
        issuedAt: cached.issuedAt,
      };

      // Populate in-memory cache from Redis hit
      IN_MEMORY_STEWARD_CACHE.set(tokenHash, claims);
      return claims;
    }

    if (cached) {
      // Expired entry, clean up
      await cache.del(cacheKey);
    }

    // 2. Cache miss: verify JWT with jose
    logger.debug("[StewardClient] Cache miss, verifying JWT locally", {
      tokenHash: tokenHash.substring(0, 8),
    });

    const { payload } = await jwtVerify(token, secret, {
      // Accept HS256 (symmetric) and RS256/ES256 if needed in future
      algorithms: ["HS256"],
    });

    const claims = extractClaims(payload);

    if (!claims.userId) {
      logger.warn("[StewardClient] JWT valid but missing userId/sub claim");
      return null;
    }

    // 3. Cache the result
    const tokenRemainingSeconds = claims.expiration - now;
    const effectiveTtl = Math.min(CacheTTL.session.steward, tokenRemainingSeconds);

    if (effectiveTtl > 0) {
      const cachedClaims: CachedStewardClaims = {
        ...claims,
        cachedAt: Date.now(),
      };

      await cache.set(cacheKey, cachedClaims, effectiveTtl);

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
