/** Complete route composition for the isolated Cloud integration fixture. */
// Side-effecting domain modules: importing them runs their top-level
// `registerCloudRoute(...)` calls.
import "../instances";
import "../analytics/routes";
import "../home/routes";
import "../billing/routes";
import "../api-keys/routes";
import "../account-security/routes";
import "../monetization/routes";
import "../connectors/routes";
import "../organization/routes";
import "../applications";

import { registerAdminCloudRoutes } from "../admin";
import { registerApiExplorerCloudRoute } from "../api-explorer";
import { registerMovedApplicationsCloudRoutes } from "../applications/register-moved-routes";
import { registerApprovalsCloudRoute } from "../approvals/routes";
import { registerJoinFlow } from "../join/register";
import { registerMcpsCloudRoute } from "../mcps";
import { registerPublicPages } from "../public-pages/register";
import { registerManagedCloudAppShellPage } from "../register-managed-cloud-page";
import { registerCloudSettingsSections } from "../settings/register-cloud-settings";

let registered = false;

/**
 * Register every cloud route + settings section against the shared registries.
 * Synchronous, idempotent, and safe to call from any host that needs a complete
 * table before the next statement.
 */
export function registerAllCloudSurfaces(): void {
  if (registered) return;
  registered = true;

  registerJoinFlow();
  registerPublicPages();

  registerApiExplorerCloudRoute();
  registerApprovalsCloudRoute();
  // The Applications module self-registers at import time; override its paths
  // and retain the older plural aliases so stale links reach the dashboard.
  registerMovedApplicationsCloudRoutes();
  registerAdminCloudRoutes();
  registerMcpsCloudRoute();

  registerCloudSettingsSections();
  registerManagedCloudAppShellPage();
}
