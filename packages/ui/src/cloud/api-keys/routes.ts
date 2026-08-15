/**
 * Cloud-route registration for the API-keys domain. Importing this module
 * registers the standalone `cloud/api-keys` console page (authenticated;
 * the shell wraps it in the Steward auth provider). The Settings "API keys"
 * section renders the same {@link ApiKeysSurface} inside the app; this route
 * is the apex-console mount and the target for backend-issued deep links.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "cloud/api-keys",
  group: "cloud",
  element: lazy(() => import("./ApiKeysPage")),
});
