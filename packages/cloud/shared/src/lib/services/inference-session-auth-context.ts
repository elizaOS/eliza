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

import { usersRepository } from "../../db/repositories/users";
import { AuthenticationError, ForbiddenError } from "../api/cloud-worker-errors";
import { loadVerifiedStagingSessionUser } from "../auth/staging-session-binding";
import { verifyStewardTokenCached } from "../auth/steward-client";
import { readStewardAccessCookieFromHeader } from "../auth/steward-cookies";
import { cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import { loadInferenceAdmissionSnapshot } from "./inference-admission-snapshot";
import type { InferenceAuthRejectionReason } from "./inference-auth-cache";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceSessionAuthContext,
  type InferenceSessionAuthDecision,
  readInferenceSessionAuthDecision,
  writeInferenceSessionAuthDecision,
} from "./inference-auth-cache";
import {
  assertInferenceCredentialActive,
  type InferenceCredentialCheck,
  InferenceCredentialRevokedError,
  isInferenceStrongRevocationEnabled,
} from "./inference-credential-revocation";

interface SessionHydration {
  readonly decision: Promise<InferenceSessionAuthDecision>;
  readonly projection: Promise<void>;
}

const sessionHydrations = new Map<string, SessionHydration>();
const AUTH_CONTEXT_REFRESH_AFTER_MS = 30_000;

export interface ResolveInferenceSessionAuthOptions {
  cacheOnly?: boolean;
  useAuthCache?: boolean;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /** The caller will fuse this strong check into its admission lease. */
  deferStrongCredentialCheck?: boolean;
}

export type InferenceSessionContinuationResolution =
  | {
      kind: "authorized";
      ctx: InferenceSessionAuthContext;
      source: "cache" | "origin";
      credential?: InferenceCredentialCheck;
    }
  | { kind: "suspended"; userId?: string; reason?: InferenceAuthRejectionReason }
  | { kind: "rejected"; status: 401 | 403; reason?: InferenceAuthRejectionReason };

