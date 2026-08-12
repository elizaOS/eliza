/**
 * Registers current and legacy console Applications paths to the retired-Apps
 * redirect without loading the heavier Applications page barrel.
 */
import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

export const APPLICATIONS_LIST_ROUTE_PATH = "dashboard/apps";
export const APPLICATIONS_DETAIL_ROUTE_PATH = "dashboard/apps/:id";
export const APPLICATIONS_LEGACY_LIST_ROUTE_PATH = "dashboard/applications";
export const APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH =
  "dashboard/applications/:id";

/** Register every console Applications spelling to the moved-route handoff. */
export function registerMovedApplicationsCloudRoutes(): void {
  const AppsMovedRoute = lazy(() => import("./AppsMovedRoute"));
  for (const path of [
    APPLICATIONS_LIST_ROUTE_PATH,
    APPLICATIONS_DETAIL_ROUTE_PATH,
    APPLICATIONS_LEGACY_LIST_ROUTE_PATH,
    APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH,
  ]) {
    registerCloudRoute({
      path,
      element: AppsMovedRoute,
      group: "dashboard",
    });
  }
}
