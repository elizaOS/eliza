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
  "/api/i18n/locale",
  "/api/og",
  "/api/openapi.json",
  "/api/eliza",
  "/api/fal/proxy",
  "/api/public",
  // Caddy on-demand-TLS `ask` for the apps front door — called by app nodes
  // without a session; side-effect-free existence check (see route doc).
  "/api/v1/apps-ingress/ask",
  // Node self-registration callback — a freshly-provisioned (operator or
  // autoscaled) node POSTs here from cloud-init with no session. The route
  // fails closed and self-authenticates with a timing-safe `x-bootstrap-secret`
  // (CONTAINERS_BOOTSTRAP_SECRET) before any work, so it must bypass the session
  // gate or it 401s before its own secret check runs.
  "/api/v1/admin/docker-nodes/bootstrap-callback",
  "/api/auth/pair",
  "/api/auth/cli-session",
  "/api/v1/cli-auth",
  "/api/auth/siwe",
  "/api/auth/siws",
  "/api/auth/steward-session",
  "/api/auth/steward-nonce-exchange",
  "/api/auth/steward-refresh",
  // Logout must be reachable without a valid session: the client clears the
  // Steward cookies before (or independently of) this call, and an expired
  // session still needs to tear down server state + clear cookies. The handler
  // resolves the user best-effort and only ends sessions when one is present,
  // so a public, idempotent logout is safe. Gating it (the prior behavior) made
  // every logout 401 once cookies were gone, so the server-side teardown never
  // ran and stale refresh cookies could silently re-mint a session.
  "/api/auth/logout",
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
  "/api/v1/agent-tokens",
  "/api/v1/credits/topup",
  "/api/v1/topup",
  "/api/v1/x402",
  "/api/v1/market/preview",
  "/api/stripe/credit-packs",
  "/api/stripe/webhook",
  // Unified payment_requests settlement webhook. Public like the legacy
  // /api/stripe/webhook above; the handler enforces the stripe-signature and
  // fails closed (400) without it. The `=== p || startsWith(p+"/")` match keeps
  // this from exposing the authed /api/v1/stripe/checkout sibling. Without this
  // entry the session gate 401s every Stripe delivery → a checkout would charge
  // the card but never settle (payment_request stuck "pending").
  "/api/v1/stripe/webhook",
  // OxaPay settlement webhook for the same unified payment_requests surface
  // (#10732). Public like /api/v1/stripe/webhook above; the handler fails
  // closed without a valid HMAC-SHA512 `hmac` header. Without this entry the
  // session gate 401s every OxaPay delivery → an invoice would collect crypto
  // but the payment_request would never settle (user pays, no credit).
  "/api/v1/oxapay/webhook",
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
  // Public SSP ad-serve + click tracking, consumed by miniapp ad tags. The
  // serve handler requires a signed ad-tag token; click requires a served
  // impression id — both behind IP-keyed rate limits.
  "/api/v1/marketing/inventory/serve",
  "/api/v1/marketing/inventory/click",
  // Public advertiser conversion pixel/webhook. The signed campaign token is
  // the capability and the route dedupes event ids before attribution.
  "/api/v1/advertising/conversions/track",
  // Public campaign performance reports use unguessable, hash-stored share
  // tokens and fail closed when expired or revoked.
  "/api/v1/advertising/reports",
  // Public hosted-frontend serve path: renders an app's active frontend from R2
  // for public visitors (fails closed to 404 on any unresolved host).
  "/api/v1/hosted-frontend/serve",
  // Public SSP ad-serve + click tracking, consumed by miniapp ad tags.
  "/api/v1/marketing/inventory/serve",
  "/api/v1/marketing/inventory/click",
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
  "/api/v1/earnings/payout/stripe-connect/webhook",
  "/api/eliza-app/auth",
  "/api/eliza-app/connections",
  "/api/eliza-app/webhook",
  "/api/eliza-app/user",
  "/api/eliza-app/cli-auth",
  "/api/eliza-app/onboarding",
  "/api/eliza-app/gateway",
];

// Out-of-band token pages (sensitive-request links, approval-signer links,
// ballot links) are visited by sessionless recipients. Only the signer-facing
// subpaths bypass the session gate; the per-org list/create/admin endpoints on
// the same resources stay gated, and the handlers themselves enforce the token
// (sensitive-requests/ballots) or the redacted `?public=1` view + signature
// (approval-requests). The session gate must NOT short-circuit them first.
function isPublicOutOfBandTokenPath(pathname: string): boolean {
  // GET sensitive request detail + POST submit — both gated on the URL/body
  // token by the route handler (single-use token hash).
  if (/^\/api\/v1\/sensitive-requests\/[^/]+\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/sensitive-requests\/[^/]+\/submit\/?$/.test(pathname)) {
    return true;
  }
  // Approval-request signer flow: redacted public detail (?public=1), approve
  // (signature-verified), deny. Cancel stays gated (challenger-only).
  if (/^\/api\/v1\/approval-requests\/[^/]+\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/approval-requests\/[^/]+\/approve\/?$/.test(pathname)) {
    return true;
  }
  if (/^\/api\/v1\/approval-requests\/[^/]+\/deny\/?$/.test(pathname)) {
    return true;
  }
  // Ballot participant flow: redacted public detail (?public=1) + vote (gated
  // on the scoped per-participant token). Tally/distribute/cancel stay gated.
  if (/^\/api\/v1\/ballots\/[^/]+\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/ballots\/[^/]+\/vote\/?$/.test(pathname)) return true;
  return false;
}

export function isPublicPath(pathname: string): boolean {
  if (pathname === "/api/v1/oauth/callback") return true;
  if (/^\/api\/v1\/oauth\/[^/]+\/callback\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/generate-image\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/public\/?$/.test(pathname)) return true;
  if (/^\/api\/v1\/apps\/[^/]+\/charges\/[^/]+\/?$/.test(pathname)) return true;
  if (/^\/api\/characters\/[^/]+\/public\/?$/.test(pathname)) return true;
  if (isPublicOutOfBandTokenPath(pathname)) return true;
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
