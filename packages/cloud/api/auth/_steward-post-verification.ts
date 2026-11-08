/**
 * Steps shared by the two routes that turn a verified Steward token into a
 * Cloud login: `/api/auth/steward-session` and
 * `/api/auth/steward-nonce-exchange`. Keeping them in one place keeps the
 * rate limit, the login audit record and new-user provisioning identical for
 * every sign-in method.
 */

import { primeVerifiedUserSessionCache } from "@elizaos/cloud-shared/lib/auth/session-user-cache";
import {
  type StewardVerifyEnv,
  stewardSessionKeyFingerprint,
} from "@elizaos/cloud-shared/lib/auth/steward-client";
import {
  getIpKey,
  getRequestIp,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  type StewardSyncExecutionContext,
  syncUserFromSteward,
} from "@elizaos/cloud-shared/lib/steward-sync";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { settleOffResponsePath } from "@elizaos/cloud-shared/lib/utils/settle-off-response-path";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Context, MiddlewareHandler } from "hono";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";

type SyncInput = Parameters<typeof syncUserFromSteward>[0];
export type SyncedStewardUser = Awaited<ReturnType<typeof syncUserFromSteward>>;

/**
 * Pre-auth session-mint limiter: the global Redis bucket is the primary
 * throttle. If Redis is unreachable, login stays available but bounded by a
 * strict per-isolate bucket; top-up/payment routes stay hard fail-closed.
 */
export function stewardLoginRateLimit(
  namespace: string,
): MiddlewareHandler<AppEnv> {
  return rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: (c) => `${namespace}:${getIpKey(c)}`,
    failClosed: true,
    redisUnavailableFallback: { namespace },
  });
}

export function getWorkerExecutionContext(
  c: Context<AppEnv>,
): StewardSyncExecutionContext | undefined {
  try {
    const candidate = c.executionCtx;
    return typeof candidate?.waitUntil === "function" ? candidate : undefined;
  } catch {
    // error-policy:J4 Hono throws when a route is invoked without a Worker
    // execution context; non-Worker callers preserve inline provisioning.
    return undefined;
  }
}

/** Records a rejected Steward token. Never blocks the error response. */
export async function emitStewardLoginFailed(
  c: Context<AppEnv>,
  reason: string,
): Promise<void> {
  await getAuditDispatcher()
    .emit({
      actor: { type: "user", id: "anonymous" },
      action: "auth.login.failed",
      result: "failure",
      resource: null,
      ip: getRequestIp(c),
      user_agent: c.req.header("user-agent") ?? undefined,
      request_id: c.get("requestId"),
      metadata: { provider: "steward", reason },
    })
    // error-policy:J7 audit write must not block the 401; a dropped auth audit is logged.
    .catch((err) =>
      logger.error("[StewardSession] audit emit for failed login failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}

/**
 * Records a successful login off the response path. The required sink stays
 * owned by the Worker lifetime, but its database RTT is not account readiness.
 */
export async function emitStewardLogin(
  c: Context<AppEnv>,
  executionCtx: StewardSyncExecutionContext | undefined,
  cloudUser: SyncedStewardUser,
  method: string,
): Promise<void> {
  await settleOffResponsePath(executionCtx, async () => {
    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: cloudUser.id },
        action: "auth.login",
        result: "success",
        resource: null,
        org_id: cloudUser.organization_id ?? undefined,
        ip: getRequestIp(c),
        user_agent: c.req.header("user-agent") ?? undefined,
        request_id: c.get("requestId"),
        metadata: { provider: "steward", method },
      })
      // error-policy:J7 audit write must not block the login response; a dropped auth audit is logged.
      .catch((err) =>
        logger.error(
          "[StewardSession] audit emit for successful login failed",
          {
            userId: cloudUser.id,
            error: err instanceof Error ? err.message : String(err),
          },
        ),
      );
  });
}

/**
 * Syncs the Cloud user for a verified token. New-user provisioning beyond the
 * required account rows runs under the Worker execution context, and the
 * session cache is primed for the first authenticated request.
 */
export function syncVerifiedStewardUser(
  session: { token: string; expiration: number; env: StewardVerifyEnv },
  executionCtx: StewardSyncExecutionContext | undefined,
  input: Omit<SyncInput, "executionCtx" | "afterRequiredSignupProvisioning">,
): Promise<SyncedStewardUser> {
  return syncUserFromSteward({
    ...input,
    executionCtx,
    afterRequiredSignupProvisioning: async (user) => {
      const signingKeyFingerprint = stewardSessionKeyFingerprint(session.env);
      if (!signingKeyFingerprint) return;
      try {
        // The first authenticated browser request follows immediately.
        // Prime its authorization projection after strict API-key
        // readiness but before optional onboarding work starts, so that
        // request does not race into the slower durable cache-miss path.
        await primeVerifiedUserSessionCache(session.token, user, {
          expiration: session.expiration,
          signingKeyFingerprint,
        });
      } catch (error) {
        // error-policy:J4 Cache priming is a latency optimization. Identity is
        // already durable and the ordinary authenticated cache-miss path can
        // recover, so a cache write failure must not strand the new account.
        logger.warn("[steward-auth] New-user session cache prime failed", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
