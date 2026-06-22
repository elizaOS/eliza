"use client";

import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";
import { lazy, Suspense, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { isPlaceholderValue, readStoredToken } from "./StewardProviderShared";

export {
  clearServerStewardSessionCookies,
  clearStaleStewardSession,
  configuredRefreshEndpoint,
  configuredSessionEndpoint,
  isPlaceholderValue,
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
  readStoredToken,
  tokenIsExpired,
  tokenSecsRemaining,
} from "./StewardProviderShared";

/**
 * Steward authentication provider for Eliza Cloud.
 *
 * Wraps children in Steward auth context, syncs JWT tokens to a global API client, and validates env config on mount.
 *
 * Defaults to the same-origin /steward mount; NEXT_PUBLIC_STEWARD_API_URL is only an override.
 * Optional: NEXT_PUBLIC_STEWARD_TENANT_ID for multi-tenant setups.
 */

/**
 * IMPORTANT: Vite production builds replace `import.meta.env` with a literal
 * containing only the 5 standard fields (BASE_URL/DEV/MODE/PROD/SSR). Custom
 * `VITE_*` vars are inlined only when read via the literal property name
 * (`import.meta.env.VITE_FOO`). A dynamic `env[name]` lookup silently
 * returns `undefined` in prod — which breaks both the Playwright auth bypass
 * AND the runtime Steward API URL resolution. Read each env var by its
 * literal name below.
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

/**
 * Inner wrapper that syncs the Steward JWT to a global API client
 * so authenticated requests outside React components work correctly.
 */
const StewardAuthRuntimeProvider = lazy(
  () => import("./StewardProviderRuntime"),
);

const STEWARD_RUNTIME_ROUTE_PATTERNS = [
  /^\/app-auth(?:\/|$)/,
  /^\/auth\/callback\/email(?:\/|$)/,
  /^\/auth\/cli-login(?:\/|$)/,
  /^\/bsc(?:\/|$)/,
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
