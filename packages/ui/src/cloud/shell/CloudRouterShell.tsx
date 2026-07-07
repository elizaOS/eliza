/**
 * Top-level react-router shell for the Eliza web app (web build only).
 *
 * This is the single `<BrowserRouter>` that owns the *non-app* routes — the
 * cloud dashboard, public marketing, Steward auth, and token-gated payment /
 * approval pages — and renders the existing tab/view `App` as the catch-all
 * `/*`. The tab/view app's `window.location → tab` behavior is preserved
 * untouched under the catch-all; this shell only adds the parametric routes the
 * backend issues (which a flat tab enum cannot express) and the `/dashboard/*`
 * compat redirects.
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

import { QueryClientProvider } from "@tanstack/react-query";
import { type ComponentType, type ReactNode, Suspense } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { queryClient } from "../lib/query-client";
import { useSessionAuth } from "../lib/use-session-auth";
import { isApexControlPlaneHost } from "./apex-host";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "./CloudI18nProvider";
import { CloudRouteErrorBoundary } from "./CloudRouteErrorBoundary";
import { ConsoleShell } from "./ConsoleShell";
import {
  type CloudRouteDef,
  getCloudRouteGate,
  listCloudRoutes,
} from "./cloud-route-registry";
import { StewardAuthProvider } from "./StewardProvider";

/**
 * `/dashboard/*` compatibility redirect map. Every console surface has a
 * standalone `dashboard/*` route (apps, agents, analytics, api-explorer,
 * admin, billing, api-keys, account, security, monetization, connectors,
 * organization — see `register-all.ts`); these redirects resolve only the
 * legacy spellings that no longer exist as routes (old bookmarks and
 * backend-issued URLs). `:param` segments are substituted from the matched
 * route params, and the original query string is preserved.
 */
