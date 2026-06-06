/**
 * POST /api/auth/steward-refresh
 *
 * Server-side refresh-token rotation. The browser sends the request with
 * `credentials: 'include'`; the HttpOnly `steward-refresh-token` cookie
 * travels automatically. The route:
 *
 *  1. Reads the `steward-refresh-token` cookie (HttpOnly — JS can never see
 *     it).
 *  2. Forwards it to Steward `POST /auth/refresh`, which returns a fresh
 *     access token + rotated refresh token.
 *  3. Verifies the new access token (same path as
 *     `/api/auth/steward-session`).
 *  4. Sets new HttpOnly cookies (`steward-token`, `steward-refresh-token`)
 *     and the non-HttpOnly `steward-authed=1` marker.
 *  5. Returns `{ ok, expiresAt }`. Trusted first-party browser origins also
 *     receive the short-lived access token so the SPA can hydrate its
 *     localStorage mirror while route auth remains synchronous.
 *
 * Origin/Referer CSRF check mirrors `/api/auth/steward-session`.
 *
 * This route is the only way to refresh once the localStorage copy of the
 * refresh token is removed. Old browser tabs that still POST a refreshToken
 * to `/api/auth/steward-session` continue to work during the rollout window.
 */

import {
  STEWARD_AUTHED_COOKIE,
  type StewardSessionErrorCode,
} from "@elizaos/shared/steward-session-client";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signStewardMutatingRequest } from "@/api-app/steward/sign";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import {
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STEWARD_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const STEWARD_TOKEN_COOKIE = "steward-token";
const STEWARD_REFRESH_TOKEN_COOKIE = "steward-refresh-token";

// ─── CSRF origin allowlist (must stay in lockstep with steward-session) ───
const PERMITTED_ORIGIN_HOSTS = new Set<string>([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
  "staging.elizacloud.ai",
  "elizaos.ai",
  "www.elizaos.ai",
]);
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

function shouldReturnClientToken(
  c: { req: { header: (name: string) => string | undefined } },
  isProduction: boolean,
): boolean {
  const origin =
    originHost(c.req.header("origin")) ?? originHost(c.req.header("referer"));
  const host = (c.req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (!origin) return false;
  // The SPA still uses a localStorage access-token mirror for synchronous
  // route auth. Cookie refresh must hydrate that mirror for every origin the
  // CSRF check already accepts, otherwise valid HttpOnly-cookie sessions can
  // bounce back to /login on previews/custom same-origin hosts.
  return isPermittedOrigin(origin, host, isProduction);
}

function stewardSecretConfigured(env: StewardVerifyEnv): boolean {
  return Boolean(env.STEWARD_SESSION_SECRET || env.STEWARD_JWT_SECRET);
}

function errorBody(
  message: string,
  code: StewardSessionErrorCode,
): { error: string; code: StewardSessionErrorCode } {
  return { error: message, code };
}

let stewardRefreshMetricCounter = 0;
function logRefresh(outcome: string): void {
  stewardRefreshMetricCounter += 1;
  logger.info("[steward-refresh]", {
    timestamp: new Date().toISOString(),
    outcome,
    metric: stewardRefreshMetricCounter,
  });
}

function resolveStewardBaseUrl(env: AppEnv["Bindings"]): string | null {
  const candidates = [env.STEWARD_API_URL, env.NEXT_PUBLIC_STEWARD_API_URL];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim().replace(/\/+$/, "");
    if (trimmed.length === 0) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return trimmed;
    } catch {}
  }
  return null;
}

interface StewardRefreshOk {
  ok: true;
  token: string;
  refreshToken: string;
  expiresIn?: number;
  expiresAt?: number;
}
interface StewardRefreshErr {
  ok: false;
  error?: string;
  code?: string;
}

async function callStewardRefresh(
  baseUrl: string,
  refreshToken: string,
  pinnedTenantId?: string,
  signingSecret?: string,
): Promise<
  | { kind: "ok"; data: StewardRefreshOk }
  | { kind: "error"; status: number; data: StewardRefreshErr }
  | { kind: "transport"; message: string }
> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  // Pin the tenant per-env: this route bypasses the /steward/* proxy in
  // bootstrap-app.ts and would otherwise hit Steward without scoping,
  // letting a staging refresh land against the prod tenant.
  if (typeof pinnedTenantId === "string" && pinnedTenantId.trim().length > 0) {
    headers.set("X-Steward-Tenant", pinnedTenantId.trim());
  }
  const bodyText = JSON.stringify({ refreshToken });
  const bodyBytes = new TextEncoder().encode(bodyText);
  const refreshUrl = new URL(`${baseUrl}/auth/refresh`);
  // Steward's authorization-signature middleware gates mutating sensitive
  // paths (incl. /auth/refresh) on the signed-request contract. The
  // /steward/* embedded proxy signs automatically; this bypass route must
  // sign the same way or Steward 502s with "Request expiry header required",
  // which kicks the SPA back to /login after every magic-link verify.
  if (typeof signingSecret === "string" && signingSecret.length > 0) {
    await signStewardMutatingRequest(
      signingSecret,
      "POST",
      `${refreshUrl.pathname}${refreshUrl.search}`,
      headers,
      bodyBytes,
    );
  }
  let response: Response;
  try {
    response = await fetch(refreshUrl.toString(), {
      method: "POST",
      headers,
      body: bodyText,
    });
  } catch (err) {
    return {
      kind: "transport",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const text = await response.text();
  let parsed: StewardRefreshOk | StewardRefreshErr | null = null;
  try {
    parsed = text
      ? (JSON.parse(text) as StewardRefreshOk | StewardRefreshErr)
      : null;
  } catch {
    parsed = null;
  }

  if (!response.ok || !parsed || parsed.ok !== true) {
    return {
      kind: "error",
      status: response.status,
      data: (parsed as StewardRefreshErr) ?? {
        ok: false,
        error: text || "Steward refresh failed",
      },
    };
  }
  return { kind: "ok", data: parsed };
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const isProduction = c.env.NODE_ENV === "production";
  const originCheck = checkOrigin(c, isProduction);
  if (!originCheck.ok) {
    logRefresh("forbidden-origin");
    logger.warn("[steward-refresh] rejected cross-origin POST", {
      detail: originCheck.reason,
    });
    return c.json(errorBody("Forbidden", "forbidden_origin"), 403);
  }

  const refreshToken = getCookie(c, STEWARD_REFRESH_TOKEN_COOKIE);
  if (!refreshToken) {
    logRefresh("missing-refresh-cookie");
    return c.json(errorBody("Refresh token required", "missing_token"), 401);
  }

  if (!stewardSecretConfigured(c.env)) {
    logRefresh("server-secret-missing");
    return c.json(
      errorBody(
        "Steward verification not configured on server",
        "server_secret_missing",
      ),
      503,
    );
  }

  const stewardBaseUrl = resolveStewardBaseUrl(c.env);
  if (!stewardBaseUrl) {
    logRefresh("upstream-not-configured");
    return c.json(
      errorBody(
        "Steward upstream not configured",
        "steward_upstream_unavailable",
      ),
      503,
    );
  }

  const refresh = await callStewardRefresh(
    stewardBaseUrl,
    refreshToken,
    c.env.STEWARD_TENANT_ID,
    c.env.STEWARD_REQUEST_SIGNING_SECRET,
  );

  if (refresh.kind === "transport") {
    logRefresh("upstream-transport-error");
    logger.error("[steward-refresh] upstream transport failure", {
      message: refresh.message,
    });
    return c.json(
      errorBody("Steward upstream unavailable", "steward_upstream_unavailable"),
      502,
    );
  }

  if (refresh.kind === "error") {
    logRefresh(`upstream-${refresh.status}`);
    // Steward returns 401 when the refresh token itself is invalid/revoked —
    // the browser's HttpOnly cookie is stale, so clear it so the next page
    // load goes straight to a login surface.
    if (refresh.status === 401) {
      const domain = cookieDomainForHost(c.req.header("host"));
      const opts = domain ? { path: "/", domain } : { path: "/" };
      deleteCookie(c, STEWARD_TOKEN_COOKIE, opts);
      deleteCookie(c, STEWARD_REFRESH_TOKEN_COOKIE, opts);
      deleteCookie(c, STEWARD_AUTHED_COOKIE, opts);
      return c.json(errorBody("Refresh token rejected", "invalid_token"), 401);
    }
    return c.json(
      errorBody(refresh.data.error || "Refresh failed", "internal_error"),
      502,
    );
  }

  const { token, refreshToken: newRefreshToken } = refresh.data;

  const claims = await verifyStewardTokenCached(c.env, token);
  if (!claims) {
    logRefresh("invalid-token-after-refresh");
    return c.json(errorBody("Invalid token", "invalid_token"), 401);
  }

  const ttl = claims.expiration
    ? Math.max(0, claims.expiration - Math.floor(Date.now() / 1000))
    : null;
  const secure = c.env.NODE_ENV === "production";
  const domain = cookieDomainForHost(c.req.header("host"));

  setCookie(c, STEWARD_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    ...(domain ? { domain } : {}),
    ...(typeof ttl === "number" ? { maxAge: ttl } : {}),
  });

  if (typeof newRefreshToken === "string" && newRefreshToken.length > 0) {
    setCookie(c, STEWARD_REFRESH_TOKEN_COOKIE, newRefreshToken, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      maxAge: STEWARD_REFRESH_COOKIE_MAX_AGE,
    });
  }

  setCookie(c, STEWARD_AUTHED_COOKIE, "1", {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    ...(domain ? { domain } : {}),
    maxAge: 60 * 60 * 24 * 7,
  });

  logRefresh("ok");
  return c.json({
    ok: true,
    expiresAt: refresh.data.expiresAt,
    expiresIn: refresh.data.expiresIn,
    ...(shouldReturnClientToken(c, isProduction) ? { token } : {}),
  });
});

export default app;
