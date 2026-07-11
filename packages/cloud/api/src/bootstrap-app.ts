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
import { buildRedisClient } from "@/lib/cache/redis-factory";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import {
  getIpKey,
  getRequestIp,
  rateLimit,
  rateLimitConfigVerdict,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { observeCloudRequest } from "@/lib/observability/cloud-backend-observability";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { runWithRequestContext } from "@/lib/runtime/request-context";
import { configureAppsDeprovisionTrigger } from "@/lib/services/app-db-deprovision-job-service";
import { configureAppsDeployTrigger } from "@/lib/services/app-deploy-job-service";
import { setRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";
import { describeUnhandledError } from "@/lib/utils/unhandled-error-detail";
import type { AppEnv } from "@/types/cloud-worker-env";
import jwksRoute from "../.well-known/jwks.json/route";
import { handleBlueBubblesWebhook } from "../webhooks/bluebubbles/route";
import { mountRoutes } from "./_router.generated";
import { appsDeployTriggerDecision } from "./lib/apps-deploy-gate";
import { authMiddleware } from "./middleware/auth";
import { initAuditDispatcher } from "./services/audit-dispatcher-singleton";
import { embeddedStewardHandler } from "./steward/embedded";

/**
 * Supported UI languages, mirrored from `packages/ui/src/i18n/messages.ts`.
 * Kept inline because cloud-api must not import the React UI package into the
 * Workers bundle.
 */
type UiLanguage = "en" | "zh-CN" | "ko" | "ja" | "vi" | "tl" | "pt" | "es";

/** ISO 3166-1 alpha-2 country → best-supported UI language. */
const REGION_LANGUAGE: Record<string, UiLanguage> = {
  CN: "zh-CN",
  TW: "zh-CN",
  HK: "zh-CN",
  MO: "zh-CN",
  SG: "zh-CN",
  KR: "ko",
  KP: "ko",
  JP: "ja",
  VN: "vi",
  PH: "tl",
  PT: "pt",
  BR: "pt",
  AO: "pt",
  MZ: "pt",
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  VE: "es",
  EC: "es",
  GT: "es",
  CU: "es",
  BO: "es",
  DO: "es",
  HN: "es",
  PY: "es",
  SV: "es",
  NI: "es",
  CR: "es",
  PA: "es",
  UY: "es",
  PR: "es",
};

const SUPPORTED = new Set<string>(Object.values(REGION_LANGUAGE).concat("en"));

function matchSupported(tag: string): UiLanguage | null {
  if (!tag) return null;
  if (/^en(-|$)/i.test(tag)) return "en";
  const lower = tag.toLowerCase();
  if (SUPPORTED.has(lower)) return lower as UiLanguage;
  const base = lower.split("-")[0];
  if (SUPPORTED.has(base)) return base as UiLanguage;
  return null;
}

function languageFromAcceptLanguage(header: string | null): UiLanguage | null {
  if (typeof header !== "string" || !header.trim()) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      return { tag: tag.trim(), q: q ? Number.parseFloat(q) : 1 };
    })
    .filter((entry) => entry.tag && entry.tag !== "*")
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const matched = matchSupported(tag);
    if (matched) return matched;
  }
  return null;
}

function languageFromRegion(country: string | null): UiLanguage | null {
  if (typeof country !== "string") return null;
  const code = country.trim().toUpperCase();
  return code ? (REGION_LANGUAGE[code] ?? null) : null;
}

function resolveServerLanguage(opts: {
  acceptLanguage: string | null;
  country: string | null;
}): UiLanguage | null {
  return (
    languageFromAcceptLanguage(opts.acceptLanguage) ??
    languageFromRegion(opts.country)
  );
}

const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-appengine-country",
  "fastly-geo-country",
  "x-country-code",
] as const;

function countryFromHeaders(headers: Headers): string | null {
  for (const name of COUNTRY_HEADERS) {
    const value = headers.get(name);
    if (value && value.toUpperCase() !== "XX") return value;
  }
  return null;
}

