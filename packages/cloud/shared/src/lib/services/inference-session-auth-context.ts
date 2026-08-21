/**
 * Cache-only Steward session authorization for model-inference routes.
 *
 * Every request still verifies the signed JWT locally (with the existing
 * Redis/in-memory verification cache). Cloud user, organization, and
 * moderation state are consumed only from a combined cache decision. A cold
 * Worker request returns a retryable warming result while authoritative
 * hydration runs under `waitUntil`, so Postgres never joins model dispatch.
 *
 * Cache READS and WRITES are both gated on `useAuthCache`
 * (`INFERENCE_AUTH_CACHE_ENABLED`): while the flag is off, the origin path
 * neither consults nor populates the session decision cache, mirroring the
 * API-key path in `inference-auth-context.ts`. A disabled authorization cache
 * must leave no positive identities behind in KV.
 */

import { AuthenticationError, ForbiddenError } from "../api/cloud-worker-errors";
import { loadVerifiedStagingSessionUser } from "../auth/staging-session-binding";
import { verifyStewardTokenCached } from "../auth/steward-client";
import { readStewardAccessCookieFromHeader } from "../auth/steward-cookies";
import { cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import { loadInferenceAdmissionSnapshot } from "./inference-admission-snapshot";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceSessionAuthContext,
  type InferenceSessionAuthDecision,
  readInferenceSessionAuthDecision,
  writeInferenceSessionAuthDecision,
} from "./inference-auth-cache";
import {
  assertInferenceCredentialActive,
  InferenceCredentialRevokedError,
} from "./inference-credential-revocation";
import { usersService } from "./users";

const sessionHydrations = new Map<string, Promise<InferenceSessionAuthDecision>>();
const AUTH_CONTEXT_REFRESH_AFTER_MS = 30_000;