export type InferenceSessionAuthResolution =
  | { kind: "not_session" }
  | InferenceSessionContinuationResolution
  | {
      kind: "warming";
      hydration?: Promise<InferenceSessionAuthDecision | undefined>;
      continuation?: Promise<InferenceSessionContinuationResolution | undefined>;
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

function rejection(
  stewardUserId: string,
  status: 401 | 403,
  reason?: InferenceAuthRejectionReason,
): InferenceSessionAuthDecision {
  return {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    stewardUserId,
    decision: "rejected",
    status,
    ...(reason ? { reason } : {}),
  };
}

async function hydrateAuthoritativeDecision(params: {
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
}): Promise<InferenceSessionAuthDecision> {
  let user = await usersRepository.findByStewardIdWithOrganizationForWrite(params.stewardUserId);
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
  if (!user.is_active) return rejection(params.stewardUserId, 403, "account_inactive");
  if (!user.organization_id || !user.organization) {
    return rejection(params.stewardUserId, 403, "membership_missing");
  }
  if (!user.organization.is_active) {
    return rejection(params.stewardUserId, 403, "organization_inactive");
  }
  if (await adminService.shouldBlockUser(user.id)) {
    return {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      stewardUserId: params.stewardUserId,
      decision: "suspended",
      status: 403,
      reason: "moderation_blocked",
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
): InferenceSessionContinuationResolution {
  if ("apiKeyId" in decision) {
    return { kind: "authorized", ctx: decision, source };
  }
  if (decision.decision === "suspended") {
    return { kind: "suspended", reason: decision.reason };
  }
  return { kind: "rejected", status: decision.status, reason: decision.reason };
}

async function enforceStrongSessionBoundary(
  decision: InferenceSessionAuthDecision,
  stewardUserId: string,
  issuedAt: number,
  source: "cache" | "origin",
  deferStrongCredentialCheck = false,
): Promise<InferenceSessionContinuationResolution> {
  const resolved = toResolution(decision, source);
  if (resolved.kind !== "authorized") return resolved;
  const credential: InferenceCredentialCheck = {
    kind: "steward_session",
    userId: resolved.ctx.userId,
    stewardUserId,
    issuedAt,
  };
  if (deferStrongCredentialCheck) return { ...resolved, credential };
  try {
    await assertInferenceCredentialActive(resolved.ctx.orgId, credential);
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

async function hydrateDecision(
  params: {
    stewardUserId: string;
    email?: string;
    walletAddress?: string;
    walletChain?: "ethereum" | "solana";
  },
  persistDecision: boolean,
): Promise<InferenceSessionAuthDecision> {
  const authoritative = await hydrateAuthoritativeDecision(params);
  return persistDecision && "apiKeyId" in authoritative
    ? {
        ...authoritative,
        admission: await loadInferenceAdmissionSnapshot(authoritative.orgId),
      }
    : authoritative;
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
  issuedAt: number,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
): SessionHydration {
  const existing = sessionHydrations.get(params.stewardUserId);
  if (existing) {
    executionCtx?.waitUntil(existing.projection);
    return existing;
  }

  const decision = hydrateDecision(params, persistDecision);
  const projection = decision
    .then(async (resolvedDecision) => {
      if (!persistDecision) return;
      if ("apiKeyId" in resolvedDecision) {
        const strong = await enforceStrongSessionBoundary(
          resolvedDecision,
          params.stewardUserId,
          issuedAt,
          "origin",
          false,
        );
        if (strong.kind !== "authorized") return;
      }
      const outcome = await writeInferenceSessionAuthDecision(resolvedDecision);
      if (outcome.kind !== "written") {
        logger.warn("[InferenceSessionAuth] Decision cache write failed", {
          cacheWrite: outcome.kind,
        });
      }
    })
    .catch((error) => {
      // error-policy:J7 the authoritative decision is consumed separately;
      // projection rejection stays fail-closed and cannot reject waitUntil.
      logger.warn("[InferenceSessionAuth] Deferred cache projection failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  const hydration: SessionHydration = { decision, projection };
  sessionHydrations.set(params.stewardUserId, hydration);
  executionCtx?.waitUntil(projection);
  const clear = () => {
    if (sessionHydrations.get(params.stewardUserId) === hydration) {
      sessionHydrations.delete(params.stewardUserId);
    }
  };
  projection.then(clear, clear);
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
  const deferStrongCredentialCheck =
    options.useAuthCache === true &&
    options.deferStrongCredentialCheck === true &&
    isInferenceStrongRevocationEnabled(env);
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
      deferStrongCredentialCheck,
    );
  }

  if (options.useAuthCache && cache.isAvailable()) {
    const cached = await readInferenceSessionAuthDecision(
      claims.userId,
      options.executionCtx,
    ).catch((error) => {
      // error-policy:J4 inference remains explicitly unavailable on a cache
      // failure; never fall through to an inline database authorization.
      logger.warn("[InferenceSessionAuth] Cache read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (cached) {
      if (options.executionCtx && Date.now() - cached.cachedAt >= AUTH_CONTEXT_REFRESH_AFTER_MS) {
        getOrCreateHydration(
          {
            stewardUserId: claims.userId,
            email: claims.email,
            walletAddress: claims.walletAddress,
            walletChain: claims.walletChain,
          },
          true,
          claims.issuedAt,
          options.executionCtx,
        );
      }
      return await enforceStrongSessionBoundary(
        cached,
        claims.userId,
        claims.issuedAt,
        "cache",
        deferStrongCredentialCheck,
      );
    }
  }

  if (options.useAuthCache && options.cacheOnly) {
    if (cache.isAvailable() && options.executionCtx) {
      const hydration = getOrCreateHydration(
        {
          stewardUserId: claims.userId,
          email: claims.email,
          walletAddress: claims.walletAddress,
          walletChain: claims.walletChain,
        },
        true,
        claims.issuedAt,
        options.executionCtx,
      );
      return {
        kind: "warming",
        hydration: hydration.projection.then(
          () => undefined,
          () => undefined,
        ),
        continuation: hydration.decision.then(
          (decision) =>
            enforceStrongSessionBoundary(
              decision,
              claims.userId,
              claims.issuedAt,
              "origin",
              deferStrongCredentialCheck,
            ),
          (error) => {
            // error-policy:J7 the retained hydration above owns failure logging;
            // a request continuation keeps the original warming outcome.
            logger.warn("[InferenceSessionAuth] Continuation hydration failed", {
              errorName: error instanceof Error ? error.name : "UnknownError",
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
  const hydration = getOrCreateHydration(
    {
      stewardUserId: claims.userId,
      email: claims.email,
      walletAddress: claims.walletAddress,
      walletChain: claims.walletChain,
    },
    options.useAuthCache === true,
    claims.issuedAt,
    options.executionCtx,
  );
  const decision = await hydration.decision;
  if (!options.executionCtx) await hydration.projection;
  const resolved = await enforceStrongSessionBoundary(
    decision,
    claims.userId,
    claims.issuedAt,
    "origin",
    deferStrongCredentialCheck,
  );
  if (resolved.kind === "rejected") {
    if (resolved.status === 401) throw AuthenticationError();
    throw ForbiddenError();
  }
  return resolved;
}