export function createApp(): Hono<AppEnv> {
  // Initialise the global audit dispatcher (auth_events sink + optional
  // console sink) before any route handlers run. Idempotent — safe to
  // call from tests too.
  initAuditDispatcher();

  // Apps (Product 2): when enabled, wire the deploy trigger so
  // POST /api/v1/apps/:id/deploy enqueues a real isolated APP_DEPLOY job (the
  // provisioning-worker daemon runs it). Gated OFF by default — until
  // APPS_DEPLOY_ENABLED=1, createDeployment keeps its compatibility stub behavior.
  // Production also requires APPS_DEPLOY_ALLOWED_ORG_IDS so a cutover cannot
  // accidentally arm every org at once.
  const appsDeployDecision = appsDeployTriggerDecision(process.env);
  if (appsDeployDecision.enabled) {
    configureAppsDeployTrigger();
    // Same lane: when an app with an isolated tenant DB is deleted, enqueue an
    // APP_DB_DEPROVISION job so the daemon DROPs the DB + frees the cluster slot
    // (the Worker can't — no `pg`). Without it the DB + slot leak (#8342).
    configureAppsDeprovisionTrigger();
  } else if (appsDeployDecision.reason === "production_allowlist_missing") {
    logger.warn(
      "[bootstrap-app] APPS_DEPLOY_ENABLED=1 ignored in production without APPS_DEPLOY_ALLOWED_ORG_IDS",
    );
  }

  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", async (c, next) => {
    setRuntimeR2Bucket(c.env.BLOB);
    await runWithCloudBindingsAsync(
      c.env as Record<string, unknown>,
      async () =>
        // Expose the client IP + a stable per-request idempotency key to shared
        // library code (anti-sybil grant checks; idempotent money settlement,
        // #10423) without threading them through every call site.
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

  // Rate-limit config guard (#9853 P1.1) — never let production silently serve
  // with rate limiting OFF. The limiters fall open whenever REDIS_RATE_LIMITING
  // is not "true" or no Redis client is reachable, which would leave the
  // anon-mint / metered-inference paths unbounded. This evaluates once per
  // isolate against the request-scoped env (the Worker has no boot-time env):
  //   - prod + REDIS_RATE_LIMITING="true" but NO reachable Redis  → fail CLOSED
  //     (503) — a deploy misconfiguration; surface it loudly instead of running
  //     with limiters silently disabled.
  //   - prod + REDIS_RATE_LIMITING!="true"  → loud WARN once (limiters disabled;
  //     the documented #9853 ops cutover is: set REDIS_URL, flip the flag true).
  let rateLimitConfigLogged = false;
  app.use("*", async (c, next) => {
    const env = c.env as { ENVIRONMENT?: string; REDIS_RATE_LIMITING?: string };
    const verdict = rateLimitConfigVerdict({
      environment: env.ENVIRONMENT,
      redisRateLimiting: env.REDIS_RATE_LIMITING,
      hasRedisClient: Boolean(buildRedisClient(c.env)),
    });
    if (!rateLimitConfigLogged) {
      rateLimitConfigLogged = true;
      if (verdict === "fail-closed") {
        logger.error(
          "[bootstrap-app] FATAL: REDIS_RATE_LIMITING=true in production but no Redis client is reachable (set the REDIS_URL secret). Failing closed — refusing traffic rather than serving with rate limiting silently disabled.",
        );
      } else if (verdict === "warn-disabled") {
        logger.warn(
          '[bootstrap-app] Rate limiting is DISABLED in production (REDIS_RATE_LIMITING!="true") — limiters fall open. Cutover (#9853 P1.1): provision Redis, set REDIS_URL, then set REDIS_RATE_LIMITING="true" and redeploy.',
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

  // Global IP-keyed backstop limiter. Routes with their own (tighter) limiter
  // still enforce it; this only guarantees that a route which forgot to add one
  // is not completely unprotected against per-IP flooding. The ceiling is
  // deliberately generous (10 req/s sustained) so it sits above every per-route
  // policy and never interferes with legitimate traffic. Enforced only when
  // REDIS_RATE_LIMITING=true (falls open otherwise). Registered before
  // authMiddleware so unauthenticated routes are covered too.
  app.use(
    "*",
    rateLimit({
      windowMs: 60_000,
      maxRequests: 600,
      // Namespaced so this backstop counter never collides with a per-route
      // IP-keyed limiter sharing the same `ip:<addr>` key.
      keyGenerator: (c) => `global:${getIpKey(c)}`,
    }),
  );

  app.use("*", authMiddleware);

  app.all("/steward", embeddedStewardHandler);
  app.all("/steward/*", embeddedStewardHandler);

  // Compatibility `/api/v1/proxy/birdeye/*` mount emits 308 to canonical
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

  // Public language suggestion derived from the CDN IP-geo country header and
  // `Accept-Language`. Pre-auth — used by the SPA on first visit before any
  // session exists. Mounted at the edge so every cloud-served frontend gets it
  // regardless of which backend serves the agent. The path prefix is allowed
  // in `middleware/auth.ts` `publicPathPrefixes`. The mapping table mirrors
  // `packages/ui/src/i18n/region.ts` — kept inline (rather than importing
  // `@elizaos/ui`) because cloud-api is a Workers bundle and must not pull in
  // the React UI surface.
  app.get("/api/i18n/locale", (c) => {
    const acceptLanguage = c.req.header("accept-language") ?? null;
    const country = countryFromHeaders(c.req.raw.headers);
    const language = resolveServerLanguage({ acceptLanguage, country });
    return c.json({ language });
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

    // Log a plain-object summary, not the raw Error: the log-sink redactor
    // rebuilds Error instances with non-enumerable message/stack, so a JSON
    // tail otherwise shows only `{name}` — which made the staging KMS
    // misconfig (#16145) a multi-hour reverse-engineering job instead of a
    // one-line read. String values/keys still pass the same redaction sink.
    logger.error("[CloudApi] Unhandled error", {
      error: describeUnhandledError(err),
    });
    return failureResponse(c, err);
  });

  return app;
}
