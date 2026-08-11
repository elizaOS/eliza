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
 * Split for anonymous-login performance (#18056):
 * - {@link registerPublicCloudSurfaces} only loads the public/auth/join graph
 *   (login, payment, legal, …). It must not static-import private dashboard
 *   domains or the public-pages *barrel* (which eagerly re-exports LoginPage
 *   and collapses the login route into the registration chunk).
 * - {@link ensurePrivateCloudSurfaces} (see `private-cloud-registration.ts`)
 *   loads authenticated console domains only when a private path is visited.
 * - {@link registerAllCloudSurfaces} registers public surfaces then awaits
 *   private registration. Prefer this in tests/fixtures that need the full
 *   route table. Production web boot uses public-only registration and lets
 *   the shell own private loading.
 *
 * Account-management surfaces (account, security, plugin grants, billing,
 * API keys, monetization, connectors) are mounted twice on purpose: as in-app
 * Settings sections (the app's own settings hub) AND as standalone
 * `dashboard/*` console pages. The standalone mounts are what make the apex
 * console (elizacloud.ai) work — the agent app never boots there (see
 * `AppCatchAllRoute`), so the console pages are the only reachable home for
 * add-funds / API keys / account on a control-plane host.
 */

import { registerJoinFlow } from "./join/register";
import { ensurePrivateCloudSurfaces } from "./private-cloud-registration";
import { registerPublicPages } from "./public-pages/register";

export {
  ensurePrivateCloudSurfaces,
  getPrivateCloudRegistrationSnapshot,
  type PrivateCloudRegistrationSnapshot,
  type PrivateCloudRegistrationStatus,
  pathNeedsPrivateCloudSurfaces,
  resetPrivateCloudRegistrationForTests,
  retryPrivateCloudSurfaces,
  subscribePrivateCloudRegistration,
} from "./private-cloud-registration";

let publicRegistered = false;

/**
 * Register public/auth/join cloud routes only. Safe to call on every boot;
 * does not pull private dashboard/settings module graphs and must not start
 * private dynamic imports (#18056).
 */
export function registerPublicCloudSurfaces(): void {
  if (publicRegistered) return;
  publicRegistered = true;

  registerJoinFlow();
  registerPublicPages();
}

/**
 * @deprecated Prefer {@link ensurePrivateCloudSurfaces}. Kept as a named alias
 * for earlier PR heads that imported this symbol.
 */
export function registerPrivateCloudSurfaces(): Promise<void> {
  return ensurePrivateCloudSurfaces();
}

/**
 * Register every cloud route + settings section against the shared registries.
 *
 * Async on purpose: private domains are dynamic imports. Callers that need a
 * complete private route table must await this promise (tests/fixtures do).
 * Production web boot should call {@link registerPublicCloudSurfaces} only and
 * let the shell load private domains on demand.
 */
export async function registerAllCloudSurfaces(): Promise<void> {
  registerPublicCloudSurfaces();
  await ensurePrivateCloudSurfaces();
}
