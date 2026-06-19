/**
 * Steward authentication provider for the app-hosted Eliza Cloud surfaces.
 *
 * Ported from `@elizaos/cloud-frontend/src/providers/StewardProvider.tsx`
 * (web-build-only). Wraps the cloud routes in Steward auth context and syncs
 * the JWT to a server cookie so same-origin Hono/API routes can read it. The
 * heavy `@stwd/sdk` / `@stwd/react` runtime lives in a lazy chunk
 * ({@link StewardProviderRuntime}) loaded only when a token is present or the
 * current route is an auth/dashboard/payment surface.
 *
 * Auth model (DECISIONS.md D3): Cloud = Steward, unified across web and native.
 * On hosted web (same-origin apex) Steward rides the cookie + localStorage-JWT
 * path; the localStorage Bearer path also works for native cloud connections.
 */

import {
  clearStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
} from "react";
import { useLocation } from "react-router-dom";
import { decodeJwtPayload } from "../lib/jwt";
import { resolveBrowserStewardApiUrl } from "./steward-url";

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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Vite production builds replace `import.meta.env` with a literal containing
 * only the standard fields. Custom `VITE_*` vars are inlined only when read via
 * the literal property name — a dynamic `env[name]` lookup silently returns
 * `undefined` in prod. Read each env var by its literal name below.
 */
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
    email?: string | null;
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

function configuredApiBase(): string | undefined {
  return (
    import.meta.env?.VITE_API_URL ||
    import.meta.env?.NEXT_PUBLIC_API_URL ||
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_API_URL
      : undefined)
  );
}

export function configuredSessionEndpoint(): string {
  const apiBase = configuredApiBase();
  // Reject localhost API bases when running in a browser pointed at a known
  // Eliza Cloud host so a leaked dev URL can't POST to localhost (blocked by
  // CSP); fall through to the same-origin / direct api.elizacloud.ai path.
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_SESSION_ENDPOINT}`;
    }
  }
  if (isBrowserOnElizaHost()) {
    return ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT;
  }
  return STEWARD_SESSION_ENDPOINT;
}

export function configuredRefreshEndpoint(): string {
  const apiBase = configuredApiBase();
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
  const payload = decodeJwtPayload(token);
  // A token we can't read is treated as expired; a readable token without an
  // `exp` claim never expires locally.
  if (!payload) return true;
  if (!payload.exp) return false;
  return payload.exp * 1000 < Date.now();
}

export function tokenSecsRemaining(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return null;
  return payload.exp - Date.now() / 1000;
}

/**
 * Wipe every trace of an in-browser Steward session — used when the server has
 * rejected a token that locally still looks valid. Best-effort; dispatches
 * `steward-token-sync` so listeners recompute auth state.
 */
export function clearStaleStewardSession(): void {
  if (typeof window === "undefined") return;
  clearStoredStewardToken();
  clearServerStewardSessionCookies();
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
  /^\/auth(?:\/|$)/,
  /^\/bsc(?:\/|$)/,
  /^\/dashboard(?:\/|$)/,
  /^\/login(?:\/|$)/,
  /^\/invite(?:\/|$)/,
  /^\/accept-invitation(?:\/|$)/,
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

/**
 * Outer Steward provider. Cheap on routes that don't need auth (no token, not
 * an auth surface) — it renders children directly without loading the heavy
 * `@stwd/*` runtime chunk. Loads the runtime lazily otherwise.
 */
export function StewardAuthProvider({ children }: { children: ReactNode }) {
  const hasLoggedConfigError = useRef(false);
  const location = useLocation();
  const playwrightTestAuthEnabled = isPlaywrightTestAuthEnabled();

  const apiUrl = resolveBrowserStewardApiUrl();
  const tenantId =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_STEWARD_TENANT_ID
      : undefined;
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
