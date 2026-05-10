/**
 * Register all native permission probers with the central permissions
 * registry.
 *
 * The runtime should call this exactly once at boot, after the registry
 * has been instantiated. The sibling agent that owns the registry should
 * wire this in at the same place where the registry is constructed.
 *
 * INTEGRATION TODO (registry-wiring agent): the runtime entrypoint that
 * constructs the registry should look roughly like:
 *
 *     import { PermissionsRegistry } from "./permissions-registry";
 *     import { registerAllProbers } from "@elizaos/agent/services/permissions/register-probers";
 *
 *     const registry = new PermissionsRegistry();
 *     registerAllProbers(registry);
 *     runtime.registerService("permissions", registry);
 *
 * Likely call sites (in this repo):
 *   - packages/agent/src/runtime/eliza.ts (top-level runtime bootstrap)
 *   - packages/app-core/platforms/electrobun/src/index.ts (Electrobun
 *     desktop bootstrap, where the existing PermissionManager is created)
 *   - packages/agent/src/runtime/dev-server.ts (dev mode entry)
 */

import type { IPermissionsRegistry } from "./contracts.js";
import { ALL_PROBERS } from "./probers/index.js";

export function registerAllProbers(registry: IPermissionsRegistry): void {
  for (const prober of ALL_PROBERS) {
    registry.registerProber(prober);
  }
}

export { ALL_PROBERS };
