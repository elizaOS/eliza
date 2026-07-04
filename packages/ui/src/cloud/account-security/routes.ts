/**
 * Cloud-route registration for the account-security domain. Importing this
 * module registers the standalone `dashboard/account`, `dashboard/security`,
 * and `dashboard/security/permissions` console pages (authenticated; the shell
 * wraps them in the Steward auth provider). The Settings sections render the
 * same surfaces inside the app; these routes are the apex-console mounts and
 * the targets for backend-issued deep links.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "dashboard/account",
  group: "dashboard",
  element: lazy(() => import("./AccountPage")),
});

registerCloudRoute({
  path: "dashboard/security",
  group: "dashboard",
  element: lazy(() => import("./SecurityPage")),
});

registerCloudRoute({
  path: "dashboard/security/permissions",
  group: "dashboard",
  element: lazy(() => import("./PermissionsPage")),
});
