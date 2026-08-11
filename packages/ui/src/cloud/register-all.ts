/**
 * Boot-time registration aggregator for every app-hosted Eliza Cloud surface.
 *
 * The `CloudRouterShell` renders whatever {@link listCloudRoutes} returns, and
 * the Settings view renders whatever the settings-section registry holds. Every
 * cloud domain registers itself either as an import side effect (top-level
 * `registerCloudRoute(...)` / `registerSettingsSection(...)` calls) or via an
 * explicit `registerX()` function. None of those run unless the modules are
 * imported and the functions are called once at boot.
 *
 * Split for anonymous-login performance (#18056):
 * - {@link registerPublicCloudSurfaces} only loads the public/auth/join graph
 *   (login, payment, legal, …). It must not static-import private dashboard
 *   domains or the public-pages *barrel* (which eagerly re-exports LoginPage
 *   and collapses the login route into the registration chunk).
 * - {@link registerPrivateCloudSurfaces} dynamically imports the authenticated
 *   console domains so their modules form separate async chunks and can load
 *   after first paint on public routes.
 * - {@link registerAllCloudSurfaces} runs both (public then private). Tests and
 *   fixtures that need the full route table should await it.
 *
 * Account-management surfaces (account, security, plugin grants, billing,
 * API keys, monetization, connectors) are mounted twice on purpose: as in-app
 * Settings sections (the app's own settings hub) AND as standalone
 * `dashboard/*` console pages. The standalone mounts are what make the apex
 * console (elizacloud.ai) work — the agent app never boots there (see
 * `AppCatchAllRoute`), so the console pages are the only reachable home for
 * add-funds / API keys / account on a control-plane host.
 */

import { lazy } from "react";
import { registerJoinFlow } from "./join/register";
import { registerPublicPages } from "./public-pages/register";
import { registerCloudRoute } from "./shell/cloud-route-registry";

/** Stable Applications paths (console no longer hosts Apps; see override below). */
const APPLICATIONS_LIST_ROUTE_PATH = "dashboard/apps";
const APPLICATIONS_DETAIL_ROUTE_PATH = "dashboard/apps/:id";

let publicRegistered = false;
let privateRegistered = false;
let privateRegistration: Promise<void> | null = null;

/**
 * Register public/auth/join cloud routes only. Safe to call on every boot;
 * does not pull private dashboard/settings module graphs.
 */
export function registerPublicCloudSurfaces(): void {
  if (publicRegistered) return;
  publicRegistered = true;

  registerJoinFlow();
  registerPublicPages();
}

/**
 * Register authenticated console / settings / admin surfaces. Dynamically
 * imports domain modules so they stay out of the public registration chunk.
 * Idempotent; concurrent callers share one in-flight promise.
 */
export function registerPrivateCloudSurfaces(): Promise<void> {
  if (privateRegistered) return Promise.resolve();
  if (privateRegistration) return privateRegistration;

  privateRegistration = (async () => {
    if (privateRegistered) return;

    // Side-effecting domain modules: importing them runs their top-level
    // `registerCloudRoute(...)` calls.
    await Promise.all([
      import("./instances"),
      import("./analytics"),
      import("./home/routes"),
      import("./billing/routes"),
      import("./api-keys/routes"),
      import("./account-security/routes"),
      import("./monetization/routes"),
      import("./connectors/routes"),
      import("./organization/routes"),
    ]);

    const [
      { registerAdminCloudRoutes },
      { registerApiExplorerCloudRoute },
      { registerApprovalsCloudRoute },
      { registerMcpsCloudRoute },
      { registerCloudSettingsSections },
    ] = await Promise.all([
      import("./admin"),
      import("./api-explorer"),
      import("./approvals"),
      import("./mcps"),
      import("./settings"),
    ]);

    registerApiExplorerCloudRoute();
    registerApprovalsCloudRoute();

    // The console no longer surfaces Apps — management moved into the Eliza
    // app. Override both paths (later same-path registration wins) so a stale
    // /dashboard/apps link redirects to the dashboard. Do not import the
    // Applications barrel: it eagerly re-exports heavy page modules.
    const AppsMovedRoute = lazy(() => import("./applications/AppsMovedRoute"));
    registerCloudRoute({
      path: APPLICATIONS_LIST_ROUTE_PATH,
      element: AppsMovedRoute,
      group: "dashboard",
    });
    registerCloudRoute({
      path: APPLICATIONS_DETAIL_ROUTE_PATH,
      element: AppsMovedRoute,
      group: "dashboard",
    });

    registerAdminCloudRoutes();
    registerMcpsCloudRoute();
    registerCloudSettingsSections();

    privateRegistered = true;
  })().catch((error) => {
    // Allow a later caller to retry after a failed dynamic import.
    privateRegistration = null;
    throw error;
  });

  return privateRegistration;
}

/**
 * Register every cloud route + settings section against the shared registries.
 * Idempotent. Prefer awaiting this in tests/fixtures; the web shell may call
 * {@link registerPublicCloudSurfaces} first and load private surfaces after
 * first paint.
 */
export async function registerAllCloudSurfaces(): Promise<void> {
  registerPublicCloudSurfaces();
  await registerPrivateCloudSurfaces();
}
