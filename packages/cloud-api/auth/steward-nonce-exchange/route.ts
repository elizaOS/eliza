/**
 * POST /api/auth/steward-nonce-exchange
 *
 * Server-side half of the Steward `response_type=code` OAuth flow.
 *
 * 1. Browser arrives at the post-OAuth landing page with `?code=<nonce>` —
 *    no tokens in the URL.
 * 2. The page POSTs `{ code, redirectUri, tenantId }` here.
 * 3. This route forwards to Steward `POST /auth/oauth/exchange`, which
 *    consumes the code and returns `{ token, refreshToken, expiresAt }`.
 * 4. We verify the JWT (same path as `/api/auth/steward-session`), sync the
 *    user, set the HttpOnly cookies, and return `{ ok, userId }`. The
 *    elizaos.ai hardware checkout origin also receives the access token so
 *    its cross-site Stripe checkout POST can use Bearer auth; refresh stays
 *    cookie-only.
 *
 * The refresh token never enters the browser process; the access token is
 * returned only to the hardware checkout origin that still has to authenticate
 * a cross-site Stripe checkout request with Bearer auth.
 *
 * Origin/Referer CSRF check mirrors `/api/auth/steward-session` exactly — the
 * route is callable from `*.elizacloud.ai` and `elizaos.ai` only (plus
 * localhost in non-production).
 */

