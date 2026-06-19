/**
 * Steward session glue for the app-hosted cloud auth/login pages.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/steward-session.ts`. Handles the
 * JWT → HttpOnly cookie sync, the one-time OAuth `code`/`#token` consumption,
 * the server-side nonce exchange, and the cookie-backed refresh — selecting the
 * correct auth endpoint per browser host (so previews and third-party app
 * integrations call their own API worker, never mixing tenants).
 */

import {
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  type StewardNonceExchangeResponse,
  StewardSessionError,
} from "@elizaos/shared/steward-session-client";

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
 * Steward JWT → HttpOnly cookie sync. Production cloud hosts post directly to
 * api.elizacloud.ai so auth callbacks do not depend on a same-origin redirect.
 */
export async function syncStewardSessionCookie(
  token: string,
  refreshToken?: string | null,
): Promise<void> {
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
 * Read the one-time OAuth code from `?code=` or `#code=` (nonce-exchange flow).
 * Strips it from history immediately so it can't leak via history / shared URLs,
 * then returns it. Null when no code is present.
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
 * Parse Steward tokens from the URL hash fragment (legacy rollout fallback). The
 * hash never reaches the server. Strips it after reading. Null when no
 * `#token=` is present so the caller can fall through to `?token=`.
 */
export function consumeStewardTokensFromHash(): {
  token: string;
  refreshToken: string | null;
} | null {
  if (typeof window === "undefined") return null;
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
 * Server-side nonce exchange. Posts the one-time OAuth code to the cloud-api
 * nonce-exchange route, which calls Steward `/auth/oauth/exchange` server-side
 * and sets HttpOnly steward-token cookies. Throws `StewardSessionError` on
 * non-2xx so callers can surface the specific code.
 */
export async function exchangeStewardCodeViaApi(
  code: string,
  opts: { redirectUri?: string; tenantId?: string; codeVerifier?: string } = {},
): Promise<StewardNonceExchangeResponse> {
  const response = await postAuthJson(STEWARD_NONCE_EXCHANGE_ENDPOINT, {
    code,
    ...(opts.redirectUri ? { redirectUri: opts.redirectUri } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
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
 * Cookie-backed session refresh. The HttpOnly `steward-refresh-token` cookie
 * travels automatically; the server exchanges it with Steward and sets fresh
 * cookies. Throws `StewardSessionError` when the cookie is missing/revoked.
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
