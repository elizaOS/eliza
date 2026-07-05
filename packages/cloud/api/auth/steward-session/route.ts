/**
 * POST /api/auth/steward-session — set steward-token cookie from a steward JWT.
 * DELETE /api/auth/steward-session — clear steward cookies (logout).
 */

import type {
  StewardSessionErrorCode,
  StewardSessionRequest,
  StewardSessionResponse,
} from "@elizaos/shared/steward-session-client";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import {
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import {
  LEGACY_STEWARD_COOKIES,
  stewardCookieNames,
} from "@/lib/auth/steward-cookies";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { describeSyncError, syncUserFromSteward } from "@/lib/steward-sync";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

function stewardSecretConfigured(env: StewardVerifyEnv): boolean {
  return Boolean(env.STEWARD_SESSION_SECRET || env.STEWARD_JWT_SECRET);
}

const STEWARD_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Origins permitted to set / clear Steward session cookies. Anything else
 * gets a 403 — same-origin XHR from `*.elizacloud.ai` and the cross-origin
 * `elizaos.ai` checkout POST are the only two legitimate browser callers.
 * Explicit, exact hosts only. The `*.pages.dev` wildcard is intentionally
 * NOT included — anyone can deploy to `*.pages.dev`, so it's a CSRF surface
 * in production. Preview deploys use the explicit `dev.` / `staging.` hosts
 * already in the allowlist.
 */
const PERMITTED_ORIGIN_HOSTS = new Set<string>([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
  "staging.elizacloud.ai",
  "elizaos.ai",
  "www.elizaos.ai",
]);

/**
 * Local development origins. Only honored when the worker is NOT running in
 * production. Production deploys never trust localhost as an Origin.
 */
const LOCAL_DEV_ORIGIN_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

function originHost(rawOrigin: string | undefined): string | null {
  if (!rawOrigin) return null;
  try {
    return new URL(rawOrigin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validate Origin / Referer against the request host to block cross-site
 * POST/DELETE. The cookie is SameSite=Lax (and the route is called via XHR,
 * which makes Lax effectively Strict for these requests), so this header
 * check is the second layer specifically for the cross-origin POST case
 * (elizaos.ai → api.elizacloud.ai).
 */
function isPermittedOrigin(
  origin: string | null,
  requestHost: string | null,
  isProduction: boolean,
): boolean {
  if (!origin) return false;
  if (PERMITTED_ORIGIN_HOSTS.has(origin)) return true;
  if (origin.endsWith(".elizacloud.ai") || origin.endsWith(".elizaos.ai")) {
    return true;
  }
  if (requestHost && origin === requestHost) return true;
  if (!isProduction && LOCAL_DEV_ORIGIN_HOSTS.has(origin)) return true;
  return false;
}

/**
 * CSRF check. Modern browsers always send Origin on cross-origin POST/DELETE
 * (Fetch spec) and on same-origin POST too since 2020. We REQUIRE Origin or
 * Referer on every mutating request — no header-less fallthrough. Tooling
 * (curl, server-to-server, e2e tests, native app) must send an explicit
 * `Origin: http://localhost:8787` (in dev) or the configured prod host. This
 * closes the legacy-browser / extension CSRF hole flagged by the prior SSO
 * audit.
 */
function checkOrigin(
  c: { req: { header: (name: string) => string | undefined } },
  isProduction: boolean,
): { ok: true } | { ok: false; reason: string } {
  const rawOrigin = c.req.header("origin");
  const rawReferer = c.req.header("referer");
  const origin = originHost(rawOrigin);
  const referer = originHost(rawReferer);
  const host = (c.req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (!origin && !referer) {
    return { ok: false, reason: "missing_origin_and_referer" };
  }
  if (origin && isPermittedOrigin(origin, host, isProduction))
    return { ok: true };
  if (!origin && referer && isPermittedOrigin(referer, host, isProduction)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `origin=${origin ?? "null"} referer=${referer ?? "null"}`,
  };
}

let stewardAuthMetricCounter = 0;
function logStewardAuth(outcome: string, ttl: number | null) {
  stewardAuthMetricCounter += 1;
  logger.info("[steward-auth]", {
    timestamp: new Date().toISOString(),
    ttl,
    outcome,
    metric: stewardAuthMetricCounter,
  });
}

function errorBody(
  message: string,
  code: StewardSessionErrorCode,
): { error: string; code: StewardSessionErrorCode } {
  return { error: message, code };
}

const app = new Hono<AppEnv>();

// Pre-auth session-mint endpoint: previously guarded only by the Origin
// allowlist + JWT verify, with no per-IP throttle. Add a strict, per-IP,
// fail-closed rate limit so a credential-stuffing / token-spray flood on a
// money/auth surface is bounded even if Redis blips at request time (M11).
app.use(
  rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
    failClosed: true,
  }),
);

app.post("/", async (c) => {
  try {
    const isProduction = c.env.NODE_ENV === "production";
    const originCheck = checkOrigin(c, isProduction);
    if (!originCheck.ok) {
      logStewardAuth("forbidden-origin", null);
      logger.warn("[steward-auth] rejected cross-origin POST", {
        detail: originCheck.reason,
      });
      return c.json(
        { error: "Forbidden", code: "forbidden_origin" as const },
        403,
      );
    }

    const body = (await c.req
      .json()
      .catch(
        () => ({}) as Partial<StewardSessionRequest>,
      )) as Partial<StewardSessionRequest>;
    const token = body.token;
    const refreshToken = body.refreshToken;

    if (!token || typeof token !== "string") {
      logStewardAuth("missing-token", null);
      return c.json(errorBody("Token required", "missing_token"), 400);
    }

    if (!stewardSecretConfigured(c.env)) {
      // Worker can't verify any token — the deployment is missing
      // STEWARD_SESSION_SECRET / STEWARD_JWT_SECRET. Surface this distinctly
      // so the client doesn't treat it as a revocation and wipe localStorage.
      logStewardAuth("server-secret-missing", null);
      return c.json(
        errorBody(
          "Steward verification not configured on server",
          "server_secret_missing",
        ),
        503,
      );
    }

    const claims = await verifyStewardTokenCached(c.env, token);
    if (!claims) {
      logStewardAuth("invalid-token", null);
      await getAuditDispatcher()
        .emit({
          actor: { type: "user", id: "anonymous" },
          action: "auth.login.failed",
          result: "failure",
          resource: null,
          ip:
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
          user_agent: c.req.header("user-agent") ?? undefined,
          request_id: c.get("requestId"),
          metadata: { provider: "steward", reason: "invalid_token" },
        })
        // error-policy:J7 audit write must not block the 401; a dropped auth audit is logged.
        .catch((err) =>
          logger.error("[StewardSession] audit emit for failed login failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }

    let cloudUser: Awaited<ReturnType<typeof syncUserFromSteward>>;
    try {
      cloudUser = await syncUserFromSteward({
        stewardUserId: claims.userId,
        email: claims.email,
        walletAddress: claims.walletAddress ?? claims.address,
        walletChainType: claims.walletChain,
      });
    } catch (error) {
      logStewardAuth("sync-failed", null);
      // Workers Logs indexes only the message STRING — an Error passed in the
      // context object is dropped entirely. Inline everything (same fix as the
      // steward-nonce-exchange twin catch).
      logger.error(
        `[steward-auth] Failed to sync Steward user before setting cookie (stewardUserId=${claims.userId}): ${describeSyncError(error)}`,
      );
      return c.json(
        errorBody("Could not sync Steward user", "steward_user_sync_failed"),
        500,
      );
    }

    const ttl = claims.expiration
      ? Math.max(0, claims.expiration - Math.floor(Date.now() / 1000))
      : null;

    const secure = c.env.NODE_ENV === "production";
    const domain = cookieDomainForHost(c.req.header("host"));

    const cookieNames = stewardCookieNames(c.env.ENVIRONMENT);

    setCookie(c, cookieNames.token, token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      ...(typeof ttl === "number" ? { maxAge: ttl } : {}),
    });

    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      setCookie(c, cookieNames.refreshToken, refreshToken, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        ...(domain ? { domain } : {}),
        maxAge: STEWARD_REFRESH_COOKIE_MAX_AGE,
      });
    }

    setCookie(c, cookieNames.authed, "1", {
      httpOnly: false,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      maxAge: STEWARD_REFRESH_COOKIE_MAX_AGE,
    });

    logStewardAuth("ok", ttl);
    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: cloudUser.id },
        action: "auth.login",
        result: "success",
        resource: null,
        org_id: cloudUser.organization_id ?? undefined,
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
        user_agent: c.req.header("user-agent") ?? undefined,
        request_id: c.get("requestId"),
        metadata: { provider: "steward", method: "session_exchange" },
      })
      // error-policy:J7 audit write must not block the login response; a dropped auth audit is logged.
      .catch((err) =>
        logger.error(
          "[StewardSession] audit emit for successful login failed",
          {
            userId: cloudUser.id,
            error: err instanceof Error ? err.message : String(err),
          },
        ),
      );
    const response: StewardSessionResponse = {
      ok: true,
      userId: cloudUser.id,
      stewardUserId: claims.userId,
      initialCreditsGranted: cloudUser.initialCreditsGranted,
      initialFreeCreditsUsd: cloudUser.initialFreeCreditsUsd,
      welcomeBonusWithheld: cloudUser.welcomeBonusWithheld === true,
      welcomeBonusWithheldReason: cloudUser.welcomeBonusWithheldReason,
      welcomeBonusWithheldMessage: cloudUser.welcomeBonusWithheldMessage,
    };
    return c.json(response);
  } catch {
    logStewardAuth("error", null);
    return c.json(errorBody("Internal error", "internal_error"), 500);
  }
});

