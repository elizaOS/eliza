import {
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  type StewardNonceExchangeResponse,
  StewardSessionError,
} from "@elizaos/shared/steward-session-client";
import { apiFetch } from "./api-client";

/**
 * Same-origin Steward JWT -> HttpOnly cookie sync. Uses `apiFetch` so the
 * call inherits the SPA's API base-URL + credential plumbing.
 *
 * The shared `syncStewardSession()` from `@elizaos/shared/steward-session-client`
 * speaks to global `fetch` and is correct for os-homepage. cloud-frontend
 * goes through `apiFetch` instead — we still use the shared constants and
 * storage helpers so the contract stays in one place.
 */
export async function syncStewardSessionCookie(
  token: string,
  refreshToken?: string | null,
): Promise<void> {
  // Refresh tokens now live only in the HttpOnly `steward-refresh-token`
  // cookie. Forward whatever the caller passes (so first-login can seed the
  // cookie from the legacy URL-fragment flow during rollout), but do NOT
  // read it back from localStorage — that path is gone.
  const response = await apiFetch(STEWARD_SESSION_ENDPOINT, {
    method: "POST",
    skipAuth: true,
    json: {
      token,
      ...(refreshToken ? { refreshToken } : {}),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error || "Could not establish an Eliza Cloud session.",
    );
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("steward-token-sync", { detail: { token } }),
    );
  }
}

/**
 * Read the one-time OAuth code from `?code=` (nonce-exchange flow). Steward
 * redirects to the callback with `?code=<NONCE>` and **no tokens** in the
 * URL. We pull the code, strip it from history immediately so it doesn't
 * appear in browser history / extension snapshots / shared URLs, and POST it
 * server-side. Returns null when no code is present so the caller can fall
 * through to the hash / query token fallbacks during the rollout window.
 */
export function consumeStewardCodeFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;
  params.delete("code");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
  return code;
}

/**
 * Parse Steward tokens from the URL hash fragment. The hash never leaves the
 * browser — it is not sent to the server, not written to access logs, not
 * passed via Referer, and not stored in browser history beyond what the SPA
 * sees on first paint. Strips the hash from `location` immediately after
 * reading so it cannot be re-read or copy-pasted out of the address bar.
 *
 * Returns null when no `#token=` is present so the caller can fall through to
 * the legacy `?token=` query parser during the rollout window.
 */
export function consumeStewardTokensFromHash(): {
  token: string;
  refreshToken: string | null;
} | null {
  if (typeof window === "undefined") return null;
  // The inline pre-init script in index.html snapshots and removes any
  // `#token=...` fragment before React mounts and stores it on
  // window.__stewardOAuthHash. Prefer that so we never depend on the
  // fragment still being in `location.hash` by the time React boots
  // (analytics, Sentry, etc. may have already read `location.href`).
  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const snapshotted = stewardWindow.__stewardOAuthHash;
  const hash = snapshotted || window.location.hash;
  if (snapshotted) {
    delete stewardWindow.__stewardOAuthHash;
  }
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (!token) return null;
  const refreshToken = params.get("refreshToken");
  if (!snapshotted) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return { token, refreshToken };
}

/**
 * Server-side nonce exchange via the SPA's `apiFetch` (matches
 * `syncStewardSessionCookie`'s plumbing — same base URL, same credentials,
 * same skipAuth treatment). Posts the one-time OAuth code to the cloud-api
 * nonce-exchange route, which calls Steward `/auth/oauth/exchange`
 * server-side and sets HttpOnly steward-token cookies. Trusted Cloud origins
 * also receive the short-lived access token so the SPA can hydrate its
 * localStorage mirror until route auth no longer requires synchronous reads.
 *
 * Throws `StewardSessionError` on non-2xx so callers can surface the
 * specific code (`code_invalid`, `code_expired`, `code_redirect_mismatch`,
 * `code_tenant_mismatch`, `steward_upstream_unavailable`).
 */
export async function exchangeStewardCodeViaApi(
  code: string,
  opts: { redirectUri?: string; tenantId?: string; codeVerifier?: string } = {},
): Promise<StewardNonceExchangeResponse> {
  const response = await apiFetch(STEWARD_NONCE_EXCHANGE_ENDPOINT, {
    method: "POST",
    skipAuth: true,
    json: {
      code,
      ...(opts.redirectUri ? { redirectUri: opts.redirectUri } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      // PKCE verifier replayed for `response_type=code`. The cloud-api
      // nonce-exchange route forwards it to Steward `/auth/oauth/exchange`,
      // which checks it against the challenge bound at /authorize.
      ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    throw new StewardSessionError(
      body?.error || "Could not complete Eliza Cloud sign-in.",
      response.status,
      body?.code ?? null,
    );
  }

  return (await response.json()) as StewardNonceExchangeResponse;
}

/**
 * Cookie-backed session refresh. Sends an empty POST to the cloud-api
 * `steward-refresh` route with `credentials: "include"`; the HttpOnly
 * `steward-refresh-token` cookie travels automatically. The server exchanges
 * it with Steward and sets fresh HttpOnly cookies. Trusted Cloud origins also
 * receive a short-lived access token so the SPA can hydrate its localStorage
 * mirror and avoid login loops while route auth still reads synchronously.
 *
 * Throws `ApiError` when the cookie is missing/revoked or the server rejects
 * the refresh.
 */
export async function refreshStewardSessionViaCookie(): Promise<{
  ok: true;
  expiresAt?: number;
  expiresIn?: number;
  token?: string;
}> {
  const response = await apiFetch(STEWARD_REFRESH_ENDPOINT, {
    method: "POST",
    skipAuth: true,
  });
  return (await response.json()) as {
    ok: true;
    expiresAt?: number;
    expiresIn?: number;
    token?: string;
  };
}
