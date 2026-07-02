/**
 * Cloud-route registration for the Organization domain.
 *
 * Importing this module registers the Organization page against the shared
 * cloud-route registry (see `../shell/cloud-route-registry`). The cloud router
 * shell mounts whatever `listCloudRoutes()` returns, so this is the only wiring
 * needed for the standalone deep-link surface — no edits to any shared route
 * table.
 *
 * Mount path: `dashboard/organization` (authenticated; the shell wraps it in
 * the Steward auth provider). The Settings "Organization" section renders the
 * same {@link OrganizationSection}; this route stays registered as the
 * standalone deep-link target — the connect-link invite flow navigates here
 * with `?tab=credentials&contribute=1`.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

registerCloudRoute({
  path: "dashboard/organization",
  group: "dashboard",
  element: lazy(() => import("./OrganizationPage")),
});
