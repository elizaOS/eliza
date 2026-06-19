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
 * Route table source (REVISION-2 §B1, DECISIONS.md D1): every cloud / public /
 * auth / payment route is registered by its domain module via
 * `registerCloudRoute(...)` against the {@link CloudRouteDef} registry; this
 * shell mounts whatever {@link listCloudRoutes} returns and 404s gracefully
 * otherwise. The `/dashboard/*` `<Navigate>` map is carried verbatim from
 * `@elizaos/cloud-frontend/src/App.tsx`.
 *
 * Build-target gating (REVISION-2 §B3): this module and its Steward / cloud-i18n
 * / query providers are web-build-only. Native (Capacitor) mounts the tab/view
 * App directly with no bundle growth — see `packages/app/src/main.tsx`.
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
import { queryClient } from "../lib/query-client";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "./CloudI18nProvider";
import { type CloudRouteDef, listCloudRoutes } from "./cloud-route-registry";
import { StewardAuthProvider } from "./StewardProvider";

/**
 * `/dashboard/*` compatibility redirect map, carried verbatim from
 * `@elizaos/cloud-frontend/src/App.tsx`. The old cloud dashboard lived under
 * `/dashboard/*`; in the app the canonical homes are the standalone views and
 * the settings sections, so these resolve every legacy deep link the backend or
 * old bookmarks may still point at. `:param` segments are substituted from the
 * matched route params, and the original query string is preserved.
 */
const DASHBOARD_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
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
  // App-create modal is opened from the apps list, not its own route.
  { from: "dashboard/apps/create", to: "/dashboard/apps" },
  // New app-IA targets: billing / api-keys move into settings sections.
  { from: "dashboard/billing", to: "/settings#billing" },
  { from: "dashboard/api-keys", to: "/settings#api-keys" },
];

/** Substitute `:param` segments from the matched route params. */
function ParamRedirect({ to }: { to: string }): React.JSX.Element {
  const location = useLocation();
  const params = useParams();
  const resolved = to.replace(/:([a-zA-Z]+)/g, (_, key) => params[key] ?? "");
  return <Navigate to={`${resolved}${location.search}`} replace />;
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

          {/*
           * Any /dashboard/* path not registered and not redirected is a cloud
           * 404 (it must not fall through to the tab/view app, which would try
           * to resolve it as a tab). Keep this AFTER the redirects so the
           * explicit entries above win.
           */}
          <Route path="dashboard/*" element={<CloudNotFound />} />

          {/* Catch-all: the existing tab/view app. Chat is home. */}
          <Route path="*" element={appElement} />
        </Routes>
      </CloudProviders>
    </BrowserRouter>
  );
}

export default CloudRouterShell;
