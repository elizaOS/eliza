/**
 * Dependency-bounded Hono shell for authenticated personal Shared turns.
 *
 * The Railway gateway already owns provider ingress and retries. This shell
 * preserves the Cloud request context, security headers, and internal JWT
 * boundary without evaluating the generated application router before every
 * ordinary channel message.
 */

import { runWithDbCacheAsync } from "@elizaos/cloud-shared/db/client";
import {
  getIpKey,
  getRequestIp,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { httpTelemetryMiddleware } from "@elizaos/cloud-shared/lib/observability/http-telemetry-hono";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { runWithRequestContext } from "@elizaos/cloud-shared/lib/runtime/request-context";
import { setRuntimeR2Bucket } from "@elizaos/cloud-shared/lib/storage/r2-runtime-binding";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import personalSharedMessages from "../internal/eliza-app/personal-shared/messages/route";

export function createPersonalSharedApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
    await runWithCloudBindingsAsync(c.env, async () =>
      runWithRequestContext(
        {
          clientIp: getRequestIp(c),
          idempotencyKey:
            c.req.header("idempotency-key") ||
            c.req.header("x-request-id") ||
            crypto.randomUUID(),
          defer: (task) => c.executionCtx.waitUntil(task),
        },
        async () => runWithDbCacheAsync(async () => next()),
      ),
    );
  });
  app.use("*", requestId());
  app.use("*", httpTelemetryMiddleware());
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

  app.route(
    "/api/internal/eliza-app/personal-shared/messages",
    personalSharedMessages,
  );

  app.notFound((c) =>
    c.json(
      { success: false, error: "Not found", code: "resource_not_found" },
      404,
    ),
  );
  // error-policy:J1 internal gateway transport boundary returns a structured failure.
  app.onError((error, c) => {
    logger.error("[PersonalSharedApp] Unhandled error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        success: false,
        error: "Internal server error",
        code: "internal_error",
      },
      500,
    );
  });

  return app;
}
