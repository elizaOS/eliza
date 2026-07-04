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
 *
 * Account-management surfaces (account, security, plugin grants, billing,
 * API keys, monetization, connectors) are mounted twice on purpose: as in-app
 * Settings sections (the app's own settings hub) AND as standalone
 * `dashboard/*` console pages. The standalone mounts are what make the apex
 * console (elizacloud.ai) work — the agent app never boots there (see
 * `AppCatchAllRoute`), so the console pages are the only reachable home for
 * add-funds / API keys / account on a control-plane host.
 */

// Side-effecting domain modules: importing them runs their top-level
// `registerCloudRoute(...)` calls.
//
// The Approvals domain (`dashboard/approvals`) now lives in the standalone
// `@elizaos/cloud-ui` package, which self-registers it via this same
// cloud-route registry; the app shell calls `registerCloudUiSurfaces()` from
// that package alongside `registerAllCloudSurfaces()` here.
import "./instances";
import "./analytics";
import "./home/routes";
import "./billing/routes";
import "./api-keys/routes";
import "./account-security/routes";
import "./monetization/routes";
import "./connectors/routes";
import "./organization/routes";

import { registerAdminCloudRoutes } from "./admin";
import { registerApiExplorerCloudRoute } from "./api-explorer";
import { registerApplicationsCloudRoutes } from "./applications";
import { registerJoinFlow } from "./join";
import { registerMcpsCloudRoute } from "./mcps";
import { registerPublicPages } from "./public-pages";
import { registerCloudSettingsSections } from "./settings";

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

  registerApiExplorerCloudRoute();
  registerApplicationsCloudRoutes();
  registerAdminCloudRoutes();
  registerMcpsCloudRoute();

  registerCloudSettingsSections();
}
