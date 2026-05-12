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

import { type JWTPayload, jwtVerify } from "jose";

import type { UserWithOrganization } from "@/db/repositories/users";
import { ApiError, AuthenticationError, ForbiddenError } from "@/lib/api/cloud-worker-errors";
import {
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
  type PlaywrightTestAuthEnv,
  verifyPlaywrightTestSessionToken,
} from "@/lib/auth/playwright-test-session";
import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AuthedUser, Bindings } from "@/types/cloud-worker-env";

const STEWARD_AUTH_TTL_SECS = 300;

interface StewardClaims {
  userId: string;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
  tenantId?: string;
  expiration: number;
}

interface CachedStewardClaims extends StewardClaims {
  cachedAt: number;
}

let _stewardSecret: { raw: string; key: Uint8Array } | null = null;
function nonEmptySecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getStewardSecret(env: Bindings): Uint8Array | null {
  // Mirror @stwd/auth getJwtSecret() and the shared Steward verifier:
  // STEWARD_JWT_SECRET is canonical; STEWARD_SESSION_SECRET is the legacy
  // fallback. If both are configured, choosing SESSION first makes routes that
  // authenticate via workers-hono-auth (notably CLI login completion) reject
  // valid Steward JWTs even though /api/auth/steward-session accepts them.
  const raw = nonEmptySecret(env.STEWARD_JWT_SECRET) ?? nonEmptySecret(env.STEWARD_SESSION_SECRET);
  if (!raw) return null;
  if (_stewardSecret && _stewardSecret.raw === raw) return _stewardSecret.key;
  _stewardSecret = { raw, key: new TextEncoder().encode(raw) };
  return _stewardSecret.key;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function tokenCacheKey(token: string): Promise<string> {
  const hex = await sha256Hex(token);
  return `api:auth:steward:${hex.slice(0, 32)}`;
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function walletChainClaim(payload: JWTPayload): StewardClaims["walletChain"] {
  const value = payload.walletChain ?? payload.wallet_chain;
  return value === "ethereum" || value === "solana" ? value : undefined;
}

function extractStewardClaims(payload: JWTPayload): StewardClaims | null {
  const userId = payload.sub ?? stringClaim(payload, "userId");
  if (!userId) return null;

  const walletAddress =
    stringClaim(payload, "walletAddress") ??
    stringClaim(payload, "address") ??
    stringClaim(payload, "publicKey");
  const tenantId = stringClaim(payload, "tenantId") ?? stringClaim(payload, "tenant_id");

  return {
    userId,
    email: stringClaim(payload, "email"),
    walletAddress,
    walletChain: walletChainClaim(payload),
    tenantId,
    expiration: typeof payload.exp === "number" ? payload.exp : 0,
  };
}

async function verifyStewardTokenCached(
  env: Bindings,
  token: string,
): Promise<StewardClaims | null> {
  const secret = getStewardSecret(env);
  if (!secret) return null;

  const key = cache.isAvailable() ? await tokenCacheKey(token) : null;
  const now = Math.floor(Date.now() / 1000);

  if (key) {
    const cached = await cache.get<CachedStewardClaims>(key);
    if (cached && cached.expiration > now) {
      return {
        userId: cached.userId,
        email: cached.email,
        walletAddress: cached.walletAddress,
        walletChain: cached.walletChain,
        tenantId: cached.tenantId,
        expiration: cached.expiration,
      };
    }
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    }));
  } catch {
    return null;
  }

  const claims = extractStewardClaims(payload);
  if (!claims) return null;

  // Steward issues per-user tenants of the form `personal-<userId>` scoped
  // inside the organization tenant (e.g. `elizacloud`). Accept the exact
  // configured tenant OR a `personal-<userId>` tenant whose suffix matches
  // the JWT's own userId — the canonical user-scoped Steward tenant.
  const expectedTenant = env.STEWARD_TENANT_ID;
  if (expectedTenant && claims.tenantId && claims.tenantId !== expectedTenant) {
    const isOwnPersonalTenant = claims.tenantId === `personal-${claims.userId}`;
    if (!isOwnPersonalTenant) {
      return null;
    }
  }

  if (key) {
    const tokenRemaining = claims.expiration - now;
    const ttl = Math.min(STEWARD_AUTH_TTL_SECS, tokenRemaining);
    if (ttl > 0) {
      await cache.set(
        key,
        {
          ...claims,
          cachedAt: now,
        } satisfies CachedStewardClaims,
        ttl,
      );
    }
  }

  return claims;
}

function readStewardCookie(c: AppContext): string | null {
  return readCookie(c, "steward-token");
}

function readCookie(c: AppContext, name: string): string | null {
  const cookieHeader = c.req.header("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      return decodeURIComponent(rest.join("=")) || null;
    }
  }
  return null;
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

function toAuthedUser(user: UserWithOrganization): AuthedUser {
  return {
    id: user.id,
    email: user.email ?? null,
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

  const token = readCookie(c, PLAYWRIGHT_TEST_SESSION_COOKIE_NAME);
  if (!token) return null;

  const claims = verifyPlaywrightTestSessionToken(token, testAuthEnv(c.env));
  if (!claims) return null;

  const { usersService } = await import("@/lib/services/users");
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

  const { usersService } = await import("@/lib/services/users");
  let user = await usersService.getByStewardId(claims.userId);
  if (!user) {
    try {
      const { syncUserFromSteward } = await import("@/lib/steward-sync");
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
    const { apiKeysService } = await import("@/lib/services/api-keys");
    const validated = await apiKeysService.validateApiKey(apiKey);
    if (!validated) throw AuthenticationError("Invalid or expired API key");
    if (!validated.is_active) throw ForbiddenError("API key is inactive");
    if (validated.expires_at && new Date(validated.expires_at) < new Date()) {
      throw AuthenticationError("API key has expired");
    }
    const { usersService } = await import("@/lib/services/users");
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
    const { apiKeysService } = await import("@/lib/services/api-keys");
    const validated = await apiKeysService.validateApiKey(apiKey);
    if (!validated) throw AuthenticationError("Invalid or expired API key");
    if (!validated.is_active) throw ForbiddenError("API key is inactive");
    if (validated.expires_at && new Date(validated.expires_at) < new Date()) {
      throw AuthenticationError("API key has expired");
    }
    const { usersService } = await import("@/lib/services/users");
    const user = await usersService.getWithOrganization(validated.user_id);
    if (!user) throw AuthenticationError("User associated with API key not found");
    if (!user.is_active) throw ForbiddenError("User account is inactive");
    trackApiKeyUsage(c, validated.id, () => apiKeysService.incrementUsageDebounced(validated.id));
    const authed = toAuthedUser(user);
    c.set("user", authed);
    c.set("authMethod", "api_key");
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
  const user = await requireUserOrApiKeyWithOrg(c);
  const { adminService } = await import("@/lib/services/admin");
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
    null;
  if (provided !== expected) {
    throw AuthenticationError("Invalid cron secret");
  }
}
