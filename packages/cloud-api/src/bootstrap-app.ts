/**
 * Full Hono application — imported asynchronously from `index.ts` so the Worker
 * does not evaluate hundreds of route modules during Cloudflare startup validation
 * (error 10021: Script startup exceeded CPU time limit).
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { runWithDbCacheAsync } from "@/db/client";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import { observeCloudRequest } from "@/lib/observability/cloud-backend-observability";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { setRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import jwksRoute from "../.well-known/jwks.json/route";
import { handleBlueBubblesWebhook } from "../webhooks/bluebubbles/route";
import { mountRoutes } from "./_router.generated";
import { authMiddleware } from "./middleware/auth";
import { initAuditDispatcher } from "./services/audit-dispatcher-singleton";
import { embeddedStewardHandler } from "./steward/embedded";

export function createApp(): Hono<AppEnv> {
  // Initialise the global audit dispatcher (auth_events sink + optional
  // console sink) before any route handlers run. Idempotent — safe to
  // call from tests too.
  initAuditDispatcher();

  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
    await runWithCloudBindingsAsync(
      c.env as Record<string, unknown>,
      async () => runWithDbCacheAsync(async () => next()),
    );
  });

  app.use("*", requestId());
  app.use("*", corsMiddleware);

  // Security response headers for every API response. The SPA already ships
  // these via Pages `_headers`, but the Worker (api.elizacloud.ai) shipped
  // none — a ZAP scan flagged the missing X-Content-Type-Options and HSTS.
  // Registered right after CORS: `credentials: true` makes the CORS middleware
  // touch `c.res` on every request, so Hono re-wraps handler responses with a
  // fresh (mutable) Headers — safe even for the raw `fetch()` passthrough
  // routes (agent bridge/stream) whose upstream headers are otherwise frozen.
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      // Match the SPA's HSTS policy (2y + preload).
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      // A JSON API must never be framed.
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      // OG images at /og are embedded cross-origin (<img>); the default
      // `same-origin` CORP would block them.
      crossOriginResourcePolicy: "cross-origin",
      // No HTML is served, so a CSP adds breakage risk on the OpenAPI/OG
      // surface with no benefit; COEP/COOP are meaningless for a windowless
      // JSON API. Leave them off. `removePoweredBy` (default) drops X-Powered-By.
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );

  // Default unset JSON responses to `no-store` so dynamic/authenticated
  // payloads aren't cached by proxies (ZAP "storable content" / cache-control
  // findings). Routes that opt into caching (jwks, agent-card, openapi, og)
  // already set their own Cache-Control and are left untouched.
  app.use("*", async (c, next) => {
    await next();
    const headers = c.res.headers;
    if (
      !headers.has("Cache-Control") &&
      headers.get("Content-Type")?.includes("application/json")
    ) {
      headers.set("Cache-Control", "no-store");
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
    c.set("requestId", requestId);
    return observeCloudRequest(
      {
        id: requestId,
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
  app.route("/.well-known/jwks.json", jwksRoute);

  app.use("*", authMiddleware);

  app.all("/steward", embeddedStewardHandler);
  app.all("/steward/*", embeddedStewardHandler);

  // Legacy `/api/v1/proxy/birdeye/*` mount — emit 308 to canonical
  // `/api/v1/apis/birdeye/*`. Registered before `mountRoutes` so the
  // redirect fires regardless of how the file-based router resolves the
  // splat-mounted sub-app.
  app.all("/api/v1/proxy/birdeye/*", (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(
      "/api/v1/proxy/birdeye",
      "/api/v1/apis/birdeye",
    );
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

  app.get("/api/webhooks/blooio/:orgId/bluebubbles", (c) =>
    c.json({ status: "ok", service: "bluebubbles-blooio-bridge" }),
  );
  app.post("/api/webhooks/blooio/:orgId/bluebubbles", (c) =>
    handleBlueBubblesWebhook(c),
  );
  app.post("/api/webhooks/blooio/:orgId", async (c, next) => {
    const bridge =
      c.req.header("x-eliza-bridge") ??
      c.req.query("bridge") ??
      new URL(c.req.url).searchParams.get("bridge");
    if (bridge === "bluebubbles") {
      return handleBlueBubblesWebhook(c);
    }
    await next();
  });

  mountRoutes(app);

  app.notFound((c) =>
    c.json(
      {
        success: false,
        error: "Not found",
        code: "resource_not_found" as const,
      },
      404,
    ),
  );

  app.onError((err, c) => {
    if (
      err instanceof ApiError ||
      (err instanceof HTTPException && err.status < 500)
    ) {
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
