/**
 * Cloud-route registration for the account-security domain. Importing this
 * module registers the standalone `cloud/account` and the backend-issued
 * `cloud/security/permissions` recovery page. The retired `cloud/security`
 * alias is owned by CloudRouterShell's static compatibility redirects so it
 * cannot lose a navigation race while private routes load asynchronously.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "cloud/account",
  group: "cloud",
  element: lazy(() => import("./AccountPage")),
});

registerCloudRoute({
  path: "cloud/security/permissions",
  group: "cloud",
  element: lazy(() => import("./PermissionsPage")),
});