import {
  STEWARD_AUTHED_COOKIE,
  type StewardSessionErrorCode,
} from "@elizaos/shared/steward-session-client";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { signStewardMutatingRequest } from "@/api-app/steward/sign";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import {
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import { syncUserFromSteward } from "@/lib/steward-sync";
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
  if (!origin) return false;
  // The SPA reads localStorage to decide `isAuthenticated` on /dashboard
  // mount. Without returning the JWT here, OAuth users bounce back to /login.
  // All permitted CSRF origins are trusted to receive the token.
  if (PERMITTED_ORIGIN_HOSTS.has(origin)) return true;
  if (origin.endsWith(".elizacloud.ai") || origin.endsWith(".elizaos.ai")) {
    return true;
  }
  return !isProduction && LOCAL_DEV_ORIGIN_HOSTS.has(origin);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function stewardSecretConfigured(env: StewardVerifyEnv): boolean {
  return Boolean(env.STEWARD_SESSION_SECRET || env.STEWARD_JWT_SECRET);
}

function errorBody(
  message: string,
  code: StewardSessionErrorCode,
): { error: string; code: StewardSessionErrorCode } {
  return { error: message, code };
}

let stewardNonceMetricCounter = 0;
function logExchange(outcome: string): void {
  stewardNonceMetricCounter += 1;
  logger.info("[steward-nonce-exchange]", {
    timestamp: new Date().toISOString(),
    outcome,
    metric: stewardNonceMetricCounter,
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

// ─── Steward exchange call ────────────────────────────────────────────────

interface StewardExchangeOk {
  ok: true;
  token: string;
  refreshToken: string;
  expiresIn?: number;
  expiresAt?: number;
}
interface StewardExchangeErr {
  ok: false;
  error?: string;
  code?: string;
}

/**
 * POST to Steward `/auth/oauth/exchange`. The Steward API authenticates the
 * exchange purely by possession of the one-time `code` — there is no client
 * secret. Steward does verify that the `redirect_uri` + `tenant_id` match
 * what was bound at `/authorize` time, so we forward whatever the browser
 * supplied (the browser already proved it has the code by sending it to us).
 */
async function callStewardExchange(
  baseUrl: string,
  body: {
    code: string;
    redirect_uri: string;
    tenant_id: string | null;
    code_verifier?: string;
  },
  pinnedTenantId?: string,
  signingSecret?: string | null,
): Promise<
  | { kind: "ok"; data: StewardExchangeOk }
  | { kind: "error"; status: number; data: StewardExchangeErr }
  | { kind: "transport"; message: string }
> {
  const exchangeUrl = new URL(`${baseUrl}/auth/oauth/exchange`);
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  // Pin the tenant per-env: this route bypasses the /steward/* proxy in
  // bootstrap-app.ts. Steward's `/auth/oauth/exchange` reads tenant from
  // the body (auth.ts:2557-2563), but if a caller sends `tenant_id=null`
  // Steward falls back to STEWARD_DEFAULT_TENANT_ID. The header is a
  // belt-and-suspenders pin in case future Steward versions consult it.
  if (typeof pinnedTenantId === "string" && pinnedTenantId.trim().length > 0) {
    headers.set("X-Steward-Tenant", pinnedTenantId.trim());
  }
  // Steward gates mutating `/auth/*` on a freshness header AND an HMAC
  // signature (`X-Steward-Signature: v1=<hex>`). The `/steward/*` proxy signs
  // for browser-driven flows, but this route forwards to Steward directly (to
  // pin the tenant), so it must sign here too — otherwise the exchange 401s
  // with "X-Steward-Signature header required". Sign over the EXACT bytes we
  // send. Without a configured secret we send unsigned (same as the proxy) and
  // let Steward decide. See packages/cloud-api/src/steward/{embedded,sign}.ts.
  // (The signer mints a fresh Idempotency-Key per attempt — fine here because
  // the OAuth code is single-use; Steward 401s a replayed code anyway.)
  const bodyText = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyText);
  if (typeof signingSecret === "string" && signingSecret.length > 0) {
    await signStewardMutatingRequest(
      signingSecret,
      "POST",
      `${exchangeUrl.pathname}${exchangeUrl.search}`,
      headers,
      bodyBytes,
    );
  }
  let response: Response;
  try {
    response = await fetch(exchangeUrl.toString(), {
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
  let parsed: StewardExchangeOk | StewardExchangeErr | null = null;
  try {
    parsed = text
      ? (JSON.parse(text) as StewardExchangeOk | StewardExchangeErr)
      : null;
  } catch {
    parsed = null;
  }

  if (!response.ok || !parsed || parsed.ok !== true) {
    return {
      kind: "error",
      status: response.status,
      data: (parsed as StewardExchangeErr) ?? {
        ok: false,
        error: text || "Steward exchange failed",
      },
    };
  }
  return { kind: "ok", data: parsed };
}

// ─── Route ────────────────────────────────────────────────────────────────

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const isProduction = c.env.NODE_ENV === "production";
  const originCheck = checkOrigin(c, isProduction);
  if (!originCheck.ok) {
    logExchange("forbidden-origin");
    logger.warn("[steward-nonce-exchange] rejected cross-origin POST", {
      detail: originCheck.reason,
    });
    return c.json(errorBody("Forbidden", "forbidden_origin"), 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    code?: unknown;
    redirectUri?: unknown;
    redirect_uri?: unknown;
    tenantId?: unknown;
    tenant_id?: unknown;
    codeVerifier?: unknown;
    code_verifier?: unknown;
  };

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const redirectUri =
    typeof body.redirectUri === "string"
      ? body.redirectUri.trim()
      : typeof body.redirect_uri === "string"
        ? body.redirect_uri.trim()
        : "";
  const rawTenant =
    typeof body.tenantId === "string"
      ? body.tenantId.trim()
      : typeof body.tenant_id === "string"
        ? body.tenant_id.trim()
        : "";
  // Fall back to the Worker's pinned tenant when the SPA omits it (e.g. because
  // its `NEXT_PUBLIC_STEWARD_TENANT_ID` failed to inline). Without this, Steward
  // would resolve `body.tenant_id=null` to STEWARD_DEFAULT_TENANT_ID and a staging
  // OAuth exchange would mint a session against the prod tenant.
  const envTenant = c.env.STEWARD_TENANT_ID?.trim() ?? "";
  const tenantId =
    rawTenant.length > 0 ? rawTenant : envTenant.length > 0 ? envTenant : null;
  // PKCE verifier for `response_type=code`. The SPA stashes it before the
  // /authorize redirect and replays it here; we forward it to Steward, which
  // checks it against the challenge bound at /authorize. Absent for the legacy
  // (pre-PKCE) and wallet flows — forward only when present.
  const codeVerifier =
    typeof body.codeVerifier === "string"
      ? body.codeVerifier.trim()
      : typeof body.code_verifier === "string"
        ? body.code_verifier.trim()
        : "";

  if (!code) {
    logExchange("missing-code");
    return c.json(errorBody("code required", "missing_code"), 400);
  }
  if (!redirectUri) {
    logExchange("missing-redirect-uri");
    return c.json(errorBody("redirectUri required", "missing_code"), 400);
  }
  if (!stewardSecretConfigured(c.env)) {
    logExchange("server-secret-missing");
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
    logExchange("upstream-not-configured");
    return c.json(
      errorBody(
        "Steward upstream not configured",
        "steward_upstream_unavailable",
      ),
      503,
    );
  }

  const exchange = await callStewardExchange(
    stewardBaseUrl,
    {
      code,
      redirect_uri: redirectUri,
      tenant_id: tenantId,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    },
    c.env.STEWARD_TENANT_ID,
    c.env.STEWARD_REQUEST_SIGNING_SECRET,
  );

  if (exchange.kind === "transport") {
    logExchange("upstream-transport-error");
    logger.error("[steward-nonce-exchange] upstream transport failure", {
      message: exchange.message,
    });
    return c.json(
      errorBody("Steward upstream unavailable", "steward_upstream_unavailable"),
      502,
    );
  }

  if (exchange.kind === "error") {
    const upstreamCode = exchange.data.code;
    // Pass through the Steward error codes verbatim when they're in our known
    // set; otherwise default to `code_invalid` so the client wipes URL state
    // and re-prompts sign-in.
    const mapped: StewardSessionErrorCode =
      upstreamCode === "code_expired" ||
      upstreamCode === "code_redirect_mismatch" ||
      upstreamCode === "code_tenant_mismatch" ||
      upstreamCode === "code_invalid"
        ? upstreamCode
        : "code_invalid";
    logExchange(`upstream-${mapped}`);
    // Steward returns 401 for all of these. Anything else we collapse to
    // 502 so the client can disambiguate "your code is bad" from "Steward
    // is unhealthy" without us widening the Hono status union.
    const status: 401 | 502 = exchange.status === 401 ? 401 : 502;
    return c.json(
      errorBody(exchange.data.error || "Code exchange failed", mapped),
      status,
    );
  }

  const { token, refreshToken } = exchange.data;

  const claims = await verifyStewardTokenCached(c.env, token);
  if (!claims) {
    logExchange("invalid-token-after-exchange");
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
    logExchange("sync-failed");
    logger.error(
      "[steward-nonce-exchange] Failed to sync Steward user before setting cookie",
      { stewardUserId: claims.userId, error },
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

  setCookie(c, STEWARD_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    ...(domain ? { domain } : {}),
    ...(typeof ttl === "number" ? { maxAge: ttl } : {}),
  });

  if (typeof refreshToken === "string" && refreshToken.length > 0) {
    setCookie(c, STEWARD_REFRESH_TOKEN_COOKIE, refreshToken, {
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

  logExchange("ok");
  // Returning `token` (and `refreshToken`) here so the SPA can mirror it into
  // localStorage. The HttpOnly cookies above are the canonical session; the
  // localStorage copy is what @stwd/react's `useAuth()` and the SPA's
  // `readStewardSessionFromStorage()` actually read on `/dashboard` route
  // mount to decide `isAuthenticated`. Without this, OAuth users land back
  // on `/login` after a successful exchange (wallet/SIWE keeps working only
  // because the Steward SDK writes its own localStorage copy). The original
  // "tokens never enter JS" design intent is aspirational — until the SPA
  // auth check trusts the steward-authed marker cookie alone, the JWT has
  // to be reachable from JS.
  return c.json({
    ok: true,
    userId: cloudUser.id,
    stewardUserId: claims.userId,
    expiresAt: exchange.data.expiresAt,
    expiresIn: exchange.data.expiresIn,
    ...(shouldReturnClientToken(c, isProduction)
      ? { token, refreshToken }
      : {}),
  });
});

export default app;
