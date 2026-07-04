/**
 * Cloud-route registration for the API-keys domain. Importing this module
 * registers the standalone `dashboard/api-keys` console page (authenticated;
 * the shell wraps it in the Steward auth provider). The Settings "API keys"
 * section renders the same {@link ApiKeysSurface} inside the app; this route
 * is the apex-console mount and the target for backend-issued deep links.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "dashboard/api-keys",
  group: "dashboard",
  element: lazy(() => import("./ApiKeysPage")),
});
