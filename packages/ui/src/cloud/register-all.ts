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
 * `registerAllCloudSurfaces()` is that single boot hook: hosts that need the
 * complete private + public route table before the next statement call it
 * synchronously. It is idempotent — every underlying registration guards
 * against double-register or is keyed by route path / section id — so calling
 * it more than once is safe.
 *
 * **Contract:** this module preserves the develop synchronous
 * `registerAllCloudSurfaces(): void` API on `@elizaos/ui/cloud/register-all`.
 * Callers that import this subpath and read the registry on the next line must
 * observe a complete table.
 *
 * Progressive public-only boot for anonymous `/login` (#18056) lives on a
 * **different** entrypoint: `@elizaos/ui/cloud/register-public`. That path is
 * what `packages/app` uses so private dashboard domains stay out of the idle
 * login critical graph.
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
import "./instances";
import "./analytics";
import "./home/routes";
import "./billing/routes";
import "./api-keys/routes";
import "./account-security/routes";
import "./monetization/routes";
import "./connectors/routes";
import "./organization/routes";
import "./applications";

import { registerAdminCloudRoutes } from "./admin";
import { registerApiExplorerCloudRoute } from "./api-explorer";
import { registerMovedApplicationsCloudRoutes } from "./applications/register-moved-routes";
import { registerApprovalsCloudRoute } from "./approvals";
import { registerJoinFlow } from "./join/register";
import { registerMcpsCloudRoute } from "./mcps";
import { registerPublicPages } from "./public-pages/register";
import { registerCloudSettingsSections } from "./settings";

let registered = false;

/**
 * Register every cloud route + settings section against the shared registries.
 * Synchronous, idempotent, and safe to call from any host that needs a complete
 * table before the next statement (legacy develop contract).
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
}
