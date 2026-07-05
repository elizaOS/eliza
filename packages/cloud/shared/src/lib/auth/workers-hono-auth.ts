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
import type { AppContext, AuthedUser, Bindings } from "../../types/cloud-worker-env";
import { ApiError, AuthenticationError, ForbiddenError } from "../api/cloud-worker-errors";
import { logger } from "../utils/logger";
import { timingSafeEqualSecret } from "./cron";
import {
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
  type PlaywrightTestAuthEnv,
  verifyPlaywrightTestSessionToken,
} from "./playwright-test-session";
import { verifyStewardTokenCached } from "./steward-client";
import { readStewardAccessCookieFromHeader } from "./steward-cookies";

function readStewardCookie(c: AppContext): string | null {
  return (
    readStewardAccessCookieFromHeader(
      c.req.header("cookie") ?? null,
      c.env?.ENVIRONMENT,
    ) ?? null
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

function testAuthEnv(env: Bindings): PlaywrightTestAuthEnv {
  return {
    PLAYWRIGHT_TEST_AUTH:
      typeof env.PLAYWRIGHT_TEST_AUTH === "string" ? env.PLAYWRIGHT_TEST_AUTH : undefined,
    PLAYWRIGHT_TEST_AUTH_SECRET:
      typeof env.PLAYWRIGHT_TEST_AUTH_SECRET === "string"
        ? env.PLAYWRIGHT_TEST_AUTH_SECRET
        : undefined,
  };
}

async function getPlaywrightTestUser(c: AppContext): Promise<AuthedUser | null> {
  if (c.env.PLAYWRIGHT_TEST_AUTH !== "true") return null;

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

  const { usersService } = await import("../services/users");
  let user = await usersService.getByStewardId(claims.userId);
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

export async function requireUserOrApiKeyWithOrg(c: AppContext): Promise<
  AuthedUser & {
    organization_id: string;
    organization: NonNullable<AuthedUser["organization"]>;
  }
> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const bearer = readBearer(c);
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;

  if (apiKey) {
    const { apiKeysService } = await import("../services/api-keys");
    const validated = await apiKeysService.validateApiKey(apiKey);
    if (!validated) throw AuthenticationError("Invalid or expired API key");
    if (!validated.is_active) throw ForbiddenError("API key is inactive");
    if (validated.expires_at && new Date(validated.expires_at) < new Date()) {
      throw AuthenticationError("API key has expired");
    }
    const { usersService } = await import("../services/users");
    const user = await usersService.getWithOrganization(validated.user_id);
    if (!user) throw AuthenticationError("User associated with API key not found");
    if (!user.is_active) throw ForbiddenError("User account is inactive");
    if (!user.organization?.is_active) throw ForbiddenError("Organization is inactive");
    if (!user.organization_id) {
      throw ForbiddenError("This feature requires a full account. Please sign up to continue.");
    }
    trackApiKeyUsage(c, validated.id, () => apiKeysService.incrementUsageDebounced(validated.id));
    const authed = toAuthedUser(user);
    c.set("user", authed);
    c.set("authMethod", "api_key");
    // Expose the validated key id for downstream attribution/audit.
    c.set("apiKeyId", validated.id);
    return authed as AuthedUser & {
      organization_id: string;
      organization: NonNullable<AuthedUser["organization"]>;
    };
  }

  return requireUserWithOrg(c);
}

export async function requireUserOrApiKey(c: AppContext): Promise<AuthedUser> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const bearer = readBearer(c);
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;

  if (apiKey) {
    const { apiKeysService } = await import("../services/api-keys");
    const validated = await apiKeysService.validateApiKey(apiKey);
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
