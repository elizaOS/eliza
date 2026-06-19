/**
 * Boot-time registration aggregator for every app-hosted Eliza Cloud surface.
 *
 * The `CloudRouterShell` renders whatever {@link listCloudRoutes} returns, and
 * the Settings view renders whatever the settings-section registry holds. Every
 * cloud domain registers itself either as an import side effect (top-level
 * `registerCloudRoute(...)` / `registerSettingsSection(...)` calls) or via an
 * explicit `registerX()` function. None of those run unless the modules are
 * imported and the functions are called once at boot.
 *
 * `registerAllCloudSurfaces()` is that single boot hook: the app shell calls it
 * before mounting `CloudRouterShell` so the registry is populated. It is
 * idempotent — every underlying registration guards against double-register or
 * is keyed by route path / section id — so calling it more than once is safe.
 */

// Side-effecting domain modules: importing them runs their top-level
// `registerCloudRoute(...)` / `registerSettingsSection(...)` calls.
import "./instances";
import "./account-security";
import "./billing/routes";
import "./organization/routes";
import "./settings";

import { registerAdminCloudRoutes } from "./admin";
import { registerApiExplorerCloudRoute } from "./api-explorer";
import { registerApiKeysCloudRoute } from "./api-keys";
import { registerApplicationsCloudRoutes } from "./applications";
import { registerApprovalsCloudRoute } from "./approvals";
import { registerCloudConnectorsSettingsSection } from "./connectors";
import { registerDocumentsCloudRoute } from "./documents";
import { registerJoinFlow } from "./join";
import { registerMcpsCloudRoute, registerMcpsSettingsSection } from "./mcps";
import { registerMonetizationCloudRoutes } from "./monetization";
import { registerPublicPages } from "./public-pages";

let registered = false;

/**
 * Register every cloud route + settings section against the shared registries.
 * Idempotent and safe to call from the app shell on every boot.
 */
export function registerAllCloudSurfaces(): void {
  if (registered) return;
  registered = true;

  registerJoinFlow();
  registerPublicPages();

  registerApiKeysCloudRoute();
  registerApiExplorerCloudRoute();
  registerApplicationsCloudRoutes();
  registerApprovalsCloudRoute();
  registerDocumentsCloudRoute();
  registerMonetizationCloudRoutes();
  registerAdminCloudRoutes();
  registerMcpsCloudRoute();

  registerCloudConnectorsSettingsSection();
  registerMcpsSettingsSection();
}
