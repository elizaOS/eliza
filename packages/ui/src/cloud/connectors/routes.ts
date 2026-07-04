/**
 * Cloud-route registration for the connectors domain. Importing this module
 * registers the standalone `dashboard/connectors` console page (authenticated;
 * the shell wraps it in the Steward auth provider). The in-app connectors
 * Settings section renders the same body; this route is the apex-console mount
 * and the landing for backend OAuth-connect return URLs.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "dashboard/connectors",
  group: "dashboard",
  element: lazy(() => import("./ConnectorsPage")),
});
