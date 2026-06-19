/**
 * Register all native permission probers with the central permissions
 * registry.
 *
 * `PermissionRegistry.start()` calls this during service startup. Custom
 * registry hosts can also call this helper after constructing an
 * `IPermissionsRegistry` implementation.
 */

import type { IPermissionsRegistry } from "./contracts.js";
import { ALL_PROBERS } from "./probers/index.js";

export function registerAllProbers(registry: IPermissionsRegistry): void {
  for (const prober of ALL_PROBERS) {
    registry.registerProber(prober);
  }
}

export { ALL_PROBERS };
