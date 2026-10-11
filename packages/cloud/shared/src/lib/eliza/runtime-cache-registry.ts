/**
 * Cache and OAuth modules avoid importing runtime-factory (breaks circular imports).
 * runtime-factory calls registerRuntimeCacheActions after the factory singleton exists.
 * Until that import happens no runtime cache entries can exist, so invalidation
 * through this registry is a logged no-op, never a failure of the write that
 * requested it.
 */

import { logger } from "../utils/logger";

type RuntimeCacheActions = {
  invalidateRuntime: (agentId: string) => Promise<boolean>;
  invalidateByOrganization: (organizationId: string) => Promise<number>;
};

let actions: RuntimeCacheActions | null = null;

export function registerRuntimeCacheActions(next: RuntimeCacheActions): void {
  actions = next;
}

export async function invalidateRuntimeFromRegistry(agentId: string): Promise<boolean> {
  const a = actions;
  if (!a) {
    logger.debug(
      `[RuntimeCacheRegistry] runtime factory not loaded; nothing to invalidate for agent ${agentId}`,
    );
    return false;
  }
  return a.invalidateRuntime(agentId);
}

export async function invalidateOrganizationRuntimesFromRegistry(
  organizationId: string,
): Promise<number> {
  const a = actions;
  if (!a) {
    logger.debug(
      `[RuntimeCacheRegistry] runtime factory not loaded; nothing to invalidate for organization ${organizationId}`,
    );
    return 0;
  }
  return a.invalidateByOrganization(organizationId);
}