export interface ResolveInferenceSessionAuthOptions {
  cacheOnly?: boolean;
  useAuthCache?: boolean;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

export type InferenceSessionAuthResolution =
  | { kind: "not_session" }
  | {
      kind: "authorized";
      ctx: InferenceSessionAuthContext;
      source: "cache" | "origin";
    }
  | { kind: "suspended"; userId?: string }
  | { kind: "rejected"; status: 401 | 403 }
  | {
      kind: "warming";
      hydration?: Promise<InferenceSessionAuthDecision | undefined>;
    };

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/** Extract the same Steward bearer/cookie credential as the Hono auth layer. */
export function extractInferenceSessionCredential(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  if (bearer?.startsWith("eliza_")) return null;
  if (bearer && looksLikeJwt(bearer)) return bearer;

  const env = getCloudAwareEnv();
  return readStewardAccessCookieFromHeader(req.headers.get("cookie"), env.ENVIRONMENT) ?? null;
}

function rejection(stewardUserId: string, status: 401 | 403): InferenceSessionAuthDecision {
  return {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    stewardUserId,
    decision: "rejected",
    status,
  };
}

async function hydrateAuthoritativeDecision(params: {
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
}): Promise<InferenceSessionAuthDecision> {
  let user = await usersService.getByStewardId(params.stewardUserId);
  if (!user) {
    const { syncUserFromSteward } = await import("../steward-sync");
    user = await syncUserFromSteward({
      stewardUserId: params.stewardUserId,
      email: params.email,
      walletAddress: params.walletAddress,
      walletChainType: params.walletChain,
    });
  }
  if (!user) return rejection(params.stewardUserId, 401);
  if (!user.is_active) return rejection(params.stewardUserId, 403);
  if (!user.organization_id || !user.organization) {
    return rejection(params.stewardUserId, 403);
  }
  if (!user.organization.is_active) {
    return rejection(params.stewardUserId, 403);
  }
  if (await adminService.shouldBlockUser(user.id)) {
    return {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      stewardUserId: params.stewardUserId,
      decision: "suspended",
      status: 403,
    };
  }
  return {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    userId: user.id,
    orgId: user.organization_id,
    apiKeyId: null,
    stewardUserId: params.stewardUserId,
  };
}

function toResolution(
  decision: InferenceSessionAuthDecision,
  source: "cache" | "origin",
): InferenceSessionAuthResolution {
  if ("apiKeyId" in decision) {
    return { kind: "authorized", ctx: decision, source };
  }
  if (decision.decision === "suspended") {
    return { kind: "suspended" };
  }
  return { kind: "rejected", status: decision.status };
}

async function enforceStrongSessionBoundary(
  decision: InferenceSessionAuthDecision,
  stewardUserId: string,
  issuedAt: number,
  source: "cache" | "origin",
): Promise<InferenceSessionAuthResolution> {
  const resolved = toResolution(decision, source);
  if (resolved.kind !== "authorized") return resolved;
  try {
    await assertInferenceCredentialActive(resolved.ctx.orgId, {
      kind: "steward_session",
      userId: resolved.ctx.userId,
      stewardUserId,
      issuedAt,
    });
    return resolved;
  } catch (error) {
    if (error instanceof InferenceCredentialRevokedError) {
      return error.reason === "session_revoked" || error.reason === "session_binding_revoked"
        ? { kind: "rejected", status: 401 }
        : { kind: "suspended", userId: resolved.ctx.userId };
    }
    throw error;
  }
}

async function hydrateAndCache(
  params: {
    stewardUserId: string;
    email?: string;
    walletAddress?: string;
    walletChain?: "ethereum" | "solana";
  },
  persistDecision: boolean,
): Promise<InferenceSessionAuthDecision> {
  const authoritative = await hydrateAuthoritativeDecision(params);
  const decision =
    persistDecision && "apiKeyId" in authoritative
      ? {
          ...authoritative,
          admission: await loadInferenceAdmissionSnapshot(authoritative.orgId),
        }
      : authoritative;
  if (persistDecision) await writeInferenceSessionAuthDecision(decision);
  return decision;
}

// Coalesced by subject only: `persistDecision` derives from the env flag, which
// is constant within an isolate, so concurrent hydrations always agree on it.
function getOrCreateHydration(
  params: {
    stewardUserId: string;
    email?: string;
    walletAddress?: string;
    walletChain?: "ethereum" | "solana";
  },
  persistDecision: boolean,
): Promise<InferenceSessionAuthDecision> {
  const existing = sessionHydrations.get(params.stewardUserId);
  if (existing) return existing;

  const hydration = hydrateAndCache(params, persistDecision);
  sessionHydrations.set(params.stewardUserId, hydration);
  const clear = () => {
    if (sessionHydrations.get(params.stewardUserId) === hydration) {
      sessionHydrations.delete(params.stewardUserId);
    }
  };
  hydration.then(clear, clear);
  return hydration;
}

/** Test hook for isolating coalesced background hydrations. */
export function __clearInferenceSessionAuthHydrations(): void {
  sessionHydrations.clear();
}

/**
 * Resolve a Steward session without allowing authoritative work onto a Worker
 * request promise. `cacheOnly` callers either receive a verified cache decision
 * or a warming result; there is no database fallback.
 */
export async function resolveInferenceSessionAuthContext(
  req: Request,
  options: ResolveInferenceSessionAuthOptions = {},
): Promise<InferenceSessionAuthResolution> {
  const token = extractInferenceSessionCredential(req);
  if (!token) return { kind: "not_session" };

  const env = getCloudAwareEnv();
  const claims = await verifyStewardTokenCached(
    {
      NODE_ENV: env.NODE_ENV,
      ENVIRONMENT: env.ENVIRONMENT,
      STEWARD_SESSION_SECRET: env.STEWARD_SESSION_SECRET,
      STEWARD_JWT_SECRET: env.STEWARD_JWT_SECRET,
      ELIZA_SERVICE_JWT_SECRET: env.ELIZA_SERVICE_JWT_SECRET,
      STEWARD_TENANT_ID: env.STEWARD_TENANT_ID,
      STAGING_SESSION_EXCHANGE_ENABLED: env.STAGING_SESSION_EXCHANGE_ENABLED,
      STAGING_SESSION_EXCHANGE_VERSION: env.STAGING_SESSION_EXCHANGE_VERSION,
      STAGING_SESSION_EXCHANGE_SIGNING_SECRET: env.STAGING_SESSION_EXCHANGE_SIGNING_SECRET,
      STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: env.STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID,
      STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS:
        env.STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS,
      STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: env.STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS,
      STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS:
        env.STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS,
    },
    token,
    {
      executionCtx: options.executionCtx,
      skipDistributedCache: true,
    },
  );
  if (!claims) return { kind: "rejected", status: 401 };

  if (claims.stagingSessionBinding) {
    // QA bindings are continuously primary-store-authorized and must never be
    // translated through the Steward-subject inference cache or JIT hydration.
    const user = await loadVerifiedStagingSessionUser({
      binding: claims.stagingSessionBinding,
      stewardUserId: claims.userId,
    });
    if (!user?.organization_id || !user.organization) {
      return { kind: "rejected", status: 401 };
    }
    if (await adminService.shouldBlockUser(user.id)) {
      return { kind: "suspended", userId: user.id };
    }
    return await enforceStrongSessionBoundary(
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: user.id,
        orgId: user.organization_id,
        apiKeyId: null,
        stewardUserId: claims.userId,
        admission: await loadInferenceAdmissionSnapshot(user.organization_id),
      },
      claims.userId,
      claims.issuedAt,
      "origin",
    );
  }