export const DASHBOARD_REDIRECTS: ReadonlyArray<{ from: string; to: string }> =
  [
    // Legacy build/* surface → agents.
    { from: "dashboard/build/*", to: "/dashboard/my-agents" },
    // Media generators were folded into the API explorer.
    { from: "dashboard/image", to: "/dashboard/api-explorer" },
    { from: "dashboard/video", to: "/dashboard/api-explorer" },
    { from: "dashboard/gallery", to: "/dashboard/api-explorer" },
    { from: "dashboard/voices", to: "/dashboard/api-explorer" },
    // Containers were unified under agents.
    { from: "dashboard/containers", to: "/dashboard/agents" },
    { from: "dashboard/containers/:id", to: "/dashboard/agents/:id" },
    { from: "dashboard/containers/agents/:id", to: "/dashboard/agents/:id" },
    // Real chat lives in the app, not the dashboard; old chat deep links
    // redirect back to the agent detail page.
    { from: "dashboard/agents/:id/chat", to: "/dashboard/agents/:id" },
    // App-create modal is opened from the apps list, not its own route.
    { from: "dashboard/apps/create", to: "/dashboard/apps" },
    // Earnings + Affiliates merged into the tabbed Monetization console page.
    { from: "dashboard/earnings", to: "/dashboard/monetization" },
    { from: "dashboard/affiliates", to: "/dashboard/monetization" },
    // Knowledge/Documents now lives in the app; old deep links land on the agents list.
    { from: "dashboard/documents", to: "/dashboard/agents" },
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
 * The legacy `/dashboard/settings?tab=<x>` URLs the backend still issues
 * (OAuth-connect callbacks, Stripe cancel URLs, agent GitHub-connect returns)
 * map onto the standalone console pages — those work on every host, including
 * the apex control-plane hosts where the in-app Settings view never mounts.
 * `agents` has no settings-style console page; it lands on the Instances
 * table. Unknown/absent tabs land on the console home.
 */
const LEGACY_SETTINGS_TAB_TARGETS: Readonly<Record<string, string>> = {
  connections: "/dashboard/connectors",
  billing: "/dashboard/billing",
  organization: "/dashboard/organization",
  agents: "/dashboard/agents",
};

function LegacySettingsTabRedirect(): React.JSX.Element {
  const location = useLocation();
  const tab = new URLSearchParams(location.search).get("tab") ?? "";
  const target = LEGACY_SETTINGS_TAB_TARGETS[tab] ?? "/dashboard";
  return <Navigate to={`${target}${location.search}`} replace />;
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

function CloudNotFound(): React.JSX.Element {
  return (
    <div className="theme-cloud min-h-dvh bg-black text-white">
      <div className="mx-auto max-w-prose p-8 text-sm text-white/62">
        <h1 className="mb-3 text-lg font-semibold text-white">Not found</h1>
        <p>The page you requested doesn&apos;t exist.</p>
      </div>
    </div>
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

/** Route groups that render inside the console chrome (left sidebar + top
 * bar). Everything console-shaped is one of these; auth/payment/public token
 * routes stay chrome-free. */
const CONSOLE_CHROME_GROUPS = new Set(["dashboard", "admin"]);

/**
 * Render a single registered cloud route. Authenticated routes are wrapped in
 * the Steward auth provider (which itself lazy-loads the heavy `@stwd/*` runtime
 * only when needed); console routes (`dashboard`/`admin` groups) additionally
 * render inside the {@link ConsoleShell} sidebar chrome; public token routes
 * (payment / approve / ballot / sensitive / shared chat) render WITHOUT
 * app-shell chrome and WITHOUT Steward.
 */
function CloudRouteElement({
  route,
}: {
  route: CloudRouteDef;
}): React.JSX.Element {
  const body = applyRouteGate(route.gate, renderRouteElement(route));
  if (route.public) {
    return <>{body}</>;
  }
  if (route.group && CONSOLE_CHROME_GROUPS.has(route.group)) {
    return (
      <StewardAuthProvider>
        <ConsoleShell>{body}</ConsoleShell>
      </StewardAuthProvider>
    );
  }
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
}

/**
 * Where an authenticated visitor landing on the apex is sent. The apex
 * (elizacloud.ai) is the cloud CONSOLE — its job is "add credits / manage your
 * account", not chat (chat is the agent app's home, served from
 * app.elizacloud.ai). `/dashboard` is the standalone console overview (balance
 * + a directory of every console surface), and it is a REGISTERED cloud route,
 * so navigating there never re-enters this catch-all.
 */
const APEX_AUTHENTICATED_HOME = "/dashboard";

/**
 * Catch-all element. Renders the agent app exactly as before, EXCEPT on an
 * apex control-plane host, where the agent app must NEVER boot: the apex has
 * no same-origin agent backend, so the app's boot sequence 404-storms on
 * `/api/*` and the failed `/api/first-run/status` probe throws the first-run
 * onboarding chooser over the console (the exact "elizacloud.ai shows the
 * app" prod bug this guard exists for). On an apex host every path that falls
 * through to this catch-all is an agent-app path by definition — all console
 * surfaces are registered routes and match before it — so:
 *
 *  - unauthenticated → the Steward `/login` page (`returnTo` preserved).
 *  - authenticated → the console home ({@link APEX_AUTHENTICATED_HOME}),
 *    whatever the path: `/`, `/settings`, `/chat`, or any other app-only URL
 *    would otherwise boot the backendless app.
 *  - auth state not yet readable → a blank fallback, never the app; rendering
 *    the app while auth resolves lets its tab system rewrite the URL and
 *    strand the visitor before the redirect can fire.
 *
 * Every non-apex host (per-agent subdomains, app.elizacloud.ai, localhost) is
 * untouched: chat stays home.
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
  return <>{appElement}</>;
}

/**
 * The shell. Mounts the registered cloud routes + the `/dashboard/*` compat
 * redirects, and renders {@link CloudRouterShellProps.appElement} for every
 * other path so chat stays home and the tab system is untouched.
 */
export function CloudRouterShell({
  appElement,
}: CloudRouterShellProps): React.JSX.Element {
  const cloudRoutes = listCloudRoutes();
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
        <Routes>
          {cloudRoutes.map((route) => (
            <Route
              key={route.path}
              path={route.path}
              element={<CloudRouteElement route={route} />}
            />
          ))}

          {DASHBOARD_REDIRECTS.map(({ from, to }) => (
            <Route key={from} path={from} element={<ParamRedirect to={to} />} />
          ))}

          {/* Backend OAuth/Stripe return URLs still target the legacy
              /dashboard/settings?tab=<x> shape; map them onto the standalone
              console pages instead of the dashboard/* 404 below. */}
          <Route
            path="dashboard/settings"
            element={<LegacySettingsTabRedirect />}
          />

          {/*
           * Any /dashboard/* path not registered and not redirected is a cloud
           * 404 (it must not fall through to the tab/view app, which would try
           * to resolve it as a tab). Keep this AFTER the redirects so the
           * explicit entries above win.
           */}
          <Route path="dashboard/*" element={<CloudNotFound />} />

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
