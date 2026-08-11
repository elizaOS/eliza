/**
 * Progressive cloud-surface registration for public web boot (#18056).
 *
 * Public boot (`packages/app` shell factory) imports only
 * {@link registerPublicCloudSurfaces} from this module so private dashboard
 * domains never enter the anonymous `/login` critical graph.
 *
 * For the **legacy synchronous full-table contract**, use
 * `./register-all-sync` — that module is intentionally not part of public boot.
 *
 * {@link registerAllCloudSurfaces} here is async (awaits private dynamic
 * imports). Prefer `register-all-sync` for fixtures/tests that need a complete
 * table before the next statement runs.
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
  setPrivateCloudLoadForTests,
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
 * Register public surfaces then await private dynamic registration.
 *
 * **Async.** Callers that need a complete private route table before the next
 * statement must either `await` this function or use the synchronous
 * `./register-all-sync` entrypoint.
 */
export async function registerAllCloudSurfaces(): Promise<void> {
  registerPublicCloudSurfaces();
  await ensurePrivateCloudSurfaces();
}
