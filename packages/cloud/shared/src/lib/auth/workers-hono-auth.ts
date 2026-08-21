/**
 * Workers-native auth resolution — Steward only.
 *
 * Auth precedence:
 *   1. X-API-Key header                 → DB lookup (apiKeysService)
 *   2. Bearer eliza_*                   → DB lookup (apiKeysService)
 *   3. Bearer <jwt>                     → Steward verify (jose, HS256)
 *   4. Cookie `steward-token`           → Steward verify (jose, HS256)
 *
 * Steward JWT verification is local (jose) and Upstash-cached.
 *
 * Routes import `getCurrentUser(c)` / `requireUser(c)` from this module —
 * NOT from `@/lib/auth`, which still pulls Next.
 */

import { getCookie } from "hono/cookie";
import type { UserWithOrganization } from "../../db/repositories/users";
import type { ApiKey } from "../../db/schemas/api-keys";
import type { AppContext, AuthedUser, Bindings } from "../../types/cloud-worker-env";
import { ApiError, AuthenticationError, ForbiddenError } from "../api/cloud-worker-errors";
import { logger } from "../utils/logger";
import { timingSafeEqualSecret } from "./cron";
import {
  isPlaywrightTestAuthEnabled,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
  type PlaywrightTestAuthEnv,
  verifyPlaywrightTestSessionToken,
} from "./playwright-test-session";
import { loadVerifiedStagingSessionUser } from "./staging-session-binding";
import { isStagingSessionTokenCandidate, verifyStewardTokenCached } from "./steward-client";
import { readStewardAccessCookieFromHeader } from "./steward-cookies";

function readStewardCookie(c: AppContext): string | null {
  return (
    readStewardAccessCookieFromHeader(c.req.header("cookie") ?? null, c.env?.ENVIRONMENT) ?? null
  );
}

function readBearer(c: AppContext): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLocalDevAdminEnabled(c: AppContext): boolean {
  // Hard fail in production, mirroring isLocalDevAdminRequest in the global
  // middleware: NEVER grant the dev-admin bypass regardless of env vars, so
  // both layers fail closed identically (SOC2 CC6.1).
  if (c.env.NODE_ENV === "production") {
    if (c.env.ELIZA_CLOUD_LOCAL_DEV_ADMIN === "true" || c.env.LOCAL_DEV === "true") {
      logger.error("[Auth] Refusing dev-admin bypass in production — env var ignored", {
        path: new URL(c.req.url).pathname,
      });
    }
    return false;
  }
  const explicit = c.env.ELIZA_CLOUD_LOCAL_DEV_ADMIN === "true";
  const devMode = c.env.NODE_ENV !== "production" && c.env.LOCAL_DEV === "true";
  if (!explicit && !devMode) return false;
  return isLoopbackHostname(new URL(c.req.url).hostname);
}

function localDevAdminUser(): AuthedUser & {
  organization_id: string;
  organization: NonNullable<AuthedUser["organization"]>;
} {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: new Date(0),
    email: "local-dev-admin@localhost",
    organization_id: "00000000-0000-4000-8000-000000000002",
    organization: {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Local Dev",
      is_active: true,
    },
    is_active: true,
    role: "admin",
    steward_id: null,
    wallet_address: null,
    is_anonymous: false,
  };
}

function toAuthedUser(user: UserWithOrganization): AuthedUser {
  return {
    id: user.id,
    created_at: user.created_at,
    email: user.email ?? null,
    email_verified: user.email_verified ?? null,
    organization_id: user.organization_id ?? null,
    organization: user.organization
      ? {
          id: user.organization.id,
          name: user.organization.name,
          is_active: user.organization.is_active,
        }
      : null,
    is_active: user.is_active,
    role: user.role,
    steward_id: user.steward_user_id ?? null,
    wallet_address: user.wallet_address ?? null,
    is_anonymous: user.is_anonymous,
  };
}

