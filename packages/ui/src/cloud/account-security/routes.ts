/**
 * Cloud-route registration for the account-security domain. Importing this
 * module registers the standalone `cloud/account`, the compatibility redirect
 * from retired `cloud/security`, and the backend-issued
 * `cloud/security/permissions` recovery page.
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
  element: lazy(() => import("./SecurityMovedRoute")),
});

registerCloudRoute({
  path: "cloud/security/permissions",
  group: "cloud",
  element: lazy(() => import("./PermissionsPage")),
});
