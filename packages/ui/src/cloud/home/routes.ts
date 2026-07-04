/**
 * Cloud-route registration for the console home. Importing this module
 * registers the standalone `dashboard` overview page (authenticated; the shell
 * wraps it in the Steward auth provider) — the landing the apex catch-all
 * (`AppCatchAllRoute`) sends every authenticated control-plane visitor to.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "dashboard",
  group: "dashboard",
  element: lazy(() => import("./DashboardHomePage")),
});
