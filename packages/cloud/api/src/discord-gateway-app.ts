/**
 * Dependency-bounded Hono shell for authenticated managed Discord turns.
 *
 * The Railway gateway already owns provider ingress and retries. This shell
 * preserves the Cloud request context, security headers, and internal JWT
 * boundary without evaluating the generated application router before every
 * ordinary channel message.
 */

import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { runWithDbCacheAsync } from "@/db/client";
import {
  getIpKey,
  getRequestIp,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { httpTelemetryMiddleware } from "@/lib/observability/http-telemetry-hono";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { runWithRequestContext } from "@/lib/runtime/request-context";
import { setRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import managedDiscordMessages from "../internal/discord/eliza-app/messages/route";

export function createDiscordGatewayApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
    await runWithCloudBindingsAsync(c.env, async () =>
      runWithRequestContext(
        {
          clientIp: getRequestIp(c),
          idempotencyKey:
            c.req.header("idempotency-key") ??
            c.req.header("x-request-id") ??
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

  app.route("/api/internal/discord/eliza-app/messages", managedDiscordMessages);

  app.notFound((c) =>
    c.json(
      { success: false, error: "Not found", code: "resource_not_found" },
      404,
    ),
  );
  // error-policy:J1 internal gateway transport boundary returns a structured failure.
  app.onError((error, c) => {
    logger.error("[DiscordGatewayApp] Unhandled error", {
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
