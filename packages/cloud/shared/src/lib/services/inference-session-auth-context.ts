/**
 * Cache-only Steward session authorization for model-inference routes.
 *
 * Every request still verifies the signed JWT locally (with the existing
 * Redis/in-memory verification cache). Cloud user, organization, and
 * moderation state are consumed from a combined cache decision. A cold subject
 * is decided by the primary once, inline, and its projection is written under
 * `waitUntil`; warm requests never touch Postgres. Cached decisions (positive
 * or denial) are stale-while-revalidate: an aged entry still decides the
 * request and one refresh rewrites it off-response.
 *
 * Cache READS and WRITES are both gated on `useAuthCache`, which is on wherever
 * the organization gate can revoke a cached decision (every Worker). Other
 * hosts neither consult nor populate the session decision cache.
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
  startOffResponse,
  writeInferenceSessionAuthDecision,
} from "./inference-auth-cache";
import {
  assertInferenceCredentialActive,
  hasInferenceRevocationBoundary,
  type InferenceCredentialCheck,
  InferenceCredentialRevokedError,
} from "./inference-credential-revocation";

interface SessionHydration {
  readonly decision: Promise<InferenceSessionAuthDecision>;
  readonly projection: Promise<void>;
}

const sessionHydrations = new Map<string, SessionHydration>();
const AUTH_CONTEXT_REFRESH_AFTER_MS = 30_000;

export interface ResolveInferenceSessionAuthOptions {
  useAuthCache?: boolean;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /** The caller wants the verified credential back; the session is still checked here. */
  deferStrongCredentialCheck?: boolean;
  /** Return verified JWT identity metadata after the normal authorization boundary. */
  includeVerifiedCredential?: boolean;
}

export type InferenceSessionContinuationResolution =
  | {
      kind: "authorized";
      ctx: InferenceSessionAuthContext;
      source: "cache" | "origin";
      credential?: InferenceCredentialCheck;
      /**
       * Rewrites this subject's cached decision from the primary, off the
       * response. Paid admission calls it when the decision's funding
       * standing is no longer true.
       */
      refreshEntry?: () => void;
    }
  | { kind: "suspended"; userId?: string; reason?: InferenceAuthRejectionReason }
  | { kind: "rejected"; status: 401 | 403; reason?: InferenceAuthRejectionReason };

export type InferenceSessionAuthResolution =
  | { kind: "not_session" }
  | InferenceSessionContinuationResolution;

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
  if (await adminService.shouldBlockUserConsistent(user.id)) {
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
  includeVerifiedCredential = false,
): Promise<InferenceSessionContinuationResolution> {
  const resolved = toResolution(decision, source);
  if (resolved.kind !== "authorized") return resolved;
  const credential: InferenceCredentialCheck = {
    kind: "steward_session",
    userId: resolved.ctx.userId,
    stewardUserId,
    issuedAt,
  };
  // Organization admission no longer carries the credential into a lease, so
  // nothing after this point would check a deferred session: a revoked or
  // superseded session is refused here. `deferStrongCredentialCheck` only
  // asks for the verified credential to be returned.
  try {
    await assertInferenceCredentialActive(resolved.ctx.orgId, credential);
    return deferStrongCredentialCheck || includeVerifiedCredential
      ? { ...resolved, credential }
      : resolved;
  } catch (error) {
    if (error instanceof InferenceCredentialRevokedError) {
      return error.reason === "session_revoked" || error.reason === "session_binding_revoked"
        ? { kind: "rejected", status: 401, reason: "credential_inactive" }
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

  const decision = startOffResponse(() => hydrateDecision(params, persistDecision));
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
 * request promise. A cache miss is decided by the primary once and projected
 * into the cache off-response.
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
    hasInferenceRevocationBoundary();
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
    if (await adminService.shouldBlockUserConsistent(user.id)) {
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
      options.includeVerifiedCredential === true,
    );
  }

  const hydrationParams = {
    stewardUserId: claims.userId,
    email: claims.email,
    walletAddress: claims.walletAddress,
    walletChain: claims.walletChain,
  };
  // Post-response accounting rewrites the cached decision when it finds the
  // organization can no longer fund a request (or can again). A hydration
  // already in flight may predate that accounting, so the rewrite starts
  // after it.
  const executionCtx = options.executionCtx;
  const refreshEntry =
    options.useAuthCache === true && executionCtx
      ? () => {
          const inFlight = sessionHydrations.get(claims.userId)?.projection ?? Promise.resolve();
          executionCtx.waitUntil(
            inFlight.then(
              () => getOrCreateHydration(hydrationParams, true, claims.issuedAt).projection,
            ),
          );
        }
      : undefined;
  const withRefresh = (
    resolved: InferenceSessionContinuationResolution,
  ): InferenceSessionContinuationResolution =>
    resolved.kind === "authorized" && refreshEntry ? { ...resolved, refreshEntry } : resolved;

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
        getOrCreateHydration(hydrationParams, true, claims.issuedAt, options.executionCtx);
      }
      return withRefresh(
        await enforceStrongSessionBoundary(
          cached,
          claims.userId,
          claims.issuedAt,
          "cache",
          deferStrongCredentialCheck,
          options.includeVerifiedCredential === true,
        ),
      );
    }
  }

  // Origin path: persist the decision only when the auth cache is enabled —
  // a disabled cache must not be pre-populated with positive identities
  // (mirrors the API-key path's flag-gated positive write).
  const hydration = getOrCreateHydration(
    hydrationParams,
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
    options.includeVerifiedCredential === true,
  );
  if (resolved.kind === "rejected") {
    if (resolved.status === 401) throw AuthenticationError();
    throw ForbiddenError();
  }
  return withRefresh(resolved);
}
