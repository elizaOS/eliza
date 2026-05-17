"use client";

import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";
import {
  clearStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/steward-session-client";
import { StewardProvider, useAuth as useStewardAuth } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";
import { createContext, useEffect, useMemo, useRef } from "react";

/**
 * Steward authentication provider for Eliza Cloud.
 *
 * Wraps children in Steward auth context, syncs JWT tokens to a global API client, and validates env config on mount.
 *
 * Defaults to the same-origin /steward mount; NEXT_PUBLIC_STEWARD_API_URL is only an override.
 * Optional: NEXT_PUBLIC_STEWARD_TENANT_ID for multi-tenant setups.
 */

function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("your_steward_") ||
    normalized.includes("your-steward-") ||
    normalized.includes("replace_with") ||
    normalized.includes("placeholder")
  );
}

/**
 * IMPORTANT: Vite production builds replace `import.meta.env` with a literal
 * containing only the 5 standard fields (BASE_URL/DEV/MODE/PROD/SSR). Custom
 * `VITE_*` vars are inlined only when read via the literal property name
 * (`import.meta.env.VITE_FOO`). A dynamic `env[name]` lookup silently
 * returns `undefined` in prod — which breaks both the Playwright auth bypass
 * AND the runtime Steward API URL resolution. Read each env var by its
 * literal name below.
 */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isPlaywrightTestAuthEnabled(): boolean {
  if (import.meta.env?.VITE_PLAYWRIGHT_TEST_AUTH === "true") return true;
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true"
  ) {
    return true;
  }
  return false;
}

/**
 * Inner wrapper that syncs the Steward JWT to a global API client
 * so authenticated requests outside React components work correctly.
 */
const ELIZA_CLOUD_COOKIE_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);
const ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT =
  "https://api.elizacloud.ai/api/auth/steward-session";
const ELIZA_CLOUD_DIRECT_REFRESH_ENDPOINT =
  "https://api.elizacloud.ai/api/auth/steward-refresh";

export const LocalStewardAuthContext = createContext<ReturnType<
  typeof useStewardAuth
> | null>(null);

function isLocalhostApiBase(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(
    value.trim(),
  );
}

function isBrowserOnElizaHost(): boolean {
  return (
    typeof window !== "undefined" &&
    ELIZA_CLOUD_COOKIE_HOSTS.has(window.location.hostname.toLowerCase())
  );
}

function configuredSessionEndpoint(): string {
  // Vite inlines these only via the literal property name; do not rewrite
  // these to a dynamic lookup helper (see comment at top of file).
  const apiBase =
    import.meta.env?.VITE_API_URL ||
    import.meta.env?.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_URL;
  // Reject localhost API bases when running in a browser pointed at a known
  // Eliza Cloud host. A build that leaked the dev URL into the production
  // bundle would otherwise POST to http://localhost:3000 and the browser CSP
  // blocks it; fall through to the same-origin / direct api.elizacloud.ai path.
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_SESSION_ENDPOINT}`;
    }
  }
  // No apiBase (or it was localhost on a real host): prefer the direct
  // api.elizacloud.ai URL when on a known Eliza Cloud host so the call
  // does not depend on the Pages Functions `/api/*` proxy being live.
  if (isBrowserOnElizaHost()) {
    return ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT;
  }
  return STEWARD_SESSION_ENDPOINT;
}

function configuredRefreshEndpoint(): string {
  // Mirrors configuredSessionEndpoint() exactly so the cookie-based refresh
  // call hits the same host as the session sync (same cookie domain, same
  // CORS allowance, same Pages-Functions vs direct-API decision).
  const apiBase =
    import.meta.env?.VITE_API_URL ||
    import.meta.env?.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_URL;
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_REFRESH_ENDPOINT}`;
    }
  }
  if (isBrowserOnElizaHost()) {
    return ELIZA_CLOUD_DIRECT_REFRESH_ENDPOINT;
  }
  return STEWARD_REFRESH_ENDPOINT;
}

function stewardSessionClearUrls(): string[] {
  if (typeof window === "undefined") return [configuredSessionEndpoint()];
  const urls = new Set([STEWARD_SESSION_ENDPOINT, configuredSessionEndpoint()]);
  if (isBrowserOnElizaHost()) {
    urls.add(ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT);
  }
  return [...urls];
}

function clearServerStewardSessionCookies(): void {
  for (const url of stewardSessionClearUrls()) {
    fetch(url, { method: "DELETE", credentials: "include" }).catch(() => {});
  }
}

function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    return null;
  }
}

function tokenIsExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded));
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

/**
 * Syncs the Steward JWT from localStorage to a server cookie so Hono/API
 * routes can read it. Works independent of @stwd/react's internal
 * auth state (which can be slow/flaky to initialize from storage during
 * hydration) by reading localStorage directly.
 */