function trackApiKeyUsage(c: AppContext, id: string, increment: () => Promise<void>): void {
  const update = increment().catch((error) => {
    logger.warn("[Auth] API key usage tracking failed", {
      apiKeyId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (typeof c.executionCtx?.waitUntil === "function") {
    c.executionCtx.waitUntil(update);
  }
}

async function validateApiKeyOrServiceUnavailable(
  apiKey: string,
): Promise<
  Awaited<ReturnType<typeof import("../services/api-keys").apiKeysService.validateApiKey>>
> {
  const { apiKeysService } = await import("../services/api-keys");
  try {
    return await apiKeysService.validateApiKey(apiKey);
  } catch (error) {
    // error-policy:J1 boundary translation — API key storage is a dependency
    // boundary. A backend outage must not be reported as invalid credentials.
    logger.error("[Auth] API key validation backend unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(
      503,
      "service_unavailable",
      "API key validation is temporarily unavailable. Please retry.",
    );
  }
}

/**
 * Resolves one explicitly presented API key and records its exact database ID.
 * Session cookies and JWTs are excluded, while two credential headers are
 * rejected so self-revocation can never select an ambiguous credential.
 */
export async function requireApiKeyCredential(c: AppContext): Promise<ApiKey> {
  const headerKey = (c.req.header("X-API-Key") ?? c.req.header("x-api-key"))?.trim() || null;
  const authorization = c.req.header("authorization")?.trim() ?? null;
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearerKey = bearerMatch?.[1]?.trim() || null;

  if (headerKey && bearerKey) {
    throw AuthenticationError("Present exactly one API key credential");
  }
  const presented = headerKey ?? bearerKey;
  if (!presented?.startsWith("eliza_")) {
    throw AuthenticationError("An API key credential is required");
  }

  const validated = await validateApiKeyOrServiceUnavailable(presented);
  if (!validated) throw AuthenticationError("Invalid or expired API key");
  if (!validated.is_active) throw ForbiddenError("API key is inactive");
  if (validated.expires_at && new Date(validated.expires_at) <= new Date()) {
    throw AuthenticationError("API key has expired");
  }
  if (!validated.id) {
    throw AuthenticationError("Validated API key has no credential identity");
  }

  c.set("authMethod", "api_key");
  c.set("apiKeyId", validated.id);
  return validated;
}

function testAuthEnv(env: Bindings): PlaywrightTestAuthEnv {
  return {
    NODE_ENV: typeof env.NODE_ENV === "string" ? env.NODE_ENV : undefined,
    ENVIRONMENT: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : undefined,
    PLAYWRIGHT_TEST_AUTH:
      typeof env.PLAYWRIGHT_TEST_AUTH === "string" ? env.PLAYWRIGHT_TEST_AUTH : undefined,
    PLAYWRIGHT_TEST_AUTH_SECRET:
      typeof env.PLAYWRIGHT_TEST_AUTH_SECRET === "string"
        ? env.PLAYWRIGHT_TEST_AUTH_SECRET
        : undefined,
  };
}

async function getPlaywrightTestUser(c: AppContext): Promise<AuthedUser | null> {
  if (!isPlaywrightTestAuthEnabled(testAuthEnv(c.env))) return null;

  const token = getCookie(c, PLAYWRIGHT_TEST_SESSION_COOKIE_NAME);
  if (!token) return null;

  const claims = verifyPlaywrightTestSessionToken(token, testAuthEnv(c.env));
  if (!claims) return null;

  const { usersService } = await import("../services/users");
  const user = await usersService.getWithOrganization(claims.userId);
  if (!user || !user.is_active || !user.organization?.is_active) return null;
  if (user.organization_id !== claims.organizationId) return null;

  return toAuthedUser(user);
}

export async function getCurrentUser(c: AppContext): Promise<AuthedUser | null> {
  const cached = c.get("user");
  if (cached !== undefined) return cached;

  const testUser = await getPlaywrightTestUser(c);
  if (testUser) {
    c.set("user", testUser);
    c.set("authMethod", "session");
    return testUser;
  }

  const bearer = readBearer(c);
  const cookieToken = readStewardCookie(c);
  const token = bearer && looksLikeJwt(bearer) ? bearer : cookieToken;

  if (!token) {
    c.set("user", null);
    return null;
  }

  const claims = await verifyStewardTokenCached(c.env, token);
  if (!claims) {
    c.set("user", null);
    return null;
  }

  let user: UserWithOrganization | undefined | null;
  if (claims.stagingSessionBinding) {
    user = await loadVerifiedStagingSessionUser({
      binding: claims.stagingSessionBinding,
      stewardUserId: claims.userId,
    });
  } else {
    const { usersService } = await import("../services/users");
    user = await usersService.getByStewardId(claims.userId);
    if (!user) {
      try {
        const { syncUserFromSteward } = await import("../steward-sync");
        user = await syncUserFromSteward({
          stewardUserId: claims.userId,
          email: claims.email,
          walletAddress: claims.walletAddress,
          walletChainType: claims.walletChain,
        });
      } catch (error) {
        logger.error("[AUTH] Steward JIT sync failed", {
          userId: claims.userId,
          error: error instanceof Error ? error.message : String(error),
        });
        c.set("user", null);
        return null;
      }
    }
  }
  if (!user) {
    c.set("user", null);
    return null;
  }

  const authed = toAuthedUser(user);
  c.set("user", authed);
  c.set("authMethod", "session");
  return authed;
}

export async function requireUser(c: AppContext): Promise<AuthedUser> {
  const user = await getCurrentUser(c);
  if (!user) throw AuthenticationError();
  if (user.is_active === false) throw ForbiddenError("User account is inactive");
  return user;
}

export async function requireUserWithOrg(c: AppContext): Promise<
  AuthedUser & {
    organization_id: string;
    organization: NonNullable<AuthedUser["organization"]>;
  }
> {
  const user = await requireUser(c);
  if (!user.organization_id || !user.organization) {
    throw new ApiError(
      403,
      "access_denied",
      "This feature requires a full account. Please sign up to continue.",
    );
  }
  if (user.organization.is_active === false) {
    throw ForbiddenError("Organization is inactive");
  }
  return user as AuthedUser & {
    organization_id: string;
    organization: NonNullable<AuthedUser["organization"]>;
  };
}

/** API-key lifecycle management always requires an interactive user session. */
export async function requireSessionUserWithOrg(c: AppContext): Promise<
  AuthedUser & {
    organization_id: string;
    organization: NonNullable<AuthedUser["organization"]>;
  }
> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const bearer = readBearer(c);
  if (apiKeyHeader || bearer?.startsWith("eliza_")) {
    throw new ApiError(
      401,
      "session_auth_required",
      "A signed-in user session is required to manage API keys.",
    );
  }

  const user = await requireUserWithOrg(c);
  if (c.get("authMethod") !== "session") {
    throw new ApiError(
      401,
      "session_auth_required",
      "A signed-in user session is required to manage API keys.",
    );
  }
  return user;
}

type AuthedUserWithOrg = AuthedUser & {
  organization_id: string;
  organization: NonNullable<AuthedUser["organization"]>;
};

async function authenticateApiKeyWithOrg<T>(
  c: AppContext,
  apiKey: string,
  orgLookup?: (organizationId: string) => Promise<T>,
): Promise<{ user: AuthedUserWithOrg; orgLookupResult?: T }> {
  const { apiKeysService } = await import("../services/api-keys");
  const validated = await validateApiKeyOrServiceUnavailable(apiKey);
  if (!validated) throw AuthenticationError("Invalid or expired API key");
  if (!validated.is_active) throw ForbiddenError("API key is inactive");
  if (validated.expires_at && new Date(validated.expires_at) < new Date()) {
    throw AuthenticationError("API key has expired");
  }

  const { usersService } = await import("../services/users");
  // The key has already passed authoritative validation, including its stored
  // organization id. Start the independent org-scoped resource read now rather
  // than serializing another cold Hyperdrive trip behind user/org hydration.
  const orgLookupPromise = orgLookup?.(validated.organization_id).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const user = await usersService.getWithOrganization(validated.user_id);
  if (!user) throw AuthenticationError("User associated with API key not found");
  if (!user.is_active) throw ForbiddenError("User account is inactive");
  if (!user.organization?.is_active) throw ForbiddenError("Organization is inactive");
  if (!user.organization_id) {
    throw ForbiddenError("This feature requires a full account. Please sign up to continue.");
  }
  // Never let the parallel lookup's key scope substitute for current user/org
  // membership. A stale/malformed key row falls back to the hydrated user's org,
  // preserving the old scope gate rather than changing authorization semantics.
  let orgLookupResult: T | undefined;
  if (user.organization_id !== validated.organization_id) {
    await orgLookupPromise;
    orgLookupResult = orgLookup ? await orgLookup(user.organization_id) : undefined;
  } else {
    const orgLookupOutcome = orgLookupPromise ? await orgLookupPromise : undefined;
    if (orgLookupOutcome && !orgLookupOutcome.ok) throw orgLookupOutcome.error;
    orgLookupResult = orgLookupOutcome?.value;
  }

  trackApiKeyUsage(c, validated.id, () => apiKeysService.incrementUsageDebounced(validated.id));
  const authed = toAuthedUser(user) as AuthedUserWithOrg;
  c.set("user", authed);
  c.set("authMethod", "api_key");
  c.set("apiKeyId", validated.id);
  return { user: authed, orgLookupResult };
}

function readApiKeyCredential(c: AppContext): string | null {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const bearer = readBearer(c);
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  return apiKeyHeader || elizaBearer;
}

/**
 * The 16-char key-hash prefix that identifies the CURRENT request's API-key
 * credential for the shared-agent scope cache (COLDPATH-FIX-2026-07-21), or
 * null when the request is not API-key authenticated (session/JWT/cookie).
 *
 * Same sha256 + 16-char-prefix derivation the api-key validation cache uses, so
 * the scope cache is keyed by the exact same credential identity. Returns null
 * (never a hash of an empty string) when there is no API key, so callers scope
 * their cache ONLY on the API-key path and fall back to the authoritative gate
 * everywhere else. Import kept local (crypto) so this stays a pure derivation.
 */
export async function apiKeyScopeHashPrefix(c: AppContext): Promise<string | null> {
  const apiKey = readApiKeyCredential(c);
  if (!apiKey) return null;
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(apiKey).digest("hex").substring(0, 16);
}

/**
 * The session credential (steward JWT / cookie) presented on THIS request, or
 * null when the request is not session-authenticated (API-key path). Mirrors
 * the same bearer/cookie selection `getCurrentUser` uses so the scope cache is
 * keyed by the exact credential that will be re-verified on a hit.
 * (#SHADOW-ACCOUNT-DEBUG: the API-key-only scope cache left session/JWT chats
 * — Shadow's own account path — paying the cold user/org+agent Hyperdrive waves
 * on EVERY turn, warm or cold, because `apiKeyScopeHashPrefix` returned null.)
 */
export function readSessionCredential(c: AppContext): string | null {
  const bearer = readBearer(c);
  const cookieToken = readStewardCookie(c);
  const token = bearer && looksLikeJwt(bearer) ? bearer : cookieToken;
  return token ?? null;
}

/**
 * 16-char hash prefix identifying the CURRENT request's SESSION credential for
 * the shared-agent scope cache, or null when there is no session token. Never a
 * hash of an empty string. Distinct namespace from the API-key prefix (callers
 * pass a `"s:"`-prefixed cache key) so a session hash can never collide with an
 * API-key hash.
 */
export async function sessionScopeHashPrefix(c: AppContext): Promise<string | null> {
  const token = readSessionCredential(c);
  if (!token) return null;
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(token).digest("hex").substring(0, 16);
}

/** Untrusted classification used only to select the stricter QA cache path. */
export function isStagingSessionScopeCandidate(c: AppContext): boolean {
  const token = readSessionCredential(c);
  return token ? isStagingSessionTokenCandidate(token) : false;
}

/**
 * Re-verify a session credential WITHOUT the cold user/org+agent hydration, for
 * a scope-cache hit (#SHADOW-ACCOUNT-DEBUG). Runs the warm-cached steward JWT
 * verify (in-mem LRU → Redis → local jose, ~0–5ms) and confirms it still
 * resolves to the SAME steward user the cache entry was written for. Returns
 * false on any not-OK state — an expired/rotated/invalid token, or a token now
 * mapping to a different user — so the caller falls back to the full
 * authoritative gate. Never skips the credential check, only the DB waves.
 */
export async function revalidateSessionScope(
  c: AppContext,
  cachedStewardUserId: string,
  cachedOrganizationId?: string,
): Promise<boolean> {
  const token = readSessionCredential(c);
  if (!token) return false;
  const claims = await verifyStewardTokenCached(c.env, token).catch(() => null);
  if (!claims) return false;
  if (claims.userId !== cachedStewardUserId) return false;
  if (!claims.stagingSessionBinding) return true;
  if (
    !cachedOrganizationId ||
    claims.stagingSessionBinding.organizationId !== cachedOrganizationId
  ) {
    return false;
  }
  const user = await loadVerifiedStagingSessionUser({
    binding: claims.stagingSessionBinding,
    stewardUserId: claims.userId,
  });
  return user?.organization_id === cachedOrganizationId;
}

export async function requireUserOrApiKeyWithOrg(c: AppContext): Promise<AuthedUserWithOrg> {
  const apiKey = readApiKeyCredential(c);
  if (apiKey) return (await authenticateApiKeyWithOrg(c, apiKey)).user;
  return requireUserWithOrg(c);
}

/**
 * Authenticate exactly like `requireUserOrApiKeyWithOrg`, while allowing an
 * independent organization-scoped read to overlap API-key user/org hydration.
 * Session auth still performs the lookup only after the session is authorized.
 */
export async function requireUserOrApiKeyWithOrgLookup<T>(
  c: AppContext,
  orgLookup: (organizationId: string) => Promise<T>,
): Promise<{ user: AuthedUserWithOrg; orgLookupResult: T }> {
  const apiKey = readApiKeyCredential(c);
  if (apiKey) {
    const result = await authenticateApiKeyWithOrg(c, apiKey, orgLookup);
    return { user: result.user, orgLookupResult: result.orgLookupResult as T };
  }
  const user = await requireUserWithOrg(c);
  return { user, orgLookupResult: await orgLookup(user.organization_id) };
}

export async function requireUserOrApiKey(c: AppContext): Promise<AuthedUser> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const bearer = readBearer(c);
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;

  if (apiKey) {
    const { apiKeysService } = await import("../services/api-keys");
    const validated = await validateApiKeyOrServiceUnavailable(apiKey);
    if (!validated) throw AuthenticationError("Invalid or expired API key");
    if (!validated.is_active) throw ForbiddenError("API key is inactive");
    if (validated.expires_at && new Date(validated.expires_at) < new Date()) {
      throw AuthenticationError("API key has expired");
    }
    const { usersService } = await import("../services/users");
    const user = await usersService.getWithOrganization(validated.user_id);
    if (!user) throw AuthenticationError("User associated with API key not found");
    if (!user.is_active) throw ForbiddenError("User account is inactive");
    trackApiKeyUsage(c, validated.id, () => apiKeysService.incrementUsageDebounced(validated.id));
    const authed = toAuthedUser(user);
    c.set("user", authed);
    c.set("authMethod", "api_key");
    c.set("apiKeyId", validated.id);
    return authed;
  }

  return requireUser(c);
}

export async function requireAdmin(c: AppContext): Promise<{
  user: AuthedUser & {
    organization_id: string;
    organization: NonNullable<AuthedUser["organization"]>;
  };
  role: string | null;
}> {
  if (isLocalDevAdminEnabled(c)) {
    const user = localDevAdminUser();
    c.set("user", user);
    c.set("authMethod", "session");
    return { user, role: "super_admin" };
  }

  const user = await requireUserOrApiKeyWithOrg(c);
  const { adminService } = await import("../services/admin");
  try {
    const status = await adminService.getAdminStatusForUser(user);
    if (!status.isAdmin) throw ForbiddenError("Admin access required");
    return { user, role: status.role };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn("[Auth] Admin lookup failed; denying admin access", {
      userId: user.id,
      email: user.email,
      walletAddress: user.wallet_address,
      error: error instanceof Error ? error.message : String(error),
    });
    throw ForbiddenError("Admin access required");
  }
}

export function requireCronSecret(c: AppContext): void {
  const expected = c.env.CRON_SECRET;
  if (!expected) {
    throw ForbiddenError("Cron secret not configured");
  }
  const provided =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
    c.req.header("x-cron-secret") ||
    "";
  if (!timingSafeEqualSecret(provided, expected)) {
    throw AuthenticationError("Invalid cron secret");
  }
}