  if (options.useAuthCache && cache.isAvailable()) {
    const cached = await readInferenceSessionAuthDecision(claims.userId).catch((error) => {
      // error-policy:J4 inference remains explicitly unavailable on a cache
      // failure; never fall through to an inline database authorization.
      logger.warn("[InferenceSessionAuth] Cache read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (cached) {
      if (options.executionCtx && Date.now() - cached.cachedAt >= AUTH_CONTEXT_REFRESH_AFTER_MS) {
        const refresh = getOrCreateHydration(
          {
            stewardUserId: claims.userId,
            email: claims.email,
            walletAddress: claims.walletAddress,
            walletChain: claims.walletChain,
          },
          true,
        )
          .then(() => undefined)
          .catch((error) => {
            // error-policy:J7 the cached decision already resolved this request;
            // authoritative refresh failure is observed without adding latency.
            logger.warn("[InferenceSessionAuth] Background refresh failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        options.executionCtx.waitUntil(refresh);
      }
      return await enforceStrongSessionBoundary(cached, claims.userId, claims.issuedAt, "cache");
    }
  }

  if (options.useAuthCache && options.cacheOnly) {
    if (cache.isAvailable() && options.executionCtx) {
      const hydrationDecision = getOrCreateHydration(
        {
          stewardUserId: claims.userId,
          email: claims.email,
          walletAddress: claims.walletAddress,
          walletChain: claims.walletChain,
        },
        true,
      );
      const observed = hydrationDecision
        .then(() => undefined)
        .catch((error) => {
          // error-policy:J7 authoritative hydration is observed by waitUntil;
          // the current request already returned an explicit warming state.
          logger.warn("[InferenceSessionAuth] Background hydration failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      options.executionCtx.waitUntil(observed);
      return {
        kind: "warming",
        hydration: hydrationDecision.then(
          (decision) => decision,
          (error) => {
            // error-policy:J7 a failed hydration stays a retryable warming
            // outcome for cache-only callers instead of becoming an opaque 500.
            logger.warn("[InferenceSessionAuth] Inline hydration await failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          },
        ),
      };
    }
    return { kind: "warming" };
  }

  // Origin path: persist the decision only when the auth cache is enabled —
  // a disabled cache must not be pre-populated with positive identities
  // (mirrors the API-key path's flag-gated positive write).
  const decision = await getOrCreateHydration(
    {
      stewardUserId: claims.userId,
      email: claims.email,
      walletAddress: claims.walletAddress,
      walletChain: claims.walletChain,
    },
    options.useAuthCache === true,
  );
  const resolved = await enforceStrongSessionBoundary(
    decision,
    claims.userId,
    claims.issuedAt,
    "origin",
  );
  if (resolved.kind === "rejected") {
    if (resolved.status === 401) throw AuthenticationError();
    throw ForbiddenError();
  }
  return resolved;
}
