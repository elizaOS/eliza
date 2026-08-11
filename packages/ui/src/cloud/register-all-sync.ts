/**
 * Synchronous full cloud-surface registration (legacy contract).
 *
 * This module uses static private-domain imports so
 * {@link registerAllCloudSurfaces} returns only after every route/settings
 * registration has run. It is intentionally **not** part of public web boot
 * (`packages/app` imports `./register-all` for public-only progressive load).
 *
 * Use this entrypoint from:
 * - IIFE browser fixtures (no top-level await)
 * - Unit tests that need a complete route table before asserting
 *
 * Do **not** import this from the anonymous-login critical path (#18056).
 */

// Side-effecting domain modules: importing them runs their top-level
// `registerCloudRoute(...)` calls.
import "./instances";
import "./analytics";
import "./home/routes";
import "./billing/routes";
import "./api-keys/routes";
import "./account-security/routes";
import "./monetization/routes";
import "./connectors/routes";
import "./organization/routes";

import { lazy } from "react";
import { registerAdminCloudRoutes } from "./admin";
import { registerApiExplorerCloudRoute } from "./api-explorer";
import {
  APPLICATIONS_DETAIL_ROUTE_PATH,
  APPLICATIONS_LIST_ROUTE_PATH,
} from "./applications";
import { registerApprovalsCloudRoute } from "./approvals";
import { registerJoinFlow } from "./join/register";
import { registerMcpsCloudRoute } from "./mcps";
import { registerPublicPages } from "./public-pages/register";
import { registerCloudSettingsSections } from "./settings";
import { registerCloudRoute } from "./shell/cloud-route-registry";

let registered = false;

/**
 * Register every cloud route + settings section against the shared registries.
 * Synchronous and idempotent — the full private table is present when this
 * returns (legacy develop contract).
 */
export function registerAllCloudSurfaces(): void {
  if (registered) return;
  registered = true;

  registerJoinFlow();
  registerPublicPages();

  registerApiExplorerCloudRoute();
  registerApprovalsCloudRoute();
  // The Applications module self-registers at import time; override both paths
  // so stale /dashboard/apps links redirect to the dashboard.
  const AppsMovedRoute = lazy(() => import("./applications/AppsMovedRoute"));
  registerCloudRoute({
    path: APPLICATIONS_LIST_ROUTE_PATH,
    element: AppsMovedRoute,
    group: "dashboard",
  });
  registerCloudRoute({
    path: APPLICATIONS_DETAIL_ROUTE_PATH,
    element: AppsMovedRoute,
    group: "dashboard",
  });
  registerAdminCloudRoutes();
  registerMcpsCloudRoute();

  registerCloudSettingsSections();
}
