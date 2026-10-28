/**
 * Cache and OAuth modules avoid importing runtime-factory (breaks circular imports).
 * runtime-factory calls registerRuntimeCacheActions after the factory singleton exists.
 * Until registration this isolate has no in-memory runtime cache entries to evict,
 * but the shared warm entry in the edge cache can already exist because another
 * instance wrote it. The unloaded agent branch therefore still clears that shared
 * entry; edge-runtime-cache does not import runtime-factory, so the delegation does
 * not reopen the import cycle this registry exists to avoid.
 */

import { edgeRuntimeCache } from "../cache/edge-runtime-cache";
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
    // Mirror the factory's invalidateRuntime cross-instance part: the shared warm
    // entry is written by other instances and may already exist before this
    // isolate loads the factory. Both edge-cache methods swallow and log their
    // own failures, so a cache outage cannot fail the write that requested
    // invalidation. The returned false stays truthful: no in-memory runtime
    // entry existed here to evict.
    await edgeRuntimeCache.invalidateCharacter(agentId);
    await edgeRuntimeCache.markRuntimeWarm(agentId, {
      isWarm: false,
      embeddingDimension: 0,
      characterName: undefined,
    });
    logger.debug(
      `[RuntimeCacheRegistry] runtime factory not loaded; cleared the shared warm entry for agent ${agentId}`,
    );
    return false;
  }
  return a.invalidateRuntime(agentId);
}

/**
 * Organization invalidation only evicts this isolate's in-memory entries, which
 * cannot exist before the factory loads, so the unloaded branch stays a no-op.
 */
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

// Test exports - only for integration testing.
export const _testing = {
  resetActionsForTest(): void {
    actions = null;
  },
};
