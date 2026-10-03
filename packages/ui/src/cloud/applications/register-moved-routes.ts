/**
 * Registers lazy app administration for current and legacy Cloud URLs.
 * Free Cloud identity authorizes these pages independently of a personal agent.
 */
import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

export const APPLICATIONS_LIST_ROUTE_PATH = "cloud/apps";
export const APPLICATIONS_DETAIL_ROUTE_PATH = "cloud/apps/:id";
export const APPLICATIONS_LEGACY_LIST_ROUTE_PATH = "cloud/applications";
export const APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH = "cloud/applications/:id";

/** Register app administration without importing the page components during public boot. */
export function registerMovedApplicationsCloudRoutes(): void {
  const ApplicationsRoute = lazy(() => import("./ApplicationsPage"));
  const ApplicationDetailRoute = lazy(() => import("./ApplicationDetailPage"));
  for (const path of [
    APPLICATIONS_LIST_ROUTE_PATH,
    APPLICATIONS_DETAIL_ROUTE_PATH,
    APPLICATIONS_LEGACY_LIST_ROUTE_PATH,
    APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH,
  ]) {
    registerCloudRoute({
      path,
      element: path.endsWith("/:id")
        ? ApplicationDetailRoute
        : ApplicationsRoute,
      group: "cloud",
    });
  }
}
