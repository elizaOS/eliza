/**
 * Applications cloud domain — barrel + route registration. Applications are
 * the developer **cloud OAuth app** object whose id is the OAuth `client_id`
 * (used by `/app-auth/authorize`) — distinct from the local installed-apps
 * surface.
 *
 *  - {@link ApplicationsRoute} (default export of `ApplicationsPage`) is the
 *    list view at `dashboard/apps`.
 *  - {@link ApplicationDetailRoute} is the 9-tab detail view at
 *    `dashboard/apps/:id` (overview / monetization / earnings / hosting /
 *    domains / analytics / promote / users / settings).
 *
 * Both routes register **at import time** against the {@link CloudRouteDef}
 * registry. The `CloudRouterShell` carries a `dashboard/apps/create →
 * /dashboard/apps` redirect; the detail route's UUID guard sends any non-UUID
 * id (including `create`) back to the list, so the two are consistent.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export { default as ApplicationDetailPage } from "./ApplicationDetailPage";
export { default as ApplicationsPage } from "./ApplicationsPage";
export { AppDetailsTabs } from "./components/app-details-tabs";
export {
  APPS_QUERY_KEY,
  type App,
  appQueryKey,
  checkAppNameAvailable,
  createApp,
  deleteApp,
  regenerateAppApiKey,
  updateApp,
  useApp,
  useApps,
} from "./lib/apps";

/** Stable surface label + URL path slugs for the Applications surface. */
export const APPLICATIONS_SURFACE_LABEL = "Applications";
export const APPLICATIONS_LIST_ROUTE_PATH = "dashboard/apps";
export const APPLICATIONS_DETAIL_ROUTE_PATH = "dashboard/apps/:id";

/** Lazy route elements (code-split) for the Applications surfaces. */
const ApplicationsRouteLazy = lazy(() => import("./ApplicationsPage"));
const ApplicationDetailRouteLazy = lazy(
  () => import("./ApplicationDetailPage"),
);

/** Cloud-route definition for the Applications list (`dashboard/apps`). */
export const applicationsListCloudRoute: CloudRouteDef = {
  path: APPLICATIONS_LIST_ROUTE_PATH,
  element: ApplicationsRouteLazy,
  group: "dashboard",
};

/** Cloud-route definition for the Applications detail (`dashboard/apps/:id`). */
export const applicationsDetailCloudRoute: CloudRouteDef = {
  path: APPLICATIONS_DETAIL_ROUTE_PATH,
  element: ApplicationDetailRouteLazy,
  group: "dashboard",
};

/**
 * Register (or re-register) both Applications routes. Exported for an explicit
 * custom-path mount; the default registration below runs at import time.
 */
export function registerApplicationsCloudRoutes(): void {
  registerCloudRoute(applicationsListCloudRoute);
  registerCloudRoute(applicationsDetailCloudRoute);
}

registerApplicationsCloudRoutes();
