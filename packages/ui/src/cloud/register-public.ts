/**
 * Progressive public-only cloud-surface registration for anonymous web boot
 * (#18056).
 *
 * `packages/app` imports this module (not `./register-all`) so private
 * dashboard domains never enter the idle `/login` critical graph. Private
 * surfaces load later via {@link ensurePrivateCloudSurfaces} when a
 * `dashboard/*` path is visited.
 *
 * The legacy synchronous full-table contract remains at
 * `@elizaos/ui/cloud/register-all` (`registerAllCloudSurfaces(): void`).
 */

import { registerJoinFlow } from "./join/register";
import {
  ensurePrivateCloudSurfaces,
  getPrivateCloudRegistrationSnapshot,
  type PrivateCloudRegistrationSnapshot,
  type PrivateCloudRegistrationStatus,
  pathNeedsPrivateCloudSurfaces,
  retryPrivateCloudSurfaces,
  subscribePrivateCloudRegistration,
} from "./private-cloud-registration";
import { registerPublicPages } from "./public-pages/register";

// Runtime API only — test-only mutation hooks stay on
// `./private-cloud-registration` so the public boot entry does not re-export
// them (shipwright #18441).
export {
  ensurePrivateCloudSurfaces,
  getPrivateCloudRegistrationSnapshot,
  type PrivateCloudRegistrationSnapshot,
  type PrivateCloudRegistrationStatus,
  pathNeedsPrivateCloudSurfaces,
  retryPrivateCloudSurfaces,
  subscribePrivateCloudRegistration,
};

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
 * @deprecated Prefer {@link ensurePrivateCloudSurfaces}. Named alias for
 * earlier PR heads that imported this symbol from the progressive path.
 */
export function registerPrivateCloudSurfaces(): Promise<void> {
  return ensurePrivateCloudSurfaces();
}
