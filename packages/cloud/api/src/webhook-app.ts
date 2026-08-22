/**
 * Builds the dependency-light Hono shell for provider webhooks.
 *
 * Provider signatures remain authoritative in the mounted route modules. This
 * shell preserves the full application's request correlation, security
 * headers, and Cloudflare-native backstop without evaluating the generated
 * router or unrelated database, OAuth, audit, and product services.
 */

import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import {
  getIpKey,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { httpTelemetryMiddleware } from "@/lib/observability/http-telemetry-hono";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import blooioWebhook from "../eliza-app/webhook/blooio/route";
import discordWebhook from "../eliza-app/webhook/discord/route";
import telegramWebhook from "../eliza-app/webhook/telegram/route";
import twilioWebhook from "../eliza-app/webhook/twilio/route";

export function createWebhookApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

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

  app.route("/api/eliza-app/webhook/blooio", blooioWebhook);
  app.route("/api/eliza-app/webhook/discord", discordWebhook);
  app.route("/api/eliza-app/webhook/telegram", telegramWebhook);
  app.route("/api/eliza-app/webhook/twilio", twilioWebhook);

  app.notFound((c) =>
    c.json(
      { success: false, error: "Not found", code: "resource_not_found" },
      404,
    ),
  );
  // error-policy:J1 provider webhook transport boundary returns a structured failure.
  app.onError((error, c) => {
    logger.error("[WebhookApp] Unhandled error", {
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
