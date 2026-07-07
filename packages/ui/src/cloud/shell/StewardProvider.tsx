/**
 * Steward authentication provider for the app-hosted Eliza Cloud surfaces.
 * Wraps the cloud routes in Steward auth context and syncs the JWT to a server
 * cookie so same-origin Hono/API routes can read it. The
 * heavy `@stwd/sdk` / `@stwd/react` runtime lives in a lazy chunk
 * ({@link StewardProviderRuntime}) loaded only when a token is present or the
 * current route is an auth/dashboard/payment surface.
 *
 * Auth model: Cloud = Steward, unified across web and native.
 * On hosted web (same-origin apex) Steward rides the cookie + localStorage-JWT
 * path; the localStorage Bearer path also works for native cloud connections.
 */

import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { isPlaceholderValue, readStoredToken } from "./StewardProviderShared";
import {
  configuredStewardTenantId,
  DEFAULT_STEWARD_TENANT_ID,
} from "./steward-config";
import { resolveBrowserStewardApiUrl } from "./steward-url";

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
 * Suspense fallback for the lazy `@stwd/*` runtime chunk. It must NOT render the
 * page children: reaching this branch means `needsStewardRuntime` is true, so the
 * children depend on Steward auth context (e.g. `AuthorizeContent` calls
 * `useAuth()`). Rendering them before `StewardProvider` is in the tree throws
 * "useAuth must be used within a <StewardProvider>" (#10680). Show a neutral
 * loading state until the runtime resolves, then the real tree renders.
 */
function StewardRuntimeLoading() {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      role="status"
      style={{
        // Pre-theme fallback (renders before the theme tree mounts, so it uses
        // literals not vars): black to match the console, not the old beige that
        // flashed light-on-black and read as a broken load.
        alignItems: "center",
        background: "#000",
        color: "rgba(255,255,255,0.55)",
        display: "flex",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "24px",
      }}
    >
      <span style={{ fontSize: 16 }}>Loading…</span>
    </main>
  );
}

function StewardConfigError() {
  return (
    <main
      aria-labelledby="steward-config-error-title"
      role="alert"
      style={{
        alignItems: "center",
        background: "#f8f4ef",
        color: "#2f261f",
        display: "flex",
        minHeight: "100vh",
        padding: "24px",
      }}
    >
      <section
        style={{
          border: "1px solid #d8c7b8",
          borderRadius: 8,
          margin: "0 auto",
          maxWidth: 560,
          padding: "24px",
        }}
      >
        <h1
          id="steward-config-error-title"
          style={{
            fontSize: 24,
            lineHeight: 1.2,
            margin: "0 0 12px",
          }}
        >
          Sign-in temporarily unavailable
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.5, margin: 0 }}>
          Eliza Cloud authentication is not configured for this environment. Set
          a valid Steward API URL and reload this page.
        </p>
      </section>
    </main>
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
  const tenantId = configuredStewardTenantId(DEFAULT_STEWARD_TENANT_ID);
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

  const needsStewardRuntime = shouldLoadStewardRuntime(location.pathname);

  if (!needsStewardRuntime) {
    return <>{children}</>;
  }

  if (!hasValidUrl) {
    return <StewardConfigError />;
  }

  return (
    <Suspense fallback={<StewardRuntimeLoading />}>
      <StewardAuthRuntimeProvider apiUrl={apiUrl} tenantId={tenantId}>
        {children}
      </StewardAuthRuntimeProvider>
    </Suspense>
  );
}
