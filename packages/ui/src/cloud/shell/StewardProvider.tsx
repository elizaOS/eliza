/**
 * Steward authentication provider for the app-hosted Eliza Cloud surfaces.
 * Wraps the cloud routes in Steward auth context and syncs the JWT to a server
 * cookie so same-origin Hono/API routes can read it. The
 * heavy `@stwd/sdk` / `@stwd/react` runtime lives in a lazy chunk
 * ({@link StewardProviderRuntime}) loaded only when a token is present or the
 * current route is an auth/Cloud/payment surface.
 *
 * Auth model: Cloud = Steward, unified across web and native.
 * On hosted web (same-origin apex) Steward rides the cookie + localStorage-JWT
 * path; the localStorage Bearer path also works for native cloud connections.
 */

import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { Card } from "../../components/ui/card";
import { reportRendererDiagnostic } from "../../utils/renderer-diagnostics";
import { CloudRouteErrorBoundary } from "./CloudRouteErrorBoundary";
import {
  clearStaleStewardSession,
  isPlaceholderValue,
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
  readStoredToken,
} from "./StewardProviderShared";
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
  /^\/cloud(?:\/|$)/,
  // Retired bookmarks redirect synchronously, but loading Steward here avoids
  // an auth-context flash if a browser reaches the bundle before the edge rule.
  /^\/dashboard(?:\/|$)/,
  /^\/login(?:\/|$)/,
  // JoinPage needs the runtime before a token is persisted so its cookie-backed
  // session can resolve, provision the account, and enter the application.
  /^\/join(?:\/|$)/,
  /^\/invite(?:\/|$)/,
  /^\/accept-invitation(?:\/|$)/,
  /^\/payment(?:\/|$)/,
  /^\/sensitive-requests(?:\/|$)/,
  /^\/approve(?:\/|$)/,
  /^\/ballot(?:\/|$)/,
] as const;

/**
 * Whether the heavy `@stwd/*` Steward runtime must mount for a route. Join
 * requires it before token persistence because session resolution precedes
 * provisioning.
 */
export function shouldLoadStewardRuntime(pathname: string): boolean {
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
    <Card
      asChild
      variant="cloudPaymentPublic"
      className="flex min-h-dvh items-center justify-center p-6"
    >
      <main aria-busy="true" aria-live="polite" role="status">
        <span className="text-base">Loading…</span>
      </main>
    </Card>
  );
}

/** Deterministic auth context for renderer-only browser tests. */
function PlaywrightStewardAuthProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const token = readStoredToken();
  const value: LocalStewardAuthValue = {
    isAuthenticated: Boolean(token),
    isLoading: false,
    user: token ? { id: "playwright-test-user" } : null,
    session: null,
    signOut: clearStaleStewardSession,
    getToken: () => token,
    verifyEmailCallback: async () => {
      if (!token) {
        throw new Error(
          "Playwright test auth requires a pre-seeded Steward token.",
        );
      }
      return { token };
    },
  };
  return (
    <LocalStewardAuthContext.Provider value={value}>
      {children}
    </LocalStewardAuthContext.Provider>
  );
}

function StewardConfigError() {
  return (
    <Card asChild variant="flatPadded" className="flex min-h-dvh items-center">
      <main aria-labelledby="steward-config-error-title" role="alert">
        <Card
          asChild
          variant="outlinedPadded"
          className="mx-auto max-w-[35rem] p-6"
        >
          <section>
            <h1
              id="steward-config-error-title"
              className="mb-3 text-2xl leading-tight"
            >
              Sign-in temporarily unavailable
            </h1>
            <p className="m-0 text-base leading-normal">
              Eliza Cloud authentication is not configured for this environment.
              Set a valid Steward API URL and reload this page.
            </p>
          </section>
        </Card>
      </main>
    </Card>
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
    reportRendererDiagnostic({
      scope: "steward.invalid-api-url",
      error: new Error("Steward API URL is invalid"),
    });
  }, [hasValidUrl, playwrightTestAuthEnabled]);

  if (playwrightTestAuthEnabled) {
    return (
      <PlaywrightStewardAuthProvider>{children}</PlaywrightStewardAuthProvider>
    );
  }

  const needsStewardRuntime = shouldLoadStewardRuntime(location.pathname);

  if (!needsStewardRuntime) {
    return <>{children}</>;
  }

  if (!hasValidUrl) {
    return <StewardConfigError />;
  }

  return (
    // The boundary sits OUTSIDE the Suspense that awaits the lazy `@stwd/*`
    // runtime chunk: after a mid-session deploy the first authenticated
    // navigation rejects this import ("Failed to fetch dynamically imported
    // module", #15383), and without a boundary here that rejection escaped to
    // the app-root ErrorBoundary — which has no chunk recovery — blanking the
    // whole console. CloudRouteErrorBoundary hands the failure to the shared
    // one-shot reload recovery so the steward chunk self-heals like every
    // registered route chunk.
    <CloudRouteErrorBoundary routePath="steward-runtime">
      <Suspense fallback={<StewardRuntimeLoading />}>
        <StewardAuthRuntimeProvider apiUrl={apiUrl} tenantId={tenantId}>
          {children}
        </StewardAuthRuntimeProvider>
      </Suspense>
    </CloudRouteErrorBoundary>
  );
}
