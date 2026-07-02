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
import {
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
} from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { ELIZA_CLOUD_CONTROL_PLANE_HOSTS } from "../../utils/cloud-agent-base";
import { queryClient } from "../lib/query-client";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "./CloudI18nProvider";
import { type CloudRouteDef, listCloudRoutes } from "./cloud-route-registry";
import { StewardAuthProvider } from "./StewardProvider";

/**
 * `/dashboard/*` compatibility redirect map. The old cloud dashboard lived
 * under `/dashboard/*`; in the app the canonical homes are the standalone
 * views (apps, agents, analytics, api-explorer, admin) and the in-app
 * settings sections (account, security, billing, api-keys, monetization,
 * connections), so these resolve every legacy deep link the backend or old
 * bookmarks may still point at. `:param` segments are substituted from the
 * matched route params, and the original query string is preserved.
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
    // In-dashboard quick chat was removed; real chat lives in the app. Send old
    // deep links back to the agent detail page.
    { from: "dashboard/agents/:id/chat", to: "/dashboard/agents/:id" },
    // App-create modal is opened from the apps list, not its own route.
    { from: "dashboard/apps/create", to: "/dashboard/apps" },
    // Account-management surfaces live in the in-app Settings sections; none of
    // these have a standalone route — the redirects are the sole entry for
    // every in-repo link and old deep link (including the backend-issued
    // /dashboard/billing top-up URLs).
    { from: "dashboard/billing", to: "/settings#cloud-billing" },
    { from: "dashboard/api-keys", to: "/settings#cloud-api-keys" },
    { from: "dashboard/monetization", to: "/settings#cloud-monetization" },
    { from: "dashboard/earnings", to: "/settings#cloud-monetization" },
    { from: "dashboard/affiliates", to: "/settings#cloud-monetization" },
    { from: "dashboard/account", to: "/settings#cloud-account" },
    { from: "dashboard/security", to: "/settings#cloud-security" },
    {
      from: "dashboard/security/permissions",
      to: "/settings#cloud-plugin-grants",
    },
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
 * map onto the canonical in-app settings sections. Unknown/absent tabs land on
 * the settings hub.
 */
const LEGACY_SETTINGS_TAB_SECTIONS: Readonly<Record<string, string>> = {
  connections: "cloud-connectors",
  billing: "cloud-billing",
  organization: "cloud-organization",
  agents: "cloud-agents",
};

function LegacySettingsTabRedirect(): React.JSX.Element {
  const location = useLocation();
  const tab = new URLSearchParams(location.search).get("tab") ?? "";
  const section = LEGACY_SETTINGS_TAB_SECTIONS[tab];
  return (
    <Navigate
      to={`/settings${location.search}${section ? `#${section}` : ""}`}
      replace
    />
  );
}

function renderRouteElement(
  element: LazyExoticComponent<ComponentType<unknown>> | ComponentType<unknown>,
): React.JSX.Element {
  const RouteComponent = element as ComponentType<unknown>;
  return (
    <Suspense fallback={<RouteChunkFallback />}>
      <RouteComponent />
    </Suspense>
  );
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
    <div className="mx-auto max-w-prose p-8 text-sm text-neutral-400">
      <h1 className="mb-3 text-lg font-semibold text-white">Not found</h1>
      <p>The page you requested doesn&apos;t exist.</p>
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

/**
 * Render a single registered cloud route. Authenticated routes are wrapped in
 * the Steward auth provider (which itself lazy-loads the heavy `@stwd/*` runtime
 * only when needed); public token routes (payment / approve / ballot /
 * sensitive / shared chat) render WITHOUT app-shell chrome and WITHOUT Steward.
 */
function CloudRouteElement({
  route,
}: {
  route: CloudRouteDef;
}): React.JSX.Element {
  const body = renderRouteElement(route.element);
  if (route.public) {
    return body;
  }
  return <StewardAuthProvider>{body}</StewardAuthProvider>;
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
 * Apex control-plane hosts that serve THIS console UI but have no same-origin
 * agent backend — so an unauthenticated visitor must land on the Steward
 * `/login` page, not the agent shell (which 401-walls on `/api/*`).
 * `api.elizacloud.ai` is the API origin (it never serves this shell); per-agent
 * `<id>.elizacloud.ai` subdomains are NOT in the control-plane set and boot
 * their real runtime, so they fall through untouched.
 */
const APEX_UI_CONTROL_PLANE_HOSTS = new Set(
  // Exclude the API origins (api. / api-staging.) — they never serve this shell.
  [...ELIZA_CLOUD_CONTROL_PLANE_HOSTS].filter((h) => !/^api[.-]/.test(h)),
);

function isApexControlPlaneHost(): boolean {
  if (typeof window === "undefined") return false;
  return APEX_UI_CONTROL_PLANE_HOSTS.has(
    window.location.hostname.toLowerCase(),
  );
}

/**
 * Where an authenticated visitor landing on the apex ROOT is sent. The apex
 * (elizacloud.ai) is the cloud CONSOLE — its job is "add credits / manage your
 * account", not chat (chat is the agent app's home, served from
 * app.elizacloud.ai). `/settings#cloud-billing` is the canonical
 * credits/billing surface (every in-app billing link resolves here, e.g. the
 * `dashboard/billing` compat redirect above) and the settings hub around it
 * (Billing · Developer/API keys · Connections · Organization) is the
 * account-management home. Both domains serve the SAME packages/app bundle, so
 * without this the apex and the app subdomain look identical when signed in.
 */
const APEX_AUTHENTICATED_HOME = "/settings#cloud-billing";

/**
 * Catch-all element. Renders the agent app exactly as before, EXCEPT on an apex
 * control-plane host, where it makes the two domains behave differently:
 *
 *  - unauthenticated → the Steward `/login` page (`returnTo` preserved) instead
 *    of booting the agent shell that would 401-wall on `/api/*`. (The apex
 *    401-wall was a router fall-through: no route registers the apex root `/`,
 *    so an unauthenticated apex visitor hit this catch-all and booted the agent
 *    runtime against a backend that isn't there.)
 *  - authenticated AND on the bare apex root (`/`) → the cloud console home
 *    ({@link APEX_AUTHENTICATED_HOME}) instead of chat, so elizacloud.ai lands
 *    on the credits/manage dashboard. Deeper apex paths (a shared agent, a deep
 *    link) still render the app so those links keep working.
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
  if (isApexControlPlaneHost() && ready) {
    if (!authenticated) {
      const returnTo = encodeURIComponent(
        `${location.pathname}${location.search}`,
      );
      return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
    }
    // Authenticated on the bare apex root → the console home. Guard on the root
    // path (and no tab hash) so we redirect ONLY the landing, never a deep link
    // the user navigated to on purpose. The target is `/settings`, which is not
    // an apex-console route, so it re-enters this catch-all at a non-root path
    // and renders the app (which reads `#cloud-billing`) — no redirect loop.
    if (location.pathname === "/" && !location.hash) {
      return <Navigate to={APEX_AUTHENTICATED_HOME} replace />;
    }
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
              /dashboard/settings?tab=<x> shape; map them onto the settings
              sections instead of the dashboard/* 404 below. */}
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

          {/* Catch-all: the existing tab/view app (chat is home) — except an
              unauthenticated visit to an apex control-plane host, which
              redirects to /login instead of 401-walling. See AppCatchAllRoute. */}
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
