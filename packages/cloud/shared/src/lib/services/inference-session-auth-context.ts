/**
 * Cache-only Steward session authorization for model-inference routes.
 *
 * Every request still verifies the signed JWT locally (with the existing
 * Redis/in-memory verification cache). Cloud user, organization, and
 * moderation state are consumed only from a combined cache decision. A cold
 * Worker request returns a retryable warming result while authoritative
 * hydration runs under `waitUntil`, so Postgres never joins model dispatch.
 */

import { AuthenticationError, ForbiddenError } from "../api/cloud-worker-errors";
import { verifyStewardTokenCached } from "../auth/steward-client";
import { readStewardAccessCookieFromHeader } from "../auth/steward-cookies";
import { cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceSessionAuthContext,
  type InferenceSessionAuthDecision,
  readInferenceSessionAuthDecision,
  writeInferenceSessionAuthDecision,
} from "./inference-auth-cache";
import { usersService } from "./users";

const sessionHydrations = new Map<string, Promise<InferenceSessionAuthDecision>>();

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
  | { kind: "warming" };

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

async function hydrateAndCache(params: {
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
}): Promise<InferenceSessionAuthDecision> {
  const decision = await hydrateAuthoritativeDecision(params);
  await writeInferenceSessionAuthDecision(decision);
  return decision;
}

function getOrCreateHydration(params: {
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
}): Promise<InferenceSessionAuthDecision> {
  const existing = sessionHydrations.get(params.stewardUserId);
  if (existing) return existing;

  const hydration = hydrateAndCache(params);
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
      STEWARD_SESSION_SECRET: env.STEWARD_SESSION_SECRET,
      STEWARD_JWT_SECRET: env.STEWARD_JWT_SECRET,
      STEWARD_TENANT_ID: env.STEWARD_TENANT_ID,
    },
    token,
    { executionCtx: options.executionCtx },
  );
  if (!claims) return { kind: "rejected", status: 401 };

  if (options.useAuthCache && cache.isAvailable()) {
    const cached = await readInferenceSessionAuthDecision(claims.userId).catch((error) => {
      // error-policy:J4 inference remains explicitly unavailable on a cache
      // failure; never fall through to an inline database authorization.
      logger.warn("[InferenceSessionAuth] Cache read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (cached) return toResolution(cached, "cache");
  }

  if (options.useAuthCache && options.cacheOnly) {
    if (cache.isAvailable() && options.executionCtx) {
      const hydration = getOrCreateHydration({
        stewardUserId: claims.userId,
        email: claims.email,
        walletAddress: claims.walletAddress,
        walletChain: claims.walletChain,
      })
        .then(() => undefined)
        .catch((error) => {
          // error-policy:J7 authoritative hydration is observed by waitUntil;
          // the current request already returned an explicit warming state.
          logger.warn("[InferenceSessionAuth] Background hydration failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      options.executionCtx.waitUntil(hydration);
    }
    return { kind: "warming" };
  }

  const decision = await getOrCreateHydration({
    stewardUserId: claims.userId,
    email: claims.email,
    walletAddress: claims.walletAddress,
    walletChain: claims.walletChain,
  });
  const resolved = toResolution(decision, "origin");
  if (resolved.kind === "rejected") {
    if (resolved.status === 401) throw AuthenticationError();
    throw ForbiddenError();
  }
  return resolved;
}
