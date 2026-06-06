import {
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  type StewardNonceExchangeResponse,
  StewardSessionError,
} from "@elizaos/shared/steward-session-client";

// Cross-zone direct-call routing for the Steward auth bypass endpoints.
// Pages previews and third-party app integrations need an absolute URL —
// the SPA can be served from a host that isn't bound to its API Worker.
// Each browser host MUST point at its OWN API Worker because the Workers
// pin a tenant via STEWARD_TENANT_ID and the bypass routes 401 with
// `code_invalid` when a code minted for one tenant is exchanged against
// another. Mixing staging into the prod base previously sent
// staging-tenant codes (`elizacloud-staging`) to the prod tenant
// (`elizacloud`) Worker — the silent failure that lands users back on
// /login after the magic-link callback.
const ELIZA_CLOUD_AUTH_BASES: Record<string, string> = {
  "elizacloud.ai": "https://api.elizacloud.ai",
  "www.elizacloud.ai": "https://api.elizacloud.ai",
  "dev.elizacloud.ai": "https://api.elizacloud.ai",
  "staging.elizacloud.ai": "https://api-staging.elizacloud.ai",
};

export function resolveStewardAuthEndpoint(
  path: string,
  hostname = typeof window === "undefined"
    ? ""
    : window.location.hostname.toLowerCase(),
): string {
  const base = ELIZA_CLOUD_AUTH_BASES[hostname.toLowerCase()];
  return base ? `${base}${path}` : path;
}

async function postAuthJson(
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(resolveStewardAuthEndpoint(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function readSessionError(response: Response): Promise<{
  error?: string;
  code?: string;
}> {
  return ((await response.json().catch(() => null)) ?? {}) as {
    error?: string;
    code?: string;
  };
}

/**
 * Steward JWT -> HttpOnly cookie sync. Production cloud hosts post directly to
 * api.elizacloud.ai so auth callbacks do not depend on a same-origin redirect.
 *
 * The shared `syncStewardSession()` from `@elizaos/shared/steward-session-client`
 * uses same-origin fetch and is correct for os-homepage. cloud-frontend keeps
 * its endpoint selection here while still sharing constants and storage keys.
 */
export async function syncStewardSessionCookie(
  token: string,
  refreshToken?: string | null,
): Promise<void> {
  // Refresh tokens now live only in the HttpOnly `steward-refresh-token`
  // cookie. Forward whatever the caller passes (so first-login can seed the
  // cookie from the legacy URL-fragment flow during rollout), but do NOT
  // read it back from localStorage — that path is gone.
  const response = await postAuthJson(STEWARD_SESSION_ENDPOINT, {
    token,
    ...(refreshToken ? { refreshToken } : {}),
  });

  if (!response.ok) {
    const body = await readSessionError(response);
    throw new Error(
      body.error || "Could not establish an Eliza Cloud session.",
    );
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("steward-token-sync", { detail: { token } }),
    );
  }
}

/**
 * Read the one-time OAuth code from `?code=` or `#code=` (nonce-exchange
 * flow). We pull the code, strip it from history immediately so it doesn't
 * appear in browser history / extension snapshots / shared URLs, and POST it
 * server-side. Returns null when no code is present so the caller can fall
 * through to the token fallbacks during the rollout window.
 */
export function consumeStewardCodeFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code) {
    params.delete("code");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    return code;
  }

  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const snapshotted = stewardWindow.__stewardOAuthHash;
  const hash = snapshotted || window.location.hash;
  if (!hash || hash.length < 2) return null;
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  const hashCode = hashParams.get("code");
  if (!hashCode) return null;
  hashParams.delete("code");
  if (snapshotted) {
    delete stewardWindow.__stewardOAuthHash;
  } else {
    const nextHash = hashParams.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
    );
  }
  return hashCode;
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
 * Server-side nonce exchange via the same auth endpoint selection as
 * `syncStewardSessionCookie`. Posts the one-time OAuth code to the cloud-api
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
  const response = await postAuthJson(STEWARD_NONCE_EXCHANGE_ENDPOINT, {
    code,
    ...(opts.redirectUri ? { redirectUri: opts.redirectUri } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    // PKCE verifier replayed for `response_type=code`. The cloud-api
    // nonce-exchange route forwards it to Steward `/auth/oauth/exchange`,
    // which checks it against the challenge bound at /authorize.
    ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}),
  });

  if (!response.ok) {
    const body = await readSessionError(response);
    throw new StewardSessionError(
      body.error || "Could not complete Eliza Cloud sign-in.",
      response.status,
      body.code ?? null,
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
  const response = await postAuthJson(STEWARD_REFRESH_ENDPOINT);
  if (!response.ok) {
    const body = await readSessionError(response);
    throw new StewardSessionError(
      body.error || "Could not refresh Eliza Cloud sign-in.",
      response.status,
      body.code ?? null,
    );
  }
  return (await response.json()) as {
    ok: true;
    expiresAt?: number;
    expiresIn?: number;
    token?: string;
  };
}
