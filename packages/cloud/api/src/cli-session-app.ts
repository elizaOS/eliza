/**
 * Thin Hono shell for the CLI-session login hot path (#22948).
 *
 * The desktop/CLI login flow uses `POST /api/auth/cli-session` plus the
 * `GET`/`PATCH`/`DELETE /api/auth/cli-session/:id` lifecycle from varied colos, so with
 * Smart Placement it lands on a cold isolate nearly every request and pays the
 * monolithic bootstrap (677 route modules) as multi-second dispatch time —
 * invisible in `full_app_module_init` because workerd's clock freezes across
 * pure CPU. Same mechanism and same remedy as the thin Steward shell
 * (`steward/thin-app.ts`, #18049) and the thin inference entry.
 *
 * The route modules are mounted as-is; the create route carries its own STRICT
 * Redis limiter. The authenticated `/:sessionId/complete` mutation stays on
 * the full app (see `cli-session-paths.ts`).
 *
 * Deliberately absent from the bootstrap-app stack: the global authMiddleware
 * — both routes are pre-auth by design and resolve nothing from a session.
 * The cookie-mutation CSRF guard is NOT optional the same way (the create is
 * a POST under /api/) and is re-mounted below, like the thin inference entry
 * does. Note the create limiter's Redis-outage fallback bucket is per-isolate,
 * which this cold-isolate-heavy path dilutes — the Cloudflare-native 600/min
 * GLOBAL_RATE_LIMITER backstop below is the enforceable per-IP floor.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { runWithDbCacheAsync } from "@/db/client";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { hasRedisConfig } from "@/lib/cache/redis-factory";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import {
  getIpKey,
  getRequestIp,
  rateLimit,
  rateLimitConfigVerdict,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { observeCloudRequest } from "@/lib/observability/cloud-backend-observability";
import { resolveElizaTraceId } from "@/lib/observability/http-telemetry";
import { httpTelemetryMiddleware } from "@/lib/observability/http-telemetry-hono";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { runWithRequestContext } from "@/lib/runtime/request-context";
import { setRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";
import { describeUnhandledError } from "@/lib/utils/unhandled-error-detail";
import type { AppEnv } from "@/types/cloud-worker-env";
import cliSessionPollRoute from "../auth/cli-session/[sessionId]/route";
import cliSessionCreateRoute from "../auth/cli-session/route";
import { cookieMutationGuardMiddleware } from "./middleware/cookie-mutation-guard";

export function createCliSessionThinApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
    let canDeferRequestTask = false;
    try {
      canDeferRequestTask = typeof c.executionCtx?.waitUntil === "function";
    } catch {
      // error-policy:J4 Local/test Hono requests intentionally have no
      // Worker context; shared services retain their inline-await fallback.
    }
    await runWithCloudBindingsAsync(
      c.env as Record<string, unknown>,
      async () =>
        runWithRequestContext(
          {
            clientIp: getRequestIp(c),
            idempotencyKey:
              c.req.header("idempotency-key") ||
              c.req.header("x-request-id") ||
              crypto.randomUUID(),
            ...(canDeferRequestTask
              ? {
                  defer: (task: Promise<unknown>) =>
                    c.executionCtx.waitUntil(task),
                }
              : {}),
          },
          async () => runWithDbCacheAsync(async () => next()),
        ),
    );
  });

  app.use("*", requestId());
  app.use("*", httpTelemetryMiddleware());
  app.use("*", corsMiddleware);
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginResourcePolicy: "cross-origin",
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );

  // Neither mounted route sets Cache-Control, so this is an unconditional
  // no-store on the poll's API-key-bearing 200; the has() guard only keeps the
  // shell drop-in compatible with a route that sets its own policy.
  app.use("*", async (c, next) => {
    await next();
    if (
      !c.res.headers.has("Cache-Control") &&
      c.res.headers.get("Content-Type")?.includes("application/json")
    ) {
      c.res.headers.set("Cache-Control", "no-store");
    }
  });

  app.use("*", honoLogger());
  app.use("*", async (c, next) => {
    const reqId = c.get("requestId") ?? crypto.randomUUID();
    const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
    c.set("requestId", reqId);
    c.set("traceId", traceId);
    return observeCloudRequest(
      {
        id: reqId,
        traceId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      },
      async () => {
        await next();
        return {
          result: undefined,
          status: c.res.status,
          userId: null,
          organizationId: null,
          authMethod: null,
        };
      },
    );
  });

  // Same production Redis fail-closed contract as bootstrap-app and the thin
  // Steward shell (#9853): the create route's STRICT limiter is load-bearing,
  // so never serve it with rate limiting silently disabled.
  let rateLimitConfigLogged = false;
  app.use("*", async (c, next) => {
    const verdict = rateLimitConfigVerdict({
      environment: c.env.ENVIRONMENT,
      redisRateLimiting: c.env.REDIS_RATE_LIMITING,
      hasRedisClient: hasRedisConfig(c.env),
    });
    if (!rateLimitConfigLogged) {
      rateLimitConfigLogged = true;
      if (verdict === "fail-closed") {
        logger.error(
          "[cli-session-thin-app] FATAL: REDIS_RATE_LIMITING=true in production but no Redis client is reachable (set the REDIS_URL secret). Failing closed.",
        );
      } else if (verdict === "warn-disabled") {
        logger.warn(
          '[cli-session-thin-app] Rate limiting is DISABLED in production (REDIS_RATE_LIMITING!="true") — limiters fall open.',
        );
      }
    }
    if (verdict === "fail-closed") {
      return c.json(
        {
          error: "Rate limiting misconfigured",
          code: "RATE_LIMIT_UNAVAILABLE",
        },
        503,
      );
    }
    await next();
  });

  // Global IP backstop (600/min) — same ceiling/namespace as bootstrap-app so
  // the thin path is not unmetered.
  app.use(
    "*",
    rateLimit(
      {
        windowMs: 60_000,
        maxRequests: 600,
        keyGenerator: (c) => `global:${getIpKey(c)}`,
      },
      { bindingName: "GLOBAL_RATE_LIMITER" },
    ),
  );

  // CSRF guard directly before the routes, like the thin inference entry:
  // mounted here (after the global limiter and observeCloudRequest) its 403s
  // stay metered and observed exactly as on the full app.
  app.use("*", cookieMutationGuardMiddleware);

  // Poll mounts FIRST: the create sub-app registers its STRICT limiter with a
  // path-less app.use, which Hono merges as /api/auth/cli-session/* — mounted
  // the other way round it would wrap the 2s-interval poll and 429 every
  // login ~20s in. Same registration order as the generated full-app router.
  app.route("/api/auth/cli-session/:sessionId", cliSessionPollRoute);
  app.route("/api/auth/cli-session", cliSessionCreateRoute);

  app.notFound((c) =>
    c.json(
      { success: false, error: "Not found", code: "resource_not_found" },
      404,
    ),
  );
  app.onError((err, c) => {
    if (
      err instanceof ApiError ||
      (err instanceof HTTPException && err.status < 500)
    ) {
      logger.debug("[CliSessionThinApp] Request rejected", {
        status: err.status,
        message: err.message,
      });
      return failureResponse(c, err);
    }
    logger.error("[CliSessionThinApp] Unhandled error", {
      error: describeUnhandledError(err),
    });
    return failureResponse(c, err);
  });

  return app;
}
