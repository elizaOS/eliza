/**
 * Steward session glue for the app-hosted cloud auth/login pages. Handles the
 * JWT → HttpOnly cookie sync, the one-time OAuth `code` consumption, the
 * legacy credential-link stripping (`?token=` / `#token=` are never consumed —
 * a clicked link must never plant a session), the server-side nonce exchange,
 * and the cookie-backed refresh — selecting the correct auth endpoint per
 * browser host (so previews and third-party app integrations call their own
 * API worker, never mixing tenants).
 */

import {
  clearStoredStewardToken,
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  type StewardNonceExchangeResponse,
  StewardSessionError,
  type StewardSessionRequest,
  type StewardTelegramClaimConfirmationRequest,
  sanitizeTelegramAccountClaimContinuation,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  clearPendingOnboardingSessionIfMatches,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "../../join/lib/onboarding-continuation";
import { decodeJwtPayload } from "../../lib/jwt";
import { ELIZA_CLOUD_DIRECT_API_BY_HOST } from "../../shell/steward-url";

export function resolveStewardAuthEndpoint(
  path: string,
  hostname = typeof window === "undefined"
    ? ""
    : window.location.hostname.toLowerCase(),
): string {
  const base = ELIZA_CLOUD_DIRECT_API_BY_HOST[hostname.toLowerCase()];
  return base ? `${base}${path}` : path;
}

async function postAuthJson(
  path: string,
  body?: object,
  method: "POST" | "DELETE" = "POST",
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(resolveStewardAuthEndpoint(path), {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
}

async function readSessionError(response: Response): Promise<{
  error?: string;
  code?: string;
}> {
  // error-policy:J3 best-effort parse of an error response body to extract a
  // structured {error,code}; a non-JSON error body yields {} and the caller
  // uses a generic message. This never fabricates success — it reads a failure.
  return ((await response.json().catch(() => null)) ?? {}) as {
    error?: string;
    code?: string;
  };
}

/**
 * Steward JWT → HttpOnly cookie sync. Production cloud hosts post directly to
 * api.eliza.app so auth callbacks do not depend on a same-origin redirect.
 *
 * Authentication establishment never discovers account-link authority from
 * browser storage. A Telegram claim rides this request only when the
 * /get-started confirmation passes it explicitly after showing the preview.
 */
export async function syncStewardSessionCookie(
  token: string,
  refreshToken?: string | null,
  options?: {
    verifiedPhone?: string;
  },
): Promise<void> {
  const request: StewardSessionRequest = {
    token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(options?.verifiedPhone ? { verifiedPhone: options.verifiedPhone } : {}),
  };
  const response = await postAuthJson(STEWARD_SESSION_ENDPOINT, request);

  if (!response.ok) {
    const body = await readSessionError(response);
    throw new Error(
      body.error || "Could not establish an Eliza Cloud session.",
    );
  }

  if (typeof window !== "undefined") {
    // The cookie boundary may be entered directly by an SDK callback or after
    // the login page already persisted the same token. Canonical storage is
    // idempotent, so both paths publish one authority transition in total.
    await writeStoredStewardToken(token);
    window.dispatchEvent(
      new CustomEvent("steward-token-sync", { detail: { token } }),
    );
  }
}

/**
 * Confirms the exact Telegram identity previewed by /get-started. This is a
 * separate API from session establishment so login, recovery, and SSO cannot
 * acquire claim semantics by discovering browser storage.
 */
export async function confirmTelegramAccountClaim(
  token: string,
  continuation: string,
): Promise<void> {
  const telegramContinuation =
    sanitizeTelegramAccountClaimContinuation(continuation);
  if (!telegramContinuation) {
    throw new Error("Invalid Telegram account claim.");
  }
  const request: StewardTelegramClaimConfirmationRequest = {
    token,
    telegramContinuation,
    telegramClaimConfirmation: "explicit",
  };
  const response = await postAuthJson(STEWARD_SESSION_ENDPOINT, request);
  if (!response.ok) {
    const body = await readSessionError(response);
    throw new Error(body.error || "Could not connect this Telegram account.");
  }
  clearPendingOnboardingSessionIfMatches(
    telegramContinuation,
    TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
  );
  if (typeof window !== "undefined") {
    await writeStoredStewardToken(token);
    window.dispatchEvent(
      new CustomEvent("steward-token-sync", { detail: { token } }),
    );
  }
}

/**
 * Non-destructively detect whether the current URL is an OAuth/token callback
 * (`?code=`, `#code=`, `?token=`, or `#token=`, including a snapshotted
 * `__stewardOAuthHash`). Unlike the `consume*` helpers this does NOT strip
 * anything from history — it only peeks — so it is safe to call from a render
 * pass to gate the UI into a "completing sign-in" state while the async
 * exchange runs. Without this gate the login section renders the full provider
 * options during the exchange round-trip, which reads as the login flashing
 * back to the sign-in options after a successful callback.
 */
export function hasStewardOAuthCallbackInUrl(): boolean {
  if (typeof window === "undefined") return false;

  const query = new URLSearchParams(window.location.search);
  if (query.get("code") || query.get("token")) return true;

  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const hash = stewardWindow.__stewardOAuthHash || window.location.hash;
  if (!hash || hash.length < 2) return false;
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  return Boolean(hashParams.get("code") || hashParams.get("token"));
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
  const nextHash = hashParams.toString();
  if (snapshotted) {
    if (nextHash) {
      stewardWindow.__stewardOAuthHash = `#${nextHash}`;
    } else {
      delete stewardWindow.__stewardOAuthHash;
    }
  } else {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
    );
  }
  return hashCode;
}

/**
 * Consume the app-owned OAuth `state` echo from either the query string or
 * fragment. Steward's nonce-exchange callback intentionally returns `code`
 * and `state` in the fragment, so reading React Router's query params alone
 * rejects every otherwise-valid provider callback as a state mismatch.
 */
export function consumeStewardOAuthStateFromCallback(): string | null {
  if (typeof window === "undefined") return null;

  const queryParams = new URLSearchParams(window.location.search);
  const queryState = queryParams.get("state");
  if (queryState) {
    queryParams.delete("code");
    queryParams.delete("state");
    const query = queryParams.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    return queryState;
  }

  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const snapshotted = stewardWindow.__stewardOAuthHash;
  const hash = snapshotted || window.location.hash;
  if (!hash || hash.length < 2) return null;
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  const hashState = hashParams.get("state");
  if (!hashState) return null;
  hashParams.delete("code");
  hashParams.delete("state");
  const nextHash = hashParams.toString();
  if (snapshotted) {
    if (nextHash) {
      stewardWindow.__stewardOAuthHash = `#${nextHash}`;
    } else {
      delete stewardWindow.__stewardOAuthHash;
    }
  } else {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
    );
  }
  return hashState;
}

/**
 * Legacy `#token=` / `#refreshToken=` hash links are never consumed (a clicked
 * link must never plant a session — the same login-CSRF rule that removed the
 * `?token=` query path). Strip the credential params from the address bar
 * immediately so no token lingers in history, copy/paste, or the reach of
 * third-party scripts booting with the page. Non-credential hash params are
 * preserved. Returns true when anything was stripped.
 */
export function stripLegacyTokenHashFromAddressBar(): boolean {
  if (typeof window === "undefined") return false;
  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const snapshotted = stewardWindow.__stewardOAuthHash;
  const hash = snapshotted || window.location.hash;
  if (!hash || hash.length < 2) return false;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  let stripped = false;
  for (const key of ["token", "refreshToken"] as const) {
    if (params.has(key)) {
      params.delete(key);
      stripped = true;
    }
  }
  if (!stripped) return false;
  if (snapshotted) {
    delete stewardWindow.__stewardOAuthHash;
  } else {
    const nextHash = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
    );
  }
  return true;
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
export async function refreshStewardSessionViaCookie(options?: {
  signal?: AbortSignal;
}): Promise<{
  ok: true;
  expiresAt?: number;
  expiresIn?: number;
  token?: string;
}> {
  const response = await postAuthJson(
    STEWARD_REFRESH_ENDPOINT,
    undefined,
    "POST",
    options?.signal,
  );
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

type RefreshedStewardSession = Awaited<
  ReturnType<typeof refreshStewardSessionViaCookie>
>;

const EMAIL_SESSION_RECOVERY_INTERVAL_MS = 250;
const EMAIL_SESSION_RECOVERY_TIMEOUT_MS = 10_000;

function normalizedEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function waitForRecoveryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Recover the session established by a specific email challenge without ever
 * clearing cookies. A stale marker, an expired refresh cookie, or another
 * account's valid session is treated as "not ready" until the callback's
 * server-verified token is returned and its email claim matches.
 */
export async function recoverStewardEmailSessionViaCookie(
  expectedEmail: string,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<RefreshedStewardSession | null> {
  const expected = normalizedEmail(expectedEmail);
  if (!expected) return null;

  const intervalMs = options.intervalMs ?? EMAIL_SESSION_RECOVERY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? EMAIL_SESSION_RECOVERY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // One composed controller bounds every network attempt: a caller abort or
  // the recovery deadline must cancel an in-flight fetch, not merely stop the
  // loop between attempts — otherwise a hung refresh keeps the advertised
  // 10s/cancellable recovery pending indefinitely.
  const attempt = new AbortController();
  const onCallerAbort = () => attempt.abort();
  if (options.signal?.aborted) attempt.abort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadlineTimer = setTimeout(() => attempt.abort(), timeoutMs);

  try {
    while (!attempt.signal.aborted && Date.now() < deadline) {
      try {
        const session = await refreshStewardSessionViaCookie({
          signal: attempt.signal,
        });
        // Re-check cancellation before accepting: a refresh that resolves
        // after the caller aborted or the deadline passed must not surface a
        // session the caller already stopped waiting for.
        if (attempt.signal.aborted || Date.now() >= deadline) return null;
        const claims = session.token ? decodeJwtPayload(session.token) : null;
        if (normalizedEmail(claims?.email) === expected) return session;
      } catch (error) {
        // error-policy:J4 a cancelled attempt resolves to the explicit null
        // "not recovered" state and an expected 401 keeps polling until the
        // deadline; every other failure stays a typed error for the caller.
        if (attempt.signal.aborted || isAbortError(error)) return null;
        if (!isRejectedCookieSession(error)) throw error;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const shouldContinue = await waitForRecoveryDelay(
        Math.min(intervalMs, remainingMs),
        attempt.signal,
      );
      if (!shouldContinue) return null;
    }

    return null;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const DEAD_SESSION_RETRY_DELAY_MS = 100;

function isRejectedCookieSession(error: unknown): boolean {
  return (
    error instanceof StewardSessionError &&
    error.status === 401 &&
    (error.code === "invalid_token" || error.code === "missing_token")
  );
}

async function clearRejectedCookieSession(): Promise<void> {
  const response = await postAuthJson(
    STEWARD_SESSION_ENDPOINT,
    undefined,
    "DELETE",
  );
  if (!response.ok) {
    const body = await readSessionError(response);
    throw new StewardSessionError(
      body.error || "Could not reset the expired Eliza Cloud session.",
      response.status,
      body.code ?? null,
    );
  }
  await clearStoredStewardToken();
}

/**
 * Restore the cookie session when the login page has only the non-HttpOnly
 * `steward-authed` marker. A refresh token is single-use, so one 401 can be the
 * losing side of another tab's successful rotation. Retry once after that
 * response settles; a second auth rejection proves the cookie is stale enough
 * to clear before rendering a clean sign-in form.
 */
export async function recoverStewardSessionViaCookie(): Promise<{
  ok: true;
  expiresAt?: number;
  expiresIn?: number;
  token?: string;
} | null> {
  try {
    return await refreshStewardSessionViaCookie();
  } catch (error) {
    if (!isRejectedCookieSession(error)) throw error;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, DEAD_SESSION_RETRY_DELAY_MS);
  });

  try {
    return await refreshStewardSessionViaCookie();
  } catch (error) {
    if (!isRejectedCookieSession(error)) throw error;
    await clearRejectedCookieSession();
    return null;
  }
}
