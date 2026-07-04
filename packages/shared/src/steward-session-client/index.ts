/**
 * Shared Steward session client.
 *
 * Single source of truth for:
 *  - the storage / cookie / endpoint key names used across os-homepage
 *    (`elizaos.ai`), cloud-frontend (`elizacloud.ai`), and the cloud-api
 *    `/api/auth/steward-session` route handler;
 *  - the request / response / error shapes the route exchanges with the
 *    browser;
 *  - the small set of helpers each consumer needs (sync, clear, read).
 *
 * Browser-only helpers return cleanly under SSR (`typeof window === "undefined"`).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key for the Steward access token (JWT). */
export const STEWARD_TOKEN_KEY = "steward_session_token";

/**
 * localStorage key for the Steward refresh token.
 *
 * Refresh tokens are persisted only as the HttpOnly `steward-refresh-token`
 * cookie (set by `/api/auth/steward-session` and
 * `/api/auth/steward-nonce-exchange`). This key is retained solely so
 * `clearStoredStewardToken()` can drain the stale localStorage value left in
 * tabs opened before the cookie-only rollout. Do NOT read or write it.
 */
export const STEWARD_REFRESH_TOKEN_KEY = "steward_refresh_token";

/** Non-HttpOnly cookie set to "1" while the server-side session is live. */
export const STEWARD_AUTHED_COOKIE = "steward-authed";

/** Steward multi-tenant identifier for Eliza Cloud. */
export const STEWARD_TENANT_ID = "elizacloud";

/** Same-origin endpoint that exchanges the JWT for HttpOnly cookies. */
export const STEWARD_SESSION_ENDPOINT = "/api/auth/steward-session";

/**
 * Same-origin endpoint that swaps a one-time OAuth `code` (the nonce-exchange
 * flow's `?code=` query param) for HttpOnly cookies. The endpoint calls
 * Steward's `POST /auth/oauth/exchange` server-side so the access and refresh
 * tokens never touch the browser URL.
 */
export const STEWARD_NONCE_EXCHANGE_ENDPOINT =
  "/api/auth/steward-nonce-exchange";

/**
 * Same-origin endpoint that rotates the Steward access + refresh tokens
 * using the HttpOnly `steward-refresh-token` cookie. The browser POSTs
 * with `credentials: "include"`; the cookie travels automatically. Trusted
 * Cloud browser origins receive the short-lived access token so the SPA can
 * refresh its localStorage mirror while route auth remains synchronous.
 */
export const STEWARD_REFRESH_ENDPOINT = "/api/auth/steward-refresh";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StewardSessionRequest {
  token: string;
  refreshToken?: string | null;
}

export interface StewardSessionResponse {
  ok: true;
  userId: string;
  stewardUserId: string;
  initialCreditsGranted?: boolean;
  initialFreeCreditsUsd?: number;
  welcomeBonusWithheld?: boolean;
  // Mirrors `SignupGrantWithheldReason` in
  // packages/cloud/shared/src/lib/services/signup-grant-guard.ts (the source of
  // truth). Kept as an inline literal union because `packages/shared` cannot
  // depend on `packages/cloud/shared`; keep in sync when reasons are added.
  welcomeBonusWithheldReason?: "ip_daily_cap" | "count_unavailable";
  welcomeBonusWithheldMessage?: string;
}

/**
 * Distinct outcomes the cloud-api route returns. The client uses these to
 * decide whether to wipe localStorage (`invalid_token`) or hold steady
 * (`server_secret_missing`).
 */
export type StewardSessionErrorCode =
  | "missing_token"
  | "invalid_token"
  | "server_secret_missing"
  | "steward_user_sync_failed"
  | "internal_error"
  // Nonce-exchange (response_type=code) outcomes. Surfaced both by the
  // cloud-api route and proxied through from Steward's /oauth/exchange.
  | "missing_code"
  | "code_invalid"
  | "code_expired"
  | "code_redirect_mismatch"
  | "code_tenant_mismatch"
  | "steward_upstream_unavailable"
  | "forbidden_origin";

export class StewardSessionError extends Error {
  readonly status: number;
  readonly code: StewardSessionErrorCode | string | null;

  constructor(
    message: string,
    status: number,
    code: StewardSessionErrorCode | string | null,
  ) {
    super(message);
    this.name = "StewardSessionError";
    this.status = status;
    this.code = code;
  }
}

export interface SyncOpts {
  /**
   * Absolute or relative URL to POST to. Defaults to STEWARD_SESSION_ENDPOINT
   * (same-origin). Pass an absolute URL when crossing origins
   * (e.g. elizaos.ai -> api.elizacloud.ai).
   */
  endpoint?: string;
  /**
   * Override the global fetch (mainly for tests and SSR shims).
   */
  fetchImpl?: typeof fetch;
}

export interface ClearOpts {
  /** Endpoints to DELETE. Defaults to [STEWARD_SESSION_ENDPOINT]. */
  endpoints?: string[];
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

export function readStoredStewardToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeStoredStewardToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, token);
  } catch {
    // localStorage may be disabled (private mode, quota, sandboxed iframe);
    // callers that need durability should detect this themselves.
  }
}

