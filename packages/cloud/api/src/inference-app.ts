/**
 * Builds the small Hono shell used by lazily loaded generative route families.
 * The entrypoint supplies exactly one route module, avoiding evaluation of the
 * monolithic generated router and unrelated authentication/audit services.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { runWithDbCacheAsync } from "@/db/client";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import {
  getIpKey,
  getRequestIp,
  rateLimit,
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
import { cookieMutationGuardMiddleware } from "./middleware/cookie-mutation-guard";

/**
 * Chat-only application loaded by the thin Worker entrypoint.
 *
 * Keep this shell in semantic lockstep with bootstrap-app. The chat route is a
 * public global-auth path and performs its own authoritative API-key/session
 * resolution, so mounting global auth here would only evaluate the unrelated
 * protected-route auth/audit tree. Billing and SSE remain wholly owned by the
 * canonical route module.
 *
 * The cookie-mutation CSRF guard is NOT optional the way global auth is: these
 * routes authenticate the ambient session cookie, and the shell parses bodies
 * content-type-agnostically, so a cross-origin "simple" request from same-site
 * hosted user content would otherwise ride a victim's cookie into billable
 * inference. The guard is lane-selecting — programmatic Bearer/API-key callers
 * pass through untouched — and mirrors the full-app verdicts exactly.
 */
export function createInferenceApp(
  mountPath: string,
  route: Hono<AppEnv>,
): Hono<AppEnv> {
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
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
    c.set("requestId", requestId);
    c.set("traceId", traceId);
    return observeCloudRequest(
      {
        id: requestId,
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

  // CSRF: same mount point as bootstrap-app (immediately before the routes,
  // after the global limiter). See middleware/cookie-mutation-guard.ts.
  app.use("*", cookieMutationGuardMiddleware);

  app.route(mountPath, route);
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
      logger.debug("[InferenceApi] Request rejected", {
        status: err.status,
        message: err.message,
      });
      return failureResponse(c, err);
    }
    logger.error("[InferenceApi] Unhandled error", {
      error: describeUnhandledError(err),
    });
    return failureResponse(c, err);
  });

  return app;
}
