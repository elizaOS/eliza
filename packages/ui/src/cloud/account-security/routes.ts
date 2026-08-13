/**
 * Cloud-route registration for the account-security domain. Importing this
 * module registers the standalone `cloud/account`, `cloud/security`,
 * and `cloud/security/permissions` console pages (authenticated; the shell
 * wraps them in the Steward auth provider). The Settings sections render the
 * same surfaces inside the app; these routes are the apex-console mounts and
 * the targets for backend-issued deep links.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "cloud/account",
  group: "cloud",
  element: lazy(() => import("./AccountPage")),
});

registerCloudRoute({
  path: "cloud/security",
  group: "cloud",
  element: lazy(() => import("./SecurityPage")),
});

registerCloudRoute({
  path: "cloud/security/permissions",
  group: "cloud",
  element: lazy(() => import("./PermissionsPage")),
});
