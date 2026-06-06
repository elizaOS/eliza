/**
 * Global auth middleware — Hono auth gate. Steward cookie/session resolution
 * lives in `getCurrentUser` (`packages/lib/auth/workers-hono-auth.ts`).
 *
 * Behavior:
 *   - Public paths pass through with no auth.
 *   - Programmatic auth (X-API-Key, Bearer eliza_*) — pass through; per-route
 *     handlers validate the key against the DB.
 *   - Steward cookie / Steward Bearer JWT — verify via `getCurrentUser` and
 *     fall through on success. Failure on a protected /api/ path → 401.
 *
 * This middleware is mounted globally before the router in src/index.ts.
 */

import type { MiddlewareHandler } from "hono";

import { jsonError } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { getAuditDispatcher } from "../services/audit-dispatcher-singleton";

const publicPathPrefixes = [
  "/api/health",
  "/api/og",
  "/api/openapi.json",
  "/api/eliza",
  "/api/fal/proxy",
  "/api/public",
  "/api/auth/pair",
  "/api/auth/cli-session",
  "/api/v1/cli-auth",
  "/api/auth/siwe",
  "/api/auth/siws",
  "/api/auth/steward-session",
  "/api/auth/steward-nonce-exchange",
  "/api/auth/steward-refresh",
  "/api/affiliate",
  "/api/invites/validate",
  "/api/v1/generate-image",
  "/api/v1/generate-video",
  "/api/v1/chat",
  "/api/v1/messages",
  "/api/v1/responses",
  "/api/v1/embeddings",
  "/api/v1/models",
  "/api/v1/pricing/summary",
  "/api/v1/agents/by-token",
  "/api/v1/agent-tokens",
  "/api/v1/credits/topup",
  "/api/v1/topup",
  "/api/v1/x402",
  "/api/v1/market/preview",
  "/api/stripe/credit-packs",
  "/api/stripe/webhook",
  "/api/crypto/webhook",
  "/api/crypto/status",
  "/api/crypto/direct-payments/config",
  "/api/cron",
  "/api/v1/cron",
  "/api/mcps",
  "/api/mcp/list",
  "/api/mcp",
  "/api/a2a",
  "/api/agents",
  "/api/v1/track",
  "/api/v1/discovery",
  "/api/v1/domains/resolve",
  // Legacy birdeye proxy is a 308 redirect to /api/v1/apis/birdeye/*. The
  // redirect itself is public so unauthenticated clients learn the new URL;
  // the target /api/v1/apis/birdeye is still auth-gated.
  "/api/v1/proxy/birdeye",
  "/api/v1/discord/callback",
  "/api/v1/twitter/callback",
  "/api/v1/oauth/providers",
  "/api/v1/oauth/callback",
  "/api/v1/user/wallets/rpc",
  "/api/v1/app-auth",
  "/api/.well-known",
  "/api/internal",
  "/api/webhooks",
  "/api/v1/telegram/webhook",
  "/api/eliza-app/auth",
  "/api/eliza-app/connections",
  "/api/eliza-app/webhook",
  "/api/eliza-app/user",
  "/api/eliza-app/cli-auth",
  "/api/eliza-app/onboarding",
  "/api/eliza-app/provision-agent",
  "/api/eliza-app/gateway",
];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/api/v1/oauth/callback") return true;
  if (/^\/api\/v1\/oauth\/[^/]+\/callback\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/generate-image\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/public\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/charges\/[^/]+\/?$/.test(pathname)) return true;
  if (/^\/api\/characters\/[^/]+\/public\/?$/.test(pathname)) return true;
  return publicPathPrefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function isLocalDevAdminRequest(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): boolean {
  // Hard fail in production: NEVER grant the dev-admin bypass regardless of
  // env vars. SOC2 CC6.1 — production privileged access must require a real
  // session + admin role check.
  if (c.env.NODE_ENV === "production") {
    if (
      c.env.ELIZA_CLOUD_LOCAL_DEV_ADMIN === "true" ||
      c.env.LOCAL_DEV === "true"
    ) {
      logger.error(
        "[Auth] Refusing dev-admin bypass in production — env var ignored",
        {
          path: new URL(c.req.url).pathname,
        },
      );
    }
    return false;
  }
  const explicit = c.env.ELIZA_CLOUD_LOCAL_DEV_ADMIN === "true";
  const devMode = c.env.NODE_ENV !== "production" && c.env.LOCAL_DEV === "true";
  if (!explicit && !devMode) return false;
  const url = new URL(c.req.url);
  const matches =
    url.pathname.startsWith("/api/v1/admin/") &&
    isLoopbackHostname(url.hostname);
  if (matches) {
    // Best-effort audit emit; do not block request on audit failure.
    void getAuditDispatcher()
      .emit({
        actor: { type: "system", id: "local-dev-admin" },
        action: "admin.action",
        result: "success",
        resource: { type: "endpoint", id: url.pathname },
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
        user_agent: c.req.header("user-agent") ?? undefined,
        request_id: c.get("requestId"),
        metadata: { reason: "local_dev_admin_bypass" },
      })
      .catch((err) => {
        logger.warn("[Auth] dev-admin audit emit failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  return matches;
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/")) {
    await next();
    return;
  }

  if (isPublicPath(pathname)) {
    await next();
    return;
  }

  if (isLocalDevAdminRequest(c)) {
    await next();
    return;
  }

  // Programmatic auth: per-route handlers validate the key. Skip cookie auth.
  const apiKey = c.req.header("X-API-Key") || c.req.header("x-api-key");
  // S2S service-key (e.g. waifu.fun -> cloud provisioning). The per-route
  // handler calls requireServiceKey()/validateServiceKey(), so let it through
  // here rather than failing the cookie/session check below.
  const serviceKey =
    c.req.header("X-Service-Key") || c.req.header("x-service-key");
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const elizaBearer = bearer?.startsWith("eliza_") ?? false;
  if (apiKey || elizaBearer || serviceKey) {
    await next();
    return;
  }

  // Steward session path. Resolve the user; on failure return 401 for /api/.
  const user = await getCurrentUser(c);
  if (!user) {
    return jsonError(c, 401, "Unauthorized", "authentication_required");
  }
  await next();
};

// Re-export `requireApiKeyPermission` from its dedicated module so existing
// route imports (`@/api-app/middleware/auth`) continue to work, while tests
// and new code can import from the standalone file without pulling in the
// full auth-gate transitive deps.
export {
  enforceApiKeyPermission,
  requireApiKeyPermission,
} from "./api-key-permission";