/** How often to check token expiry and trigger refresh (ms) */
const REFRESH_CHECK_INTERVAL_MS = 60_000; // 1 min
/** Refresh when fewer than this many seconds remain */
const REFRESH_AHEAD_SECS = 120;

function tokenSecsRemaining(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded));
    if (!payload.exp) return null;
    return payload.exp - Date.now() / 1000;
  } catch {
    return null;
  }
}

/**
 * Wipe every trace of an in-browser Steward session.
 *
 * Use this when the SERVER has rejected a token that locally still looks
 * valid (JWT decodes with future exp, but DELETE/POST /api/auth/steward-session
 * returned 401, or the user's session was revoked / db reset / cookies
 * cleared on one device but not another). Without this, a stale-but-not-
 * expired token sits in localStorage, useSessionAuth() reports
 * authenticated=true, every authed call 401s, and pages that gate UI on
 * `authenticated` get stuck in dead-end loading states (notably
 * /auth/cli-login).
 *
 * Safe to call multiple times. Best-effort: ignores fetch / storage errors.
 * Dispatches `steward-token-sync` so any listener (useSessionAuth, etc.)
 * recomputes auth state and re-renders the user back to a login surface.
 */
export function clearStaleStewardSession(): void {
  if (typeof window === "undefined") return;
  clearStoredStewardToken();
  // Server-side cookies (HttpOnly — JS can't touch them directly).
  clearServerStewardSessionCookies();
  // Notify any in-tab listeners; the "storage" event covers cross-tab.
  try {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  } catch {
    // ignore
  }
}