export function clearStoredStewardToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STEWARD_TOKEN_KEY);
    window.localStorage.removeItem(STEWARD_REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Returns true when the non-HttpOnly `steward-authed=1` marker cookie is
 * present. The JWT cookie itself is HttpOnly, so JS uses this hint to know
 * "there is a server session" without ever touching the token.
 */
export function hasStewardAuthedCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((part) => part.trim().startsWith(`${STEWARD_AUTHED_COOKIE}=1`));
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function readErrorBody(
  response: Response,
): Promise<{ error?: string; code?: string } | null> {
  try {
    return (await response.json()) as { error?: string; code?: string };
  } catch {
    return null;
  }
}

/**
 * POSTs the Steward JWT (+ optional refresh token) to the session endpoint
 * so the server can set HttpOnly cookies. Throws `StewardSessionError` on
 * non-2xx; caller decides whether to wipe localStorage based on `error.code`.
 */
export async function syncStewardSession(
  token: string,
  refreshToken?: string | null,
  opts: SyncOpts = {},
): Promise<StewardSessionResponse> {
  const endpoint = opts.endpoint ?? STEWARD_SESSION_ENDPOINT;
  const f = opts.fetchImpl ?? fetch;
  // Refresh tokens now live exclusively in the HttpOnly
  // `steward-refresh-token` cookie. We forward whatever the caller passes
  // (e.g. the value still arriving in a legacy URL fragment during the
  // rollout window) so the server can set the cookie on first login, but we
  // do NOT read it back from localStorage — that path is being removed.
  const body: StewardSessionRequest = {
    token,
    ...(refreshToken ? { refreshToken } : {}),
  };
  const response = await f(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await readErrorBody(response);
    throw new StewardSessionError(
      errBody?.error || "Could not establish an Eliza Cloud session.",
      response.status,
      errBody?.code ?? null,
    );
  }
  return (await response.json()) as StewardSessionResponse;
}

// ---------------------------------------------------------------------------
// Nonce-exchange (response_type=code) flow
// ---------------------------------------------------------------------------

export interface StewardNonceExchangeRequest {
  /** One-time code from the Steward redirect (`?code=`). */
  code: string;
  /**
   * The `redirect_uri` that was sent to Steward `/authorize`. Steward verifies
   * this matches what was issued. If omitted, the cloud-api route falls back
   * to the value provided server-side via env / convention; in practice the
   * caller should send the same redirect_uri it used originally.
   */
  redirectUri?: string;
  /** Steward tenant ID (e.g. "elizacloud"). */
  tenantId?: string;
  /** PKCE verifier paired with the `code_challenge` sent to Steward. */
  codeVerifier?: string;
}

export interface StewardNonceExchangeResponse extends StewardSessionResponse {
  expiresIn?: number;
  expiresAt?: number;
  /**
   * Steward JWT. Mirrored from the upstream Steward exchange so the SPA can
   * write it to localStorage (required by `@stwd/react`'s `useAuth()` to
   * report `isAuthenticated=true`). HttpOnly cookies are still the canonical
   * session — this is the JS-readable copy that keeps the wallet and OAuth
   * paths symmetric.
   */
  token?: string;
  refreshToken?: string;
}

export interface ExchangeStewardCodeOpts extends SyncOpts {
  /** redirect_uri that was sent to /authorize (must match exactly). */
  redirectUri?: string;
  /** Steward tenant id. */
  tenantId?: string;
  /** PKCE verifier paired with the `code_challenge` sent to Steward. */
  codeVerifier?: string;
}

/**
 * POSTs the one-time OAuth code to the cloud-api nonce-exchange endpoint.
 * The route calls Steward `POST /auth/oauth/exchange` server-side, sets the
 * HttpOnly steward-token + steward-refresh-token cookies, and returns the
 * Eliza Cloud user id. Some cross-origin checkout callers may also receive a
 * browser bearer token. Throws `StewardSessionError` on non-2xx.
 */
export async function exchangeStewardCode(
  code: string,
  opts: ExchangeStewardCodeOpts = {},
): Promise<StewardNonceExchangeResponse> {
  const endpoint = opts.endpoint ?? STEWARD_NONCE_EXCHANGE_ENDPOINT;
  const f = opts.fetchImpl ?? fetch;
  const body: StewardNonceExchangeRequest = {
    code,
    ...(opts.redirectUri ? { redirectUri: opts.redirectUri } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}),
  };
  const response = await f(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await readErrorBody(response);
    throw new StewardSessionError(
      errBody?.error || "Could not complete Eliza Cloud sign-in.",
      response.status,
      errBody?.code ?? null,
    );
  }
  return (await response.json()) as StewardNonceExchangeResponse;
}

/**
 * Best-effort DELETE of every configured session endpoint. Failures are
 * swallowed — the caller has already wiped localStorage and there's nothing
 * useful to do about a cookie that won't clear.
 */
export {
  buildStewardOAuthAuthorizeUrl,
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardPkceVerifier,
  type StewardOAuthProvider,
  type StewardPkcePair,
  storeStewardPkceVerifier,
} from "./steward-oauth-pkce.js";

export function clearStewardSession(opts: ClearOpts = {}): void {
  const endpoints = opts.endpoints ?? [STEWARD_SESSION_ENDPOINT];
  const f = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return;
  for (const url of endpoints) {
    f(url, { method: "DELETE", credentials: "include" }).catch(() => {
      // ignore — see jsdoc
    });
  }
}
