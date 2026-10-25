/**
 * Cloud-route registration for the monetization domain. Importing this module
 * registers the standalone `cloud/monetization` console page
 * (authenticated; the shell wraps it in the Steward auth provider). The
 * Settings "Monetization" section renders the same tabbed view inside the app;
 * this route is the apex-console mount, and the legacy
 * `cloud/{earnings,affiliates}` deep links redirect here.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "cloud/monetization",
  group: "cloud",
  element: lazy(() => import("./MonetizationPage")),
});
