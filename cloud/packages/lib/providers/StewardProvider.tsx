"use client";

import { StewardProvider, useAuth as useStewardAuth } from "@stwd/react";
import { StewardAuth, StewardClient } from "@stwd/sdk";
import { createContext, useEffect, useMemo, useRef } from "react";
import { resolveBrowserStewardApiUrl } from "@/lib/steward-url";

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

type ImportMetaEnvLike = {
  env?: Record<string, string | undefined>;
};

function hasViteEnv(meta: ImportMeta): meta is ImportMeta & ImportMetaEnvLike {
  const env = (meta as ImportMetaEnvLike).env;
  return typeof env === "object" && env !== null;
}

function getViteEnvValue(name: string): string | undefined {
  return hasViteEnv(import.meta) ? import.meta.env?.[name] : undefined;
}

function getViteEnvFlag(name: string): string | undefined {
  return getViteEnvValue(name);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isPlaywrightTestAuthEnabled(): boolean {
  return (
    getViteEnvFlag("VITE_PLAYWRIGHT_TEST_AUTH") === "true" ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true")
  );
}

/**
 * Inner wrapper that syncs the Steward JWT to a global API client
 * so authenticated requests outside React components work correctly.
 */
const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_REFRESH_TOKEN_KEY = "steward_refresh_token";
const STEWARD_SESSION_ENDPOINT = "/api/auth/steward-session";
const ELIZA_CLOUD_COOKIE_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);
const ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT = "https://api.elizacloud.ai/api/auth/steward-session";

export const LocalStewardAuthContext = createContext<ReturnType<typeof useStewardAuth> | null>(
  null,
);

function isLocalhostApiBase(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(value.trim());
}

function configuredSessionEndpoint(): string {
  const apiBase =
    getViteEnvValue("VITE_API_URL") ||
    getViteEnvValue("NEXT_PUBLIC_API_URL") ||
    process.env.NEXT_PUBLIC_API_URL;
  // Reject localhost API bases when running in a browser pointed at a known
  // Eliza Cloud host. A build that leaked the dev URL into the production
  // bundle would otherwise POST to http://localhost:3000 and the browser CSP
  // blocks it; fall through to the same-origin / direct api.elizacloud.ai path.
  if (apiBase && !isPlaceholderValue(apiBase)) {
    const browserOnElizaHost =
      typeof window !== "undefined" &&
      ELIZA_CLOUD_COOKIE_HOSTS.has(window.location.hostname.toLowerCase());
    if (!(browserOnElizaHost && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_SESSION_ENDPOINT}`;
    }
  }
  // No apiBase (or it was localhost on a real host): prefer the direct
  // api.elizacloud.ai URL when on a known Eliza Cloud host so the call
  // does not depend on the Pages Functions `/api/*` proxy being live.
  if (
    typeof window !== "undefined" &&
    ELIZA_CLOUD_COOKIE_HOSTS.has(window.location.hostname.toLowerCase())
  ) {
    return ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT;
  }
  return STEWARD_SESSION_ENDPOINT;
}

function stewardSessionClearUrls(): string[] {
  if (typeof window === "undefined") return [configuredSessionEndpoint()];
  const urls = new Set([STEWARD_SESSION_ENDPOINT, configuredSessionEndpoint()]);
  const host = window.location.hostname.toLowerCase();
  if (ELIZA_CLOUD_COOKIE_HOSTS.has(host)) {
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

function readStoredRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STEWARD_REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function tokenIsExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
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
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
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
  try {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    localStorage.removeItem(STEWARD_REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
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
  const lastSyncedRefreshToken = useRef<string | null>(null);
  const wasAuthenticated = useRef(false);
  const authInstanceRef = useRef<InstanceType<typeof StewardAuth> | null>(null);

  const apiUrl = resolveBrowserStewardApiUrl();
  const tenantId = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID;

  // Create a standalone StewardAuth for refresh purposes (uses localStorage)
  useEffect(() => {
    if (typeof window === "undefined") return;
    authInstanceRef.current = new StewardAuth({
      baseUrl: apiUrl,
      ...(tenantId ? { tenantId } : {}),
    });
  }, [apiUrl, tenantId]);

  // Sync localStorage token → cookie and keep it alive via auto-refresh
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run trigger
  useEffect(() => {
    const syncToken = () => {
      const token = readStoredToken();
      const refreshToken = readStoredRefreshToken();
      if (!token) {
        // No token at all — clear the server cookie if we had one
        if (wasAuthenticated.current && lastSyncedToken.current) {
          lastSyncedToken.current = null;
          lastSyncedRefreshToken.current = null;
          wasAuthenticated.current = false;
          clearServerStewardSessionCookies();
        }
        return;
      }

      // If the token is expired, don't push it to the server (the server would
      // reject it anyway), but don't delete the cookie either — the refresh
      // path may recover. Only explicit sign-out clears cookies.
      if (tokenIsExpired(token)) return;

      if (token === lastSyncedToken.current && refreshToken === lastSyncedRefreshToken.current) {
        return;
      }
      lastSyncedToken.current = token;
      lastSyncedRefreshToken.current = refreshToken;
      wasAuthenticated.current = true;

      fetch(configuredSessionEndpoint(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, refreshToken }),
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
          console.warn("[steward] Stored token rejected by server (401) — clearing");
          lastSyncedToken.current = null;
          lastSyncedRefreshToken.current = null;
          wasAuthenticated.current = false;
          clearStaleStewardSession();
        })
        .catch((err) => console.warn("[steward] Failed to set session cookie", err));
    };

    const checkAndRefresh = async () => {
      const token = readStoredToken();
      if (!token) return;

      const secs = tokenSecsRemaining(token);

      // Refresh eagerly when the token is within the lookahead window OR
      // already expired (e.g. tab was idle longer than 15 min). Dropping
      // the `secs > 0` guard is the key fix for the silent-logout bug:
      // previously, once the access token expired we stopped trying to
      // refresh even though the refresh token was still good.
      if (secs !== null && secs >= REFRESH_AHEAD_SECS) return;

      const auth = authInstanceRef.current;
      if (!auth) return;

      try {
        const newSession = await auth.refreshSession();
        if (newSession) {
          // refreshSession already updated localStorage, now sync the new token to cookie
          syncToken();
        } else if (secs !== null && secs <= 0) {
          // Refresh returned null AND the access token is truly expired —
          // now it's safe to clear the server cookie; the user is logged out.
          if (wasAuthenticated.current && lastSyncedToken.current) {
            lastSyncedToken.current = null;
            lastSyncedRefreshToken.current = null;
            wasAuthenticated.current = false;
            clearServerStewardSessionCookies();
          }
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
    <LocalStewardAuthContext.Provider value={auth}>{children}</LocalStewardAuthContext.Provider>
  );
}

export function StewardAuthProvider({ children }: { children: React.ReactNode }) {
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
    console.error("Steward API URL is invalid; Steward auth will not function.");
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
      tenantId={tenantId && !isPlaceholderValue(tenantId) ? tenantId : undefined}
    >
      <AuthTokenSync>{children}</AuthTokenSync>
    </StewardProvider>
  );
}
