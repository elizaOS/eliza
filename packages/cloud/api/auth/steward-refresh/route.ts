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
 *     and the non-HttpOnly `steward-authed=1` marker, using environment-
 *     scoped names outside production.
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

import type { StewardSessionErrorCode } from "@elizaos/shared/steward-session-client";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import {
  mintStewardTokenFromClaims,
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS,
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import {
  LEGACY_STEWARD_COOKIES,
  stewardCookieNames,
} from "@/lib/auth/steward-cookies";
import { signStewardMutatingRequest } from "@/lib/steward/sign";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STEWARD_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const BEARER_REFRESH_TTL_SECONDS = 60 * 60;

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

function readBearerToken(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
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
  const candidates: Array<[string, string | undefined]> = [
    ["STEWARD_API_URL", env.STEWARD_API_URL],
    ["NEXT_PUBLIC_STEWARD_API_URL", env.NEXT_PUBLIC_STEWARD_API_URL],
  ];
  for (const [key, candidate] of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim().replace(/\/+$/, "");
    if (trimmed.length === 0) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return trimmed;
    } catch (error) {
      // A non-empty candidate that fails to parse is a misconfiguration, not a
      // missing value. Name the env var so the resulting 503 is debuggable; never
      // log the value itself (it may contain credentials).
      logger.warn("[StewardAuth] Ignoring unparseable Steward base URL", {
        envVar: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
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
  const bearerToken = readBearerToken(c);
  if (bearerToken) {
    if (!stewardSecretConfigured(c.env)) {
      logRefresh("bearer-server-secret-missing");
      return c.json(
        errorBody(
          "Steward verification not configured on server",
          "server_secret_missing",
        ),
        503,
      );
    }

    const claims = await verifyStewardTokenCached(c.env, bearerToken);
    if (!claims) {
      logRefresh("bearer-invalid-token");
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }

    const refreshed = await mintStewardTokenFromClaims(
      c.env,
      claims,
      BEARER_REFRESH_TTL_SECONDS,
    );
    if (!refreshed) {
      logRefresh("bearer-mint-failed");
      return c.json(
        errorBody(
          "Steward verification not configured on server",
          "server_secret_missing",
        ),
        503,
      );
    }

    logRefresh("ok-bearer");
    return c.json({
      ok: true,
      token: refreshed.token,
      expiresAt: refreshed.expiresAt,
      expiresIn: refreshed.expiresIn,
    });
  }

  const originCheck = checkOrigin(c, isProduction);
  if (!originCheck.ok) {
    logRefresh("forbidden-origin");
    logger.warn("[steward-refresh] rejected cross-origin POST", {
      detail: originCheck.reason,
    });
    return c.json(errorBody("Forbidden", "forbidden_origin"), 403);
  }

  const cookieNames = stewardCookieNames(c.env.ENVIRONMENT);
  // Read only THIS environment's own refresh cookie. The legacy unsuffixed slot
  // lives on the shared parent zone (Domain=elizacloud.ai) where it is
  // production's LIVE refresh token. A non-prod refresh must never read-and-send
  // it to Steward (refresh rotates the token, invalidating prod's copy) nor
  // delete it — that is exactly the deterministic cross-env sign-out of #13728.
  // Pre-rename non-prod sessions simply re-login once as their legacy cookie
  // expires naturally; prod is unaffected (names are identical there).
  const refreshToken = getCookie(c, cookieNames.refreshToken);
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
      deleteCookie(c, cookieNames.token, opts);
      deleteCookie(c, cookieNames.refreshToken, opts);
      deleteCookie(c, cookieNames.authed, opts);
      deleteCookie(c, LEGACY_STEWARD_COOKIES.authed, opts);
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

  setCookie(c, cookieNames.token, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    ...(domain ? { domain } : {}),
    ...(typeof ttl === "number" ? { maxAge: ttl } : {}),
  });

  if (typeof newRefreshToken === "string" && newRefreshToken.length > 0) {
    setCookie(c, cookieNames.refreshToken, newRefreshToken, {
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

  logRefresh("ok");
  return c.json({
    ok: true,
    expiresAt: refresh.data.expiresAt,
    expiresIn: refresh.data.expiresIn,
    ...(shouldReturnClientToken(c, isProduction) ? { token } : {}),
  });
});

export default app;