app.delete("/", (c) => {
  const isProduction = c.env.NODE_ENV === "production";
  const originCheck = checkOrigin(c, isProduction);
  if (!originCheck.ok) {
    logStewardAuth("forbidden-origin-delete", null);
    return c.json({ error: "Forbidden" }, 403);
  }
  const domain = cookieDomainForHost(c.req.header("host"));
  const opts = domain ? { path: "/", domain } : { path: "/" };
  // Sign-out must clear BOTH naming eras, exactly like /logout: this DELETE is
  // the clear path clearStaleStewardSession uses, and a pre-rename session
  // whose legacy pair survives here gets resurrected by the legacy read
  // fallback + 30-day legacy refresh cookie (ghost session). The legacy read
  // fallback itself shuts off after 2026-08-04. (#13728)
  const names = stewardCookieNames(c.env.ENVIRONMENT);
  deleteCookie(c, names.token, opts);
  deleteCookie(c, names.refreshToken, opts);
  deleteCookie(c, LEGACY_STEWARD_COOKIES.token, opts);
  deleteCookie(c, LEGACY_STEWARD_COOKIES.refreshToken, opts);
  deleteCookie(c, names.authed, opts);
  deleteCookie(c, LEGACY_STEWARD_COOKIES.authed, opts);
  logStewardAuth("deleted", null);
  return c.json({ ok: true });
});

export default app;
