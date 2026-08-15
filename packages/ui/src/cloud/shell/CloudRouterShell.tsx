/**
 * Top-level react-router shell for the Eliza web app (web build only).
 *
 * This is the single `<BrowserRouter>` that owns the *non-app* routes — the
 * in-app Cloud management, public marketing, Steward auth, and token-gated payment /
 * approval pages — and renders the existing tab/view `App` as the catch-all
 * `/*`. The tab/view app's `window.location → tab` behavior is preserved
 * untouched under the catch-all; this shell only adds the parametric routes the
 * backend issues (which a flat tab enum cannot express) and retired
 * `/dashboard/*` compatibility redirects.
 *
 * Route table: every cloud / public / auth / payment route is registered by
 * its domain module via `registerCloudRoute(...)` against the
 * {@link CloudRouteDef} registry; this shell mounts whatever
 * {@link listCloudRoutes} returns and 404s gracefully otherwise.
 *
 * Build-target gating: this module and its Steward / cloud-i18n / query
 * providers are web-build-only. Native (Capacitor) mounts the tab/view App
 * directly with no bundle growth — see `packages/app/src/main.tsx`.
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  elizaCloudEnvironmentForHostname,
} from "@elizaos/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useSyncExternalStore,
} from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { isAppModeHost } from "../app-mode/app-mode";
import { queryClient } from "../lib/query-client";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  ensurePrivateCloudSurfaces,
  getPrivateCloudRegistrationSnapshot,
  pathNeedsPrivateCloudSurfaces,
  retryPrivateCloudSurfaces,
  subscribePrivateCloudRegistration,
} from "../private-cloud-registration";
import { isApexControlPlaneHost } from "./apex-host";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "./CloudI18nProvider";
import { CloudRouteErrorBoundary } from "./CloudRouteErrorBoundary";
import {
  type CloudRouteDef,
  getCloudRouteGate,
  getCloudRouteRegistryVersion,
  listCloudRoutes,
  subscribeCloudRoutes,
} from "./cloud-route-registry";
import { StewardAuthProvider } from "./StewardProvider";

/**
 * Retired `/dashboard/*` redirect map. Cloud management now lives at
 * `/cloud/*` inside the normal Eliza app shell; these entries normalize older
 * route spellings while preserving parameters and query strings.
 */
export const LEGACY_DASHBOARD_REDIRECTS: ReadonlyArray<{
  from: string;
  to: string;
}> = [
  { from: "dashboard", to: "/cloud" },
  // Legacy build/* surface → agents.
  { from: "dashboard/build/*", to: "/cloud/my-agents" },
  // Media generators were folded into the API explorer.
  { from: "dashboard/image", to: "/cloud/api-explorer" },
  { from: "dashboard/video", to: "/cloud/api-explorer" },
  { from: "dashboard/gallery", to: "/cloud/api-explorer" },
  { from: "dashboard/voices", to: "/cloud/api-explorer" },
  // Containers were unified under agents.
  { from: "dashboard/containers", to: "/cloud/agents" },
  { from: "dashboard/containers/:id", to: "/cloud/agents/:id" },
  { from: "dashboard/containers/agents/:id", to: "/cloud/agents/:id" },
  // Real chat lives in the app, not the dashboard; old chat deep links
  // redirect back to the agent detail page.
  { from: "dashboard/agents/:id/chat", to: "/cloud/agents/:id" },
  // App-create modal is opened from the apps list, not its own route.
  { from: "dashboard/apps/create", to: "/cloud/apps" },
  // Earnings + Affiliates merged into the tabbed Monetization console page.
  { from: "dashboard/earnings", to: "/cloud/monetization" },
  { from: "dashboard/affiliates", to: "/cloud/monetization" },
  // Knowledge/Documents now lives in the app; old deep links land on the agents list.
  { from: "dashboard/documents", to: "/cloud/agents" },
];

/** Retired `/cloud/*` aliases emitted by older clients and saved bookmarks. */
export const CLOUD_MANAGEMENT_COMPAT_REDIRECTS: ReadonlyArray<{
  from: string;
  to: string;
}> = [
  { from: "cloud/earnings", to: "/cloud/monetization" },
  { from: "cloud/affiliates", to: "/cloud/monetization" },
];

