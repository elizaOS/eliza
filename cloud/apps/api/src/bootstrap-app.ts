/**
 * Full Hono application — imported asynchronously from `index.ts` so the Worker
 * does not evaluate hundreds of route modules during Cloudflare startup validation
 * (error 10021: Script startup exceeded CPU time limit).
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { runWithDbCacheAsync } from "@/db/client";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { setRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { mountRoutes } from "./_router.generated";

import { authMiddleware } from "./middleware/auth";
import { embeddedStewardHandler } from "./steward/embedded";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
    await runWithCloudBindingsAsync(c.env as Record<string, unknown>, async () =>
      runWithDbCacheAsync(async () => next()),
    );
  });

  app.use("*", requestId());
  app.use("*", corsMiddleware);
  app.use("*", honoLogger());
  app.use("*", async (c, next) => {
    c.set("requestId", c.get("requestId") ?? crypto.randomUUID());
    c.set("user", undefined);
    await next();
  });
  app.use("*", authMiddleware);

  app.all("/steward", embeddedStewardHandler);
  app.all("/steward/*", embeddedStewardHandler);

  // Legacy `/api/v1/proxy/birdeye/*` mount — emit 308 to canonical
  // `/api/v1/apis/birdeye/*`. Registered before `mountRoutes` so the
  // redirect fires regardless of how the file-based router resolves the
  // splat-mounted sub-app.
  app.all("/api/v1/proxy/birdeye/*", (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace("/api/v1/proxy/birdeye", "/api/v1/apis/birdeye");
    return c.redirect(url.toString(), 308);
  });

  app.get("/", (c) => {
    const hostname = new URL(c.req.url).hostname;
    if (hostname === "x402.elizacloud.ai" || hostname === "x402.elizaos.ai") {
      return c.json({
        name: "eliza-x402",
        description: "Eliza Cloud x402 facilitator",
        discovery: "/api/v1/x402",
        verify: "/api/v1/x402/verify",
        settle: "/api/v1/x402/settle",
        topup: ["/api/v1/topup/10", "/api/v1/topup/50", "/api/v1/topup/100"],
      });
    }

    return c.json({
      name: "eliza-cloud-api",
      description: "Eliza Cloud API",
      docs: "https://elizacloud.ai/docs",
      health: "/api/health",
      openapi: "/api/openapi.json",
    });
  });

  mountRoutes(app);

  app.notFound((c) =>
    c.json({ success: false, error: "Not found", code: "resource_not_found" as const }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError || (err instanceof HTTPException && err.status < 500)) {
      logger.debug("[CloudApi] Request rejected", {
        status: err.status,
        message: err.message,
      });
      return failureResponse(c, err);
    }

    logger.error("[CloudApi] Unhandled error", { error: err });
    return failureResponse(c, err);
  });

  return app;
}
