"use client";

import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";
import {
  clearStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { createContext, lazy, Suspense, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Steward authentication provider for Eliza Cloud.
 *
 * Wraps children in Steward auth context, syncs JWT tokens to a global API client, and validates env config on mount.
 *
 * Defaults to the same-origin /steward mount; NEXT_PUBLIC_STEWARD_API_URL is only an override.
 * Optional: NEXT_PUBLIC_STEWARD_TENANT_ID for multi-tenant setups.
 */

export function isPlaceholderValue(value: string | undefined): boolean {
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

export type LocalStewardAuthValue = {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: {
    id: string;
    email?: string;
    walletAddress?: string;
    wallet_address?: string;
  } | null;
  session: unknown;
  signOut: () => unknown;
  getToken: () => unknown;
  verifyEmailCallback: (
    token: string,
    email: string,
  ) => Promise<{ token: string; refreshToken?: string }>;
};

export const LocalStewardAuthContext =
  createContext<LocalStewardAuthValue | null>(null);

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

export function configuredSessionEndpoint(): string {
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

export function configuredRefreshEndpoint(): string {
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

export function clearServerStewardSessionCookies(): void {
  for (const url of stewardSessionClearUrls()) {
    fetch(url, { method: "DELETE", credentials: "include" }).catch(() => {});
  }
}

export function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function tokenIsExpired(token: string): boolean {
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
export function tokenSecsRemaining(token: string): number | null {
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

const StewardAuthRuntimeProvider = lazy(
  () => import("./StewardProviderRuntime"),
);

const STEWARD_RUNTIME_ROUTE_PATTERNS = [
  /^\/app-auth(?:\/|$)/,
  /^\/auth\/callback\/email(?:\/|$)/,
  /^\/auth\/cli-login(?:\/|$)/,
  /^\/dashboard(?:\/|$)/,
  /^\/login(?:\/|$)/,
  /^\/payment(?:\/|$)/,
  /^\/sensitive-requests(?:\/|$)/,
  /^\/approve(?:\/|$)/,
  /^\/ballot(?:\/|$)/,
] as const;

function shouldLoadStewardRuntime(pathname: string): boolean {
  if (readStoredToken()) return true;
  return STEWARD_RUNTIME_ROUTE_PATTERNS.some((pattern) =>
    pattern.test(pathname),
  );
}

export function StewardAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const hasLoggedConfigError = useRef(false);
  const location = useLocation();
  const playwrightTestAuthEnabled = isPlaywrightTestAuthEnabled();

  const apiUrl = resolveBrowserStewardApiUrl();
  const tenantId = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID;
  const hasValidUrl = !isPlaceholderValue(apiUrl);

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

  if (!hasValidUrl || !shouldLoadStewardRuntime(location.pathname)) {
    return <>{children}</>;
  }

  return (
    <Suspense fallback={children}>
      <StewardAuthRuntimeProvider apiUrl={apiUrl} tenantId={tenantId}>
        {children}
      </StewardAuthRuntimeProvider>
    </Suspense>
  );
}