/**
 * Substitute `:param` segments from the matched route params, preserve the
 * query string, and keep any `#hash` on the target after the query (a naive
 * `to + search` concatenation would swallow the query into the hash).
 */
function ParamRedirect({ to }: { to: string }): React.JSX.Element {
  const location = useLocation();
  const params = useParams();
  const resolved = to.replace(/:([a-zA-Z]+)/g, (_, key) => params[key] ?? "");
  const [path, hash] = resolved.split("#");
  return (
    <Navigate
      to={`${path}${location.search}${hash ? `#${hash}` : ""}`}
      replace
    />
  );
}

/**
 * Settings-tab URLs issued by older OAuth and billing flows map onto their
 * canonical managed Cloud pages. Unknown/absent tabs land on Cloud home.
 */
const LEGACY_SETTINGS_TAB_TARGETS: Readonly<Record<string, string>> = {
  connections: "/cloud/connectors",
  billing: "/cloud/billing",
  organization: "/cloud/organization",
  agents: "/cloud/agents",
};

function LegacySettingsTabRedirect(): React.JSX.Element {
  const location = useLocation();
  const target = resolveLegacyCloudSettingsTarget(location.search);
  return <Navigate to={`${target}${location.search}`} replace />;
}

export function resolveLegacyCloudSettingsTarget(search: string): string {
  const tab = new URLSearchParams(search).get("tab") ?? "";
  return LEGACY_SETTINGS_TAB_TARGETS[tab] ?? "/cloud";
}

function renderRouteElement(route: CloudRouteDef): React.JSX.Element {
  const RouteComponent = route.element as ComponentType<unknown>;
  return (
    // The boundary sits INSIDE the console chrome / auth providers so a route
    // crash (or a post-deploy stale lazy chunk — see CloudRouteErrorBoundary)
    // degrades in the page slot instead of escaping to the app-root boundary
    // and blanking the whole console.
    <CloudRouteErrorBoundary routePath={route.path}>
      <Suspense fallback={<RouteChunkFallback />}>
        <RouteComponent />
      </Suspense>
    </CloudRouteErrorBoundary>
  );
}

/** Fail-closed denial when a route declares a gate with no registered impl. */
function RouteGateUnavailable(): React.JSX.Element {
  return (
    <div className="theme-cloud min-h-dvh bg-black text-white">
      <div className="mx-auto max-w-prose p-8 text-sm text-white/62">
        <h1 className="mb-3 text-lg font-semibold text-white">
          Access unavailable
        </h1>
        <p>This area could not be authorized.</p>
      </div>
    </div>
  );
}

/**
 * Apply a route's declared `gate` (#12087 Item 23). The shell — not each route
 * body — enforces authorization: a route declaring `gate: "admin"` is wrapped in
 * the registered `AdminGate` even if its own body forgot to. An unknown gate
 * name fails closed (renders a denial, never the body).
 */
export function applyRouteGate(
  gate: string | undefined,
  body: ReactNode,
): ReactNode {
  if (!gate) return body;
  const Gate = getCloudRouteGate(gate);
  if (!Gate) return <RouteGateUnavailable />;
  return <Gate>{body}</Gate>;
}

/**
 * Transparent in-flight fallback for a lazy route chunk. Cloud pages supply
 * their own richer skeletons; this just fills the slot for the cold-load gap.
 */
function RouteChunkFallback(): React.JSX.Element {
  return <div aria-busy="true" className="min-h-[40vh]" />;
}

function PrivateCloudUnavailable({
  onRetry,
}: {
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="theme-cloud min-h-dvh bg-black text-white">
      <div className="mx-auto max-w-prose p-8 text-sm text-white/62">
        <h1 className="mb-3 text-lg font-semibold text-white">
          Console unavailable
        </h1>
        <p className="mb-4">
          Dashboard surfaces could not be loaded. Check your connection and try
          again.
        </p>
        <button
          type="button"
          className="rounded-md border border-white/20 px-3 py-1.5 text-white hover:bg-white/10"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * Starts private domain registration only when the active location needs
 * dashboard/console surfaces (#18056). Idle `/login` must not call this.
 */
function PrivateCloudRegistrationCoordinator(): null {
  const location = useLocation();
  useEffect(() => {
    if (pathNeedsPrivateCloudSurfaces(location.pathname)) {
      void ensurePrivateCloudSurfaces();
    }
  }, [location.pathname]);
  return null;
}

/**
 * Loads private Cloud domains (dashboard routes + in-app Cloud settings
 * sections) when the tab/view App catch-all mounts. Without this, settings
 * registration only ran after a `dashboard/*` visit, so Cloud settings groups
 * were missing on the public web shell (shipwright #18441). Public auth routes
 * like `/login` never mount this wrapper.
 */
function EnsurePrivateCloudSurfacesOnMount({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    void ensurePrivateCloudSurfaces();
  }, []);
  return <>{children}</>;
}

/**
 * `/cloud/*` bootstrap: pending private load, designed failure/retry, then the
 * normal app shell once the Cloud page and route table are registered.
 */
function PrivateCloudAppRoute({
  appElement,
}: {
  appElement: ReactNode;
}): React.JSX.Element {
  const snapshot = useSyncExternalStore(
    subscribePrivateCloudRegistration,
    getPrivateCloudRegistrationSnapshot,
    getPrivateCloudRegistrationSnapshot,
  );

  useEffect(() => {
    if (snapshot.status === "idle") {
      void ensurePrivateCloudSurfaces();
    }
  }, [snapshot.status]);

  if (snapshot.status === "idle" || snapshot.status === "pending") {
    return <RouteChunkFallback />;
  }
  if (snapshot.status === "error") {
    return (
      <PrivateCloudUnavailable
        onRetry={() => {
          void retryPrivateCloudSurfaces();
        }}
      />
    );
  }
  return <AppCatchAllRoute appElement={appElement} />;
}

/** Preserve any retired dashboard deep link not covered by a narrower map. */
function LegacyDashboardFallbackRedirect(): React.JSX.Element {
  const location = useLocation();
  const params = useParams();
  const suffix = params["*"] ? `/${params["*"]}` : "";
  return (
    <Navigate
      to={`/cloud${suffix}${location.search}${location.hash}`}
      replace
    />
  );
}

/**
 * Cloud-side providers shared by every registered cloud / auth / payment route.
 * The tab/view App (catch-all) brings its own `AppProvider`, so these never
 * wrap it. Public (token-gated) routes still get query + i18n but are exempt
 * from Steward auth at the route level (see {@link CloudRouteElement}).
 */
function CloudProviders({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <CloudI18nProvider initialLang={resolveInitialCloudLang()}>
        {children}
      </CloudI18nProvider>
    </QueryClientProvider>
  );
}

/** Route groups consolidated into the normal Eliza agent-app shell. */
const MANAGED_CLOUD_APP_GROUPS = new Set(["cloud", "admin"]);

function CanonicalCloudAppRedirect(): React.JSX.Element {
  const location = useLocation();
  const environment = elizaCloudEnvironmentForHostname(
    window.location.hostname,
  );
  const destination = `${ELIZA_DOMAIN_CONTRACTS[environment ?? "production"].cloudAppOrigin}${location.pathname}${location.search}${location.hash}`;
  useEffect(() => {
    window.location.replace(destination);
  }, [destination]);
  return <RouteChunkFallback />;
}

/**
 * Render a single registered cloud route. Authenticated routes are wrapped in
 * the Steward auth provider (which itself lazy-loads the heavy `@stwd/*` runtime
 * only when needed); Cloud-management routes render through the normal Eliza
 * app shell; public token routes
 * (payment / approve / ballot / sensitive / shared chat) render WITHOUT
 * app-shell chrome and WITHOUT Steward.
 */
function CloudRouteElement({
  route,
  appElement,
}: {
  route: CloudRouteDef;
  appElement: ReactNode;
}): React.JSX.Element {
  if (route.public) {
    return <>{applyRouteGate(route.gate, renderRouteElement(route))}</>;
  }
  if (route.group && MANAGED_CLOUD_APP_GROUPS.has(route.group)) {
    if (isApexControlPlaneHost()) return <CanonicalCloudAppRedirect />;
    return (
      <StewardAuthProvider>
        <AppCatchAllRoute appElement={appElement} />
      </StewardAuthProvider>
    );
  }
  const body = applyRouteGate(route.gate, renderRouteElement(route));
  return (
    <StewardAuthProvider>
      <div className="theme-cloud min-h-dvh bg-black text-white">{body}</div>
    </StewardAuthProvider>
  );
}

export interface CloudRouterShellProps {
  /**
   * The existing tab/view app subtree (`<App/>` plus any host runtimes the
   * shell must not know about — desktop nav/tray, etc.). Rendered unchanged
   * under the catch-all `/*` route. The host owns its `AppProvider`.
   */
  appElement: ReactNode;
  /** Approved public homepage rendered only on the canonical/legacy marketing hosts. */
  marketingHomeElement?: ReactNode;
  /** Public downloads page rendered only on the canonical/legacy marketing hosts. */
  downloadsElement?: ReactNode;
}

function MarketingDownloadsRoute({
  downloadsElement,
}: {
  downloadsElement: ReactNode;
}): React.JSX.Element {
  const isMarketingHost = isApexControlPlaneHost();
  const environment = elizaCloudEnvironmentForHostname(
    window.location.hostname,
  );
  const destination = `${ELIZA_DOMAIN_CONTRACTS[environment ?? "production"].marketingOrigin}/downloads`;
  useEffect(() => {
    if (!isMarketingHost) window.location.replace(destination);
  }, [destination, isMarketingHost]);
  if (isMarketingHost) return <>{downloadsElement}</>;
  return <RouteChunkFallback />;
}

/**
 * Where an authenticated visitor landing on a marketing host is sent. The
 * management-route boundary forwards this path to the canonical managed Cloud
 * app, where it renders inside the normal Eliza agent shell.
 */
const APEX_AUTHENTICATED_HOME = "/cloud";

/**
 * Catch-all element. Renders the agent app exactly as before, except on a
 * public marketing host, where the agent app must never boot: that host has
 * no same-origin agent backend, so the app's boot sequence 404-storms on
 * `/api/*` and the failed `/api/first-run/status` probe throws the first-run
 * onboarding chooser over the public site. On a marketing host every path that falls
 * through to this catch-all is an agent-app path by definition — all console
 * surfaces are registered routes and match before it — so:
 *
 *  - unauthenticated → the Steward `/login` page (`returnTo` preserved).
 *  - authenticated → the Cloud handoff ({@link APEX_AUTHENTICATED_HOME}),
 *    whatever the path: `/`, `/settings`, `/chat`, or any other app-only URL
 *    would otherwise boot the backendless app.
 *  - auth state not yet readable → a blank fallback, never the app; rendering
 *    the app while auth resolves lets its tab system rewrite the URL and
 *    strand the visitor before the redirect can fire.
 *
 * On canonical managed app hosts (checked after the marketing branch), the
 * catch-all renders the
 * app-mode entry gate instead: signed-in visitors land in the same-origin
 * chat app (the chat floor — see `../app-mode/AppModeEntryRoute`; entry never
 * pairing-redirects into a per-agent web UI), and an org with no agents at
 * all is sent to the `/join` deploy-first-agent flow. The gate chunk is lazy
 * so no app-mode code loads on any other host.
 *
 * Every other host (per-agent subdomains, localhost) is untouched: chat stays
 * home.
 */
export function AppCatchAllRoute({
  appElement,
}: {
  appElement: ReactNode;
}): React.JSX.Element {
  const { ready, authenticated } = useSessionAuth();
  const location = useLocation();
  if (isApexControlPlaneHost()) {
    if (!ready) {
      return <RouteChunkFallback />;
    }
    if (!authenticated) {
      const returnTo = encodeURIComponent(
        `${location.pathname}${location.search}`,
      );
      return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
    }
    return <Navigate to={APEX_AUTHENTICATED_HOME} replace />;
  }
  if (isAppModeHost()) {
    return (
      <Suspense fallback={<RouteChunkFallback />}>
        <AppModeEntryRoute
          appElement={
            <EnsurePrivateCloudSurfacesOnMount>
              {appElement}
            </EnsurePrivateCloudSurfacesOnMount>
          }
        />
      </Suspense>
    );
  }
  return (
    <EnsurePrivateCloudSurfacesOnMount>
      {appElement}
    </EnsurePrivateCloudSurfacesOnMount>
  );
}

/** App-mode entry gate, loaded only on the Eliza app hosts (see
 * {@link AppCatchAllRoute}); apex + per-agent hosts never fetch this chunk. */
const AppModeEntryRoute = lazy(() => import("../app-mode/AppModeEntryRoute"));

/**
 * The shell. Mounts the registered Cloud routes + retired `/dashboard/*`
 * redirects,
 * redirects, and renders {@link CloudRouterShellProps.appElement} for every
 * other path so chat stays home and the tab system is untouched.
 */
export function CloudRouterShell({
  appElement,
  marketingHomeElement,
  downloadsElement,
}: CloudRouterShellProps): React.JSX.Element {
  // Re-render when private domains finish dynamic registration so newly
  // registered dashboard routes replace the catch-all (#18056).
  useSyncExternalStore(
    subscribeCloudRoutes,
    getCloudRouteRegistryVersion,
    getCloudRouteRegistryVersion,
  );
  const cloudRoutes = listCloudRoutes();
  const marketingHost = isApexControlPlaneHost();
  return (
    <BrowserRouter>
      {/*
       * CloudProviders (query + cloud-i18n) wrap the whole route tree so cloud
       * route components share one QueryClient + language context without
       * remounting on navigation. The catch-all app brings its own AppProvider
       * and never reads these, so wrapping it is a harmless no-op. Steward auth
       * is applied per-route (CloudRouteElement) so the app catch-all and public
       * token routes never load the @stwd/* runtime.
       */}
      <CloudProviders>
        <PrivateCloudRegistrationCoordinator />
        <Routes>
          {/* The marketing homepage owns `/` ONLY on a marketing host. Every
              other host must leave `/` to the catch-all route below: giving it
              a dedicated <Route> makes react-router swap route elements when
              the app navigates `/` -> `/chat`, which REMOUNTS the whole app
              subtree and re-reads mount-time URL state (`?shellMode=`), so
              `?shellMode=voice-selftest|voice-workbench|kiosk|...` surfaces
              were torn down moments after mounting. */}
          {marketingHomeElement && marketingHost ? (
            <Route path="/" element={marketingHomeElement} />
          ) : null}

          {downloadsElement ? (
            <Route
              path="/downloads"
              element={
                <MarketingDownloadsRoute downloadsElement={downloadsElement} />
              }
            />
          ) : null}

          {cloudRoutes.map((route) => (
            <Route
              key={route.path}
              path={route.path}
              element={
                <CloudRouteElement route={route} appElement={appElement} />
              }
            />
          ))}

          {LEGACY_DASHBOARD_REDIRECTS.map(({ from, to }) => (
            <Route key={from} path={from} element={<ParamRedirect to={to} />} />
          ))}

          {CLOUD_MANAGEMENT_COMPAT_REDIRECTS.map(({ from, to }) => (
            <Route key={from} path={from} element={<ParamRedirect to={to} />} />
          ))}

          {/* Old OAuth/Stripe callbacks can still carry the retired
              /dashboard/settings?tab=<x> shape. */}
          <Route
            path="dashboard/settings"
            element={<LegacySettingsTabRedirect />}
          />

          <Route
            path="cloud/settings"
            element={<LegacySettingsTabRedirect />}
          />

          <Route
            path="dashboard/*"
            element={<LegacyDashboardFallbackRedirect />}
          />

          {/* A cold direct /cloud/* load must finish registering the lazy
              app-shell page before the tab router resolves the path. */}
          <Route
            path="cloud/*"
            element={<PrivateCloudAppRoute appElement={appElement} />}
          />

          {/* Catch-all: the existing tab/view app (chat is home) — except on
              apex control-plane hosts, where the agent app never boots:
              unauthenticated → /login, authenticated → the console home.
              See AppCatchAllRoute. */}
          <Route
            path="*"
            element={<AppCatchAllRoute appElement={appElement} />}
          />
        </Routes>
      </CloudProviders>
    </BrowserRouter>
  );
}

export default CloudRouterShell;