function AuthTokenSync({ children }: { children: React.ReactNode }) {
  const auth = useStewardAuth();
  const { isAuthenticated, user } = auth;
  const lastSyncedToken = useRef<string | null>(null);
  const wasAuthenticated = useRef(false);

  // Sync localStorage access token → cookie and keep it alive via the
  // cookie-based refresh endpoint. The refresh token itself is no longer
  // read from localStorage — it lives only in the HttpOnly
  // `steward-refresh-token` cookie and is replayed server-side by the
  // /api/auth/steward-refresh route.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run trigger
  useEffect(() => {
    const syncToken = () => {
      const token = readStoredToken();
      if (!token) {
        // No token at all — clear the server cookie if we had one
        if (wasAuthenticated.current && lastSyncedToken.current) {
          lastSyncedToken.current = null;
          wasAuthenticated.current = false;
          clearServerStewardSessionCookies();
        }
        return;
      }

      // If the token is expired, don't push it to the server (the server would
      // reject it anyway), but don't delete the cookie either — the refresh
      // path may recover. Only explicit sign-out clears cookies.
      if (tokenIsExpired(token)) return;

      if (token === lastSyncedToken.current) {
        return;
      }
      lastSyncedToken.current = token;
      wasAuthenticated.current = true;

      // No refreshToken in the body — the HttpOnly steward-refresh-token
      // cookie (set on first login) is the only persistence. credentials:
      // 'include' keeps cross-site cookie flow on .elizacloud.ai working.
      fetch(configuredSessionEndpoint(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then(async (res) => {
          if (res.ok) {
            window.dispatchEvent(
              new CustomEvent("steward-token-sync", {
                detail: { token, userId: user?.id },
              }),
            );
            return;
          }

          // 401 from /api/auth/steward-session is ambiguous: either the
          // token is genuinely revoked / the signing key rotated (wipe so
          // the user signs in fresh — matches the cli-login fix) OR the
          // Worker is missing its signing secret (wipe would lock the user
          // out forever on a misconfigured deploy). Disambiguate via the
          // `code` field on the body added in the steward-session route.
          // Legacy servers without `code` get the original "wipe on 401"
          // behavior preserved from PR #480.
          const body = (await res.json().catch(() => null)) as {
            code?: string;
          } | null;
          if (body?.code === "server_secret_missing") {
            console.warn(
              "[steward] /api/auth/steward-session reports server-side secret missing — keeping localStorage token; cookie path will fail until the Worker is configured.",
            );
            return;
          }
          if (res.status !== 401) {
            console.warn("[steward] Server did not accept stored token", {
              status: res.status,
              code: body?.code,
            });
            return;
          }
          console.warn(
            "[steward] Stored token rejected by server (401) — clearing",
          );
          lastSyncedToken.current = null;
          wasAuthenticated.current = false;
          clearStaleStewardSession();
        })
        .catch((err) =>
          console.warn("[steward] Failed to set session cookie", err),
        );
    };

    const checkAndRefresh = async () => {
      const token = readStoredToken();
      // Check if we have an access token to look at expiry. Even when
      // localStorage is empty (cookie-only mode) we still want to attempt a
      // refresh on visibility/online so the steward-authed marker can be
      // re-established — but only if hasStewardAuthedCookie() suggests the
      // server thinks we have a session. Without that we'd 401-spam.
      if (token) {
        const secs = tokenSecsRemaining(token);
        // Refresh eagerly when the token is within the lookahead window OR
        // already expired (e.g. tab was idle longer than 15 min). Dropping
        // the `secs > 0` guard is the key fix for the silent-logout bug:
        // previously, once the access token expired we stopped trying to
        // refresh even though the refresh token was still good.
        if (secs !== null && secs >= REFRESH_AHEAD_SECS) return;
      } else {
        // No access token in localStorage and no obvious need to refresh.
        return;
      }

      // Cookie-based refresh: the browser sends the HttpOnly
      // steward-refresh-token cookie automatically. The server rotates and
      // returns ok with no body tokens; the new access cookie is now live.
      // The access token in localStorage can no longer be refreshed by JS
      // (we don't get it back) — call sites that rely on Authorization:
      // Bearer should migrate to cookie-based auth. For now, on success we
      // wipe the stored access token so the next syncToken() reads the
      // cookie-only state cleanly; @stwd/react will repopulate it on its
      // own auth-state cycle if still applicable.
      try {
        const res = await fetch(configuredRefreshEndpoint(), {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) {
          // The new access token is in the HttpOnly cookie — JS cannot read
          // it. Bump the "we have a server session" marker so listeners
          // re-check auth state.
          try {
            window.dispatchEvent(new CustomEvent("steward-token-sync"));
          } catch {
            // ignore
          }
          return;
        }
        if (res.status === 401) {
          // Refresh cookie revoked / missing — full sign-out.
          if (wasAuthenticated.current && lastSyncedToken.current) {
            lastSyncedToken.current = null;
            wasAuthenticated.current = false;
          }
          clearStaleStewardSession();
        }
      } catch (err) {
        console.warn("[steward] Auto-refresh failed", err);
      }
    };

    // Initial sync + eager refresh check (covers returning-from-idle tabs)
    syncToken();
    void checkAndRefresh();

    // Periodic refresh check
    const refreshInterval = setInterval(() => {
      void checkAndRefresh();
    }, REFRESH_CHECK_INTERVAL_MS);

    // Also sync on storage events (cross-tab, login flow)
    const handler = () => syncToken();
    window.addEventListener("storage", handler);

    // When the tab becomes visible again, immediately check-and-refresh.
    // Browser timers (setInterval) are throttled heavily in background tabs
    // (down to ~1 call per minute in Chrome, and suspended entirely in some
    // cases), so a user coming back after 15 min may have an expired token
    // even though the interval "should" have kept it alive.
    const visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        syncToken();
        void checkAndRefresh();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    // Also refresh on network reconnect, which commonly correlates with
    // tab-wakeup scenarios (laptop opening, WiFi reconnecting).
    const onlineHandler = () => {
      void checkAndRefresh();
    };
    window.addEventListener("online", onlineHandler);

    return () => {
      clearInterval(refreshInterval);
      window.removeEventListener("storage", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("online", onlineHandler);
    };
  }, [isAuthenticated, user]);

  return (
    <LocalStewardAuthContext.Provider value={auth}>
      {children}
    </LocalStewardAuthContext.Provider>
  );
}

export function StewardAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const hasLoggedConfigError = useRef(false);
  const playwrightTestAuthEnabled = isPlaywrightTestAuthEnabled();

  const apiUrl = resolveBrowserStewardApiUrl();
  const tenantId = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID;
  const hasValidUrl = !isPlaceholderValue(apiUrl);

  // Create a StewardClient instance once (no API key needed for user-facing auth flows)
  const client = useMemo(
    () =>
      new StewardClient({
        baseUrl: apiUrl,
        ...(tenantId && !isPlaceholderValue(tenantId) ? { tenantId } : {}),
      }),
    [apiUrl, tenantId],
  );

  // Stabilize the auth prop so the inner <StewardProvider> doesn't recreate its
  // StewardAuth instance on every render (which would thrash auth state).
  const authConfig = useMemo(() => ({ baseUrl: apiUrl }), [apiUrl]);

  useEffect(() => {
    if (
      playwrightTestAuthEnabled ||
      typeof window === "undefined" ||
      hasValidUrl ||
      hasLoggedConfigError.current
    ) {
      return;
    }
    hasLoggedConfigError.current = true;
    console.error(
      "Steward API URL is invalid; Steward auth will not function.",
    );
  }, [hasValidUrl, playwrightTestAuthEnabled]);

  if (playwrightTestAuthEnabled) {
    return <>{children}</>;
  }

  if (!hasValidUrl) {
    return <>{children}</>;
  }

  return (
    <StewardProvider
      client={client}
      agentId="eliza-cloud"
      auth={authConfig}
      tenantId={
        tenantId && !isPlaceholderValue(tenantId) ? tenantId : undefined
      }
    >
      <AuthTokenSync>{children}</AuthTokenSync>
    </StewardProvider>
  );
}
