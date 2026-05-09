import crypto from "crypto";
import type { Organization } from "@/db/schemas/organizations";
import { AuthenticationError, ForbiddenError } from "@/lib/api/errors";
import { verifyWalletSignature } from "@/lib/auth/wallet-auth";
import { cache as redisCache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { getCookieValueFromHeader } from "@/lib/http/cookie-header";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { adminService } from "@/lib/services/admin";
import { apiKeysService } from "@/lib/services/api-keys";
import { userSessionsService } from "@/lib/services/user-sessions";
import { usersService } from "@/lib/services/users";
import type { ApiKey, UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import {
  isPlaywrightTestAuthEnabled,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
  verifyPlaywrightTestSessionToken,
} from "./auth/playwright-test-session";
import {
  invalidateStewardTokenCache,
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "./auth/steward-client";
import { syncUserFromSteward } from "./steward-sync";

// Re-export Organization type for convenience
export type { Organization };

/**
 * Hash a token for use as cache key (never store raw tokens)
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").substring(0, 32);
}

function getStewardVerifyEnv(): StewardVerifyEnv {
  const env = getCloudAwareEnv();
  return {
    STEWARD_SESSION_SECRET: env.STEWARD_SESSION_SECRET,
    STEWARD_JWT_SECRET: env.STEWARD_JWT_SECRET,
  };
}

/**
 * Invalidate user session cache (call when user/org data changes)
 * @param sessionToken - The session token to invalidate cache for
 */
export async function invalidateUserSessionCache(sessionToken: string): Promise<void> {
  const tokenHash = hashToken(sessionToken);
  const cacheKey = CacheKeys.session.user(tokenHash);
  await redisCache.del(cacheKey);
  logger.debug("[AUTH] Invalidated user session cache");
}

/**
 * Invalidate all caches for a session token. Call this on logout.
 */
export async function invalidateSessionCaches(sessionToken: string): Promise<void> {
  await invalidateStewardTokenCache(sessionToken);
  logger.debug("[AUTH] Invalidated all session caches (Steward + user)");
}

/**
 * Ensure user has a default API key for programmatic access.
 * Creates one if it doesn't exist (for users who registered before auto-generation).
 */
async function ensureUserHasApiKey(userId: string, organizationId: string): Promise<void> {
  if (!userId || userId.trim() === "") {
    logger.warn("[Auth] Invalid userId, skipping API key check");
    return;
  }
  if (!organizationId || organizationId.trim() === "") {
    logger.warn(`[Auth] No organization for user ${userId}, skipping API key check`);
    return;
  }

  const existingKeys = await apiKeysService.listByOrganization(organizationId);
  const userHasKey = existingKeys.some((key) => key.user_id === userId);
  if (userHasKey) return;

  await apiKeysService.create({
    user_id: userId,
    organization_id: organizationId,
    name: "Default API Key",
    is_active: true,
  });
}

export type AuthResult = {
  user: UserWithOrganization;
  apiKey?: ApiKey;
  authMethod: "session" | "api_key" | "wallet_signature";
  session_token?: string;
};

async function getPlaywrightTestUserFromHeader(
  cookieHeader: string | null,
): Promise<UserWithOrganization | null> {
  const env = getCloudAwareEnv();
  if (!isPlaywrightTestAuthEnabled(env)) return null;

  const testSession = getCookieValueFromHeader(cookieHeader, PLAYWRIGHT_TEST_SESSION_COOKIE_NAME);
  if (!testSession) return null;

  const claims = verifyPlaywrightTestSessionToken(testSession, env);
  if (!claims) return null;

  const user = await usersService.getWithOrganization(claims.userId);
  if (!user || !user.is_active || !user.organization?.is_active) return null;

  if (user.organization_id !== claims.organizationId) {
    logger.warn("[AUTH] Playwright test session organization mismatch", {
      userId: claims.userId,
      organizationId: claims.organizationId,
    });
    return null;
  }

  return user;
}

/**
 * Get the current authenticated user from the Steward session cookie.
 *
 * Performance optimized with Redis caching:
 * 1. Check Redis cache first (avoids JWT verify AND DB call)
 * 2. On cache miss: verify JWT (jose, HS256), fetch from DB, cache result
 * 3. Session tracking is non-blocking
 *
 * Flow (on cache miss):
 * 1. Read `steward-token` cookie
 * 2. Verify JWT signature locally
 * 3. Look up user in database by Steward user ID
 * 4. If not found, JIT-sync from Steward (link by email/wallet match)
 * 5. Cache the resolved user
 */
export async function getCurrentUserFromRequest(
  request: Request,
): Promise<UserWithOrganization | null> {
  try {
    const cookieHeader = request.headers.get("cookie");
    const playwrightTestUser = await getPlaywrightTestUserFromHeader(cookieHeader);
    if (playwrightTestUser) return playwrightTestUser;

    const stewardToken = getCookieValueFromHeader(cookieHeader, "steward-token");
    if (!stewardToken) return null;

    const tokenHash = hashToken(stewardToken);
    const cacheKey = CacheKeys.session.user(tokenHash);

    // Check Redis cache first - avoids JWT AND DB calls
    const cachedUser = await redisCache.get<UserWithOrganization>(cacheKey);
    if (cachedUser) {
      logger.debug("[AUTH] Cache hit for user session");
      if (cachedUser.organization_id) {
        void trackSessionActivity(cachedUser.id, cachedUser.organization_id, stewardToken);
      }
      return cachedUser;
    }

    logger.debug("[AUTH] Verifying steward session cookie");
    const stewardClaims = await verifyStewardTokenCached(getStewardVerifyEnv(), stewardToken);
    if (!stewardClaims) return null;

    let user = await usersService.getByStewardId(stewardClaims.userId);
    if (!user) {
      try {
        user = await syncUserFromSteward({
          stewardUserId: stewardClaims.userId,
          email: stewardClaims.email,
          walletAddress: stewardClaims.walletAddress ?? stewardClaims.address,
          walletChainType: stewardClaims.walletChain,
        });
      } catch (syncErr) {
        logger.error("[AUTH] Steward JIT sync failed", { error: syncErr });
        return null;
      }
    }

    if (!user || !user.is_active) return null;

    await redisCache.set(cacheKey, user, CacheTTL.session.user);
    logger.debug("[AUTH] Cached user session data");

    if (user.organization_id) {
      void trackSessionActivity(user.id, user.organization_id, stewardToken);
      void ensureUserHasApiKey(user.id, user.organization_id);
    } else {
      logger.error("[AUTH] User missing organization_id:", user.id);
    }

    return user;
  } catch (error) {
    logger.error("[AUTH] Error:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Track session activity in background (non-blocking, debounced).
 * Uses Redis to debounce writes - only writes to DB every 60 seconds per session.
 */
async function trackSessionActivity(
  userId: string,
  organizationId: string,
  sessionToken: string,
): Promise<void> {
  try {
    const tokenHash = hashToken(sessionToken);
    const debounceKey = `session:debounce:${tokenHash}`;

    const recentlyTracked = await redisCache.get<boolean>(debounceKey);
    if (recentlyTracked) return;

    await redisCache.set(debounceKey, true, 60);

    await userSessionsService.getOrCreateSession({
      user_id: userId,
      organization_id: organizationId,
      session_token: sessionToken,
    });
  } catch (error) {
    const errorDetails =
      error instanceof Error
        ? {
            message: error.message,
            name: error.name,
            code: (error as Error & { code?: string }).code,
            detail: (error as Error & { detail?: string }).detail,
            constraint: (error as Error & { constraint?: string }).constraint,
            cause: error.cause,
          }
        : error;
    logger.warn("[AUTH] Session tracking failed:", errorDetails);
  }
}

/**
 * Require authentication - throws error if not authenticated.
 * Note: This allows anonymous users. Use requireAuthWithOrg for paid features.
 */
export async function requireAuth(request: Request): Promise<UserWithOrganization> {
  const user = await getCurrentUserFromRequest(request);
  if (!user) throw new AuthenticationError("Authentication required");
  if (!user.is_active) throw new ForbiddenError("User account is inactive");
  return user;
}

/**
 * Require authenticated user WITH organization (excludes anonymous users).
 *
 * Cookie session only — does not read `request` headers, so keys sent as `X-API-Key` or
 * `Authorization: Bearer` are not accepted. For programmatic access, use
 * `requireAuthOrApiKeyWithOrg(request)` instead. See docs/auth-api-consistency.md.
 */
export async function requireAuthWithOrg(
  request: Request,
): Promise<UserWithOrganization & { organization_id: string; organization: Organization }> {
  const user = await getCurrentUserFromRequest(request);
  if (!user) throw new AuthenticationError("Authentication required");
  if (!user.is_active) throw new ForbiddenError("User account is inactive");
  if (!user.organization_id) {
    throw new ForbiddenError("This feature requires a full account. Please sign up to continue.");
  }
  if (!user.organization || !user.organization?.is_active) {
    throw new ForbiddenError("Organization is inactive");
  }
  return user as UserWithOrganization & {
    organization_id: string;
    organization: Organization;
  };
}

/** Same as {@link requireAuthWithOrg} — explicit name for "session + org only" handlers. */
export const requireSessionAuthWithOrg: typeof requireAuthWithOrg = requireAuthWithOrg;

/**
 * Require user to belong to a specific organization.
 */
export async function requireOrganization(
  organizationId: string,
  request: Request,
): Promise<UserWithOrganization> {
  const user = await requireAuth(request);
  if (user.organization_id !== organizationId) {
    throw new ForbiddenError(`User does not have access to organization ${organizationId}`);
  }
  if (!user.organization?.is_active) {
    throw new ForbiddenError("Organization is inactive");
  }
  return user;
}

/**
 * Require user to have a specific role.
 */
export async function requireRole(
  allowedRoles: string[],
  request: Request,
): Promise<UserWithOrganization> {
  const user = await requireAuth(request);
  if (!allowedRoles.includes(user.role)) {
    throw new ForbiddenError("Insufficient permissions");
  }
  return user;
}

/**
 * Validate an API key and return the associated user with full org checks.
 */
async function validateAndGetApiKeyUser(apiKey: ApiKey): Promise<{ user: UserWithOrganization }> {
  if (!apiKey.is_active) throw new ForbiddenError("API key is inactive");
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    throw new AuthenticationError("API key has expired");
  }

  const user = await usersService.getWithOrganization(apiKey.user_id);
  if (!user) throw new AuthenticationError("User associated with API key not found");
  if (!user.is_active) throw new ForbiddenError("User account is inactive");
  if (!user.organization?.is_active) throw new ForbiddenError("Organization is inactive");

  return { user };
}

/**
 * Check if a token looks like a JWT (has three base64 parts separated by dots).
 */
function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Resolve the current user from wallet headers, API key, Bearer JWT, or Steward cookie.
 * Precedence (when wallet headers are fully present): wallet → fail-closed; otherwise:
 * X-API-Key → Bearer (eliza_* | Steward JWT) → cookie session.
 *
 * Allows anonymous users when the resolved user has no org requirement. For org-scoped
 * billing or resources, use `requireAuthOrApiKeyWithOrg`.
 */
export async function requireAuthOrApiKey(request: Request): Promise<AuthResult> {
  const hasWalletHeaders =
    request.headers.get("X-Wallet-Address") &&
    request.headers.get("X-Wallet-Signature") &&
    request.headers.get("X-Timestamp");

  if (hasWalletHeaders) {
    try {
      const walletUser = await verifyWalletSignature(request);
      if (!walletUser) throw new AuthenticationError("Wallet authentication failed");
      return { user: walletUser, authMethod: "wallet_signature" };
    } catch (e) {
      logger.error("[AUTH] Wallet auth failed with headers present - failing closed:", e);
      if (e instanceof Error && e.message.includes("Service temporarily")) {
        throw e;
      }
      throw new AuthenticationError("Invalid wallet signature");
    }
  }

  const apiKeyHeader = request.headers.get("X-API-Key");
  const authHeader = request.headers.get("authorization");

  if (apiKeyHeader && apiKeyHeader.trim().length > 0) {
    const apiKey = await apiKeysService.validateApiKey(apiKeyHeader);
    if (!apiKey) throw new AuthenticationError("Invalid or expired API key");
    const { user } = await validateAndGetApiKeyUser(apiKey);
    void apiKeysService.incrementUsageDebounced(apiKey.id);
    return { user, apiKey, authMethod: "api_key" };
  }

  if (authHeader?.startsWith("Bearer ")) {
    const bearerValue = authHeader.substring(7).trim();
    if (bearerValue.length === 0) throw new AuthenticationError("Invalid authorization header");

    if (looksLikeJwt(bearerValue)) {
      const stewardClaims = await verifyStewardTokenCached(getStewardVerifyEnv(), bearerValue);
      if (stewardClaims) {
        let user = await usersService.getByStewardId(stewardClaims.userId);
        if (!user) {
          try {
            user = await syncUserFromSteward({
              stewardUserId: stewardClaims.userId,
              email: stewardClaims.email,
              walletAddress: stewardClaims.walletAddress ?? stewardClaims.address,
              walletChainType: stewardClaims.walletChain,
            });
          } catch (syncErr) {
            logger.error("[AUTH] Steward JIT sync failed", { error: syncErr });
            throw new AuthenticationError("User not found");
          }
        }
        if (!user.is_active) throw new ForbiddenError("User account is inactive");
        if (!user.organization?.is_active) throw new ForbiddenError("Organization is inactive");
        return { user, authMethod: "session", session_token: bearerValue };
      }
    }

    // Try as API key (fallback for non-JWT tokens or if JWT validation failed)
    const apiKey = await apiKeysService.validateApiKey(bearerValue);
    if (apiKey) {
      const { user } = await validateAndGetApiKeyUser(apiKey);
      void apiKeysService.incrementUsageDebounced(apiKey.id);
      return { user, apiKey, authMethod: "api_key" };
    }

    if (looksLikeJwt(bearerValue)) {
      throw new AuthenticationError("Invalid or expired token");
    }
    throw new AuthenticationError("Invalid or expired API key");
  }

  // Fall back to session authentication (cookie-based)
  const user = await requireAuth(request);
  const sessionToken = getCookieValueFromHeader(request.headers.get("cookie"), "steward-token");

  return {
    user,
    authMethod: "session",
    session_token: sessionToken,
  };
}

/**
 * Same as `requireAuthOrApiKey` but requires an active organization on the resolved user.
 *
 * Why: Credits, deployments, voice pipelines, and org admin APIs must not run for org-less
 * accounts; throws `ForbiddenError` with a signup-oriented message instead of ambiguous 401s.
 */
export async function requireAuthOrApiKeyWithOrg(request: Request): Promise<
  AuthResult & {
    user: UserWithOrganization & {
      organization_id: string;
      organization: Organization;
    };
  }
> {
  // Dev-only bypass: allow X-Api-Key: dev-test-key to skip real auth
  if (
    process.env.NODE_ENV === "development" &&
    request.headers.get("X-Api-Key") === "dev-test-key"
  ) {
    const devUser = {
      id: "00000000-0000-0000-0000-000000000001",
      email: "dev@localhost",
      organization_id: "00000000-0000-0000-0000-000000000001",
      organization: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Dev Org",
      } as Organization,
    } as UserWithOrganization & {
      organization_id: string;
      organization: Organization;
    };
    return { user: devUser, authMethod: "api_key" as const } as AuthResult & {
      user: typeof devUser;
    };
  }

  const result = await requireAuthOrApiKey(request);

  if (!result.user.organization_id || !result.user.organization) {
    throw new ForbiddenError("This feature requires a full account. Please sign up to continue.");
  }

  return result as AuthResult & {
    user: UserWithOrganization & {
      organization_id: string;
      organization: Organization;
    };
  };
}

/**
 * Get user from request headers (for API routes).
 */
export async function getUserFromRequest(request: Request): Promise<UserWithOrganization | null> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const stewardClaims = await verifyStewardTokenCached(getStewardVerifyEnv(), token);
    if (stewardClaims) {
      const user = await usersService.getByStewardId(stewardClaims.userId);
      return user ?? null;
    }
  }

  return getCurrentUserFromRequest(request);
}

// Admin authentication - requires wallet connection and admin role

export interface AdminAuthResult {
  user: UserWithOrganization;
  isAdmin: boolean;
  role: string | null;
}

export async function requireAdmin(request: Request): Promise<AdminAuthResult> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const status = await adminService.getAdminStatusForUser(user);
  if (!status.isAdmin) throw new ForbiddenError("Admin access required");

  return { user, isAdmin: true, role: status.role };
}

export {
  invalidateStewardTokenCache,
  verifyStewardTokenCached,
} from "./auth/steward-client";
