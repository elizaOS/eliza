/**
 * Thin Hono shell for login-critical Steward GETs (#18049).
 *
 * The monolithic bootstrap loads ~580 routes and service singletons (e.g.
 * PayoutAlerts) before the embedded Steward proxy runs. Cold isolates then
 * spend multi-second module-init on the anonymous `/steward/auth/providers`
 * path that gates the sign-in buttons.
 *
 * This shell mirrors the dependency-light protections already used by the thin
 * inference entry (`inference-app.ts`) plus the production Redis fail-closed
 * rate-limit config guard from `bootstrap-app.ts`, without evaluating
 * `_router.generated`. Mutating Steward auth still uses the full app.
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
import { embeddedStewardHandler } from "./embedded";

export function createStewardThinApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
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

  // Default JSON to no-store unless the handler set an explicit Cache-Control
  // (providers sets a ≤60s public policy; tenant config stays no-store).
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
    c.set("requestId", c.get("requestId") ?? crypto.randomUUID());
    c.set("user", undefined);
    await next();
  });
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
        const user = c.get("user");
        return {
          result: undefined,
          status: c.res.status,
          userId: user?.id ?? null,
          organizationId: user?.organization_id ?? null,
          authMethod: c.get("authMethod") ?? null,
        };
      },
    );
  });

  // Same production Redis fail-closed contract as bootstrap-app (#9853): never
  // silently serve login-critical traffic when rate limiting is marked required
  // but Redis is unreachable.
  let rateLimitConfigLogged = false;
  app.use("*", async (c, next) => {
    const env = c.env as { ENVIRONMENT?: string; REDIS_RATE_LIMITING?: string };
    const verdict = rateLimitConfigVerdict({
      environment: env.ENVIRONMENT,
      redisRateLimiting: env.REDIS_RATE_LIMITING,
      // Config presence only — avoid constructing a Redis client on every
      // login-critical request (same fail-closed decision as bootstrap-app).
      hasRedisClient: hasRedisConfig(c.env),
    });
    if (!rateLimitConfigLogged) {
      rateLimitConfigLogged = true;
      if (verdict === "fail-closed") {
        logger.error(
          "[steward-thin-app] FATAL: REDIS_RATE_LIMITING=true in production but no Redis client is reachable (set the REDIS_URL secret). Failing closed — refusing traffic rather than serving with rate limiting silently disabled.",
        );
      } else if (verdict === "warn-disabled") {
        logger.warn(
          '[steward-thin-app] Rate limiting is DISABLED in production (REDIS_RATE_LIMITING!="true") — limiters fall open. Cutover (#9853 P1.1): provision Redis, set REDIS_URL, then set REDIS_RATE_LIMITING="true" and redeploy.',
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

  // Global IP backstop (600/min) — same ceiling/namespace as bootstrap-app and
  // inference-app so thin login GETs are not unmetered.
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

  app.all("/steward", embeddedStewardHandler);
  app.all("/steward/*", embeddedStewardHandler);

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
      logger.debug("[StewardThinApp] Request rejected", {
        status: err.status,
        message: err.message,
      });
      return failureResponse(c, err);
    }
    logger.error("[StewardThinApp] Unhandled error", {
      error: describeUnhandledError(err),
    });
    return failureResponse(c, err);
  });

  return app;
}
