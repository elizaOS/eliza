/**
 * `GlobalPauseStore` — vacation / pause mode singleton.
 *
 * Promoted to a first-class `@elizaos/agent` runtime service in LifeOps Slice 3
 * (`GlobalPauseService`, serviceType `eliza_global_pause`). The store
 * implementation and its types now live inward in `@elizaos/agent`; this module
 * re-exports them and adds {@link resolveGlobalPauseStore}, which prefers the
 * registered runtime service (first-wins dedup) and falls back to constructing
 * the cache-backed store directly when the service is absent.
 *
 * Backing storage: runtime cache, single canonical key (unchanged).
 */

import {
  createGlobalPauseStore,
  type GlobalPauseStore,
  resolveGlobalPauseService,
} from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export {
  createGlobalPauseStore,
  GLOBAL_PAUSE_CACHE_KEY,
  type GlobalPauseStatus,
  type GlobalPauseStore,
  type GlobalPauseWindow,
} from "@elizaos/agent";

/**
 * Resolve the global-pause store: the registered runtime service when present,
 * else a directly-constructed cache-backed store. Both read/write the same
 * canonical cache key, so the fallback is behaviorally identical.
 */
export function resolveGlobalPauseStore(
  runtime: IAgentRuntime,
): GlobalPauseStore {
  const service = resolveGlobalPauseService(runtime);
  return service ? service.getStore() : createGlobalPauseStore(runtime);
}
