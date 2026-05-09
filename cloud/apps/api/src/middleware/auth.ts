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
import type { AppEnv } from "@/types/cloud-worker-env";

const publicPathPrefixes = [
  "/api/health",
  "/api/og",
  "/api/openapi.json",
  "/api/eliza",
  "/api/fal/proxy",
  "/api/public",
  "/api/auth/pair",
  "/api/auth/cli-session",
  "/api/auth/siwe",
  "/api/auth/steward-session",
  "/api/auth/steward-debug",
  "/api/set-anonymous-session",
  "/api/anonymous-session",
  "/api/auth/create-anonymous-session",
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
  "/api/v1/credits/topup",
  "/api/v1/topup",
  "/api/v1/market/preview",
  "/api/stripe/credit-packs",
  "/api/stripe/webhook",
  "/api/crypto/webhook",
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
  "/api/eliza-app/provision-agent",
  "/api/eliza-app/gateway",
];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/api/v1/oauth/callback") return true;
  if (/^\/api\/v1\/oauth\/[^/]+\/callback\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/public\/?$/.test(pathname)) return true;
  if (/^\/api\/characters\/[^/]+\/public\/?$/.test(pathname)) return true;
  return publicPathPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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

  // Programmatic auth: per-route handlers validate the key. Skip cookie auth.
  const apiKey = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const elizaBearer = bearer?.startsWith("eliza_") ?? false;
  if (apiKey || elizaBearer) {
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
