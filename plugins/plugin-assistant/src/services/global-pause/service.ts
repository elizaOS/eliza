/**
 * Provides the cache-backed pause window used by scheduled assistant work.
 * Hosts register the service explicitly; direct consumers share the same runtime
 * cache keys when the service is absent.
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { createGlobalPauseStore, type GlobalPauseStore } from "./store.ts";

export const GLOBAL_PAUSE_SERVICE = "eliza_global_pause";

export class GlobalPauseService extends Service {
  static override serviceType = GLOBAL_PAUSE_SERVICE;

  override capabilityDescription =
    "Runtime global-pause store: vacation / pause-mode singleton consulted by the scheduler, cache-backed";

  static async start(runtime: IAgentRuntime): Promise<GlobalPauseService> {
    return new GlobalPauseService(runtime);
  }

  async stop(): Promise<void> {}

  /** The cache-backed global-pause store for this runtime. */
  getStore(): GlobalPauseStore {
    return createGlobalPauseStore(this.runtime);
  }
}

/**
 * Resolve the registered {@link GlobalPauseService}. Returns `null` when the
 * runtime has not registered it (e.g. the "eliza" plugin is absent).
 */
export function resolveGlobalPauseService(
  runtime: IAgentRuntime,
): GlobalPauseService | null {
  return runtime.getService<GlobalPauseService>(GLOBAL_PAUSE_SERVICE);
}

/** Resolves the registered store or its equivalent runtime-cache implementation. */
export function resolveGlobalPauseStore(
  runtime: IAgentRuntime,
): GlobalPauseStore {
  const service = resolveGlobalPauseService(runtime);
  return service ? service.getStore() : createGlobalPauseStore(runtime);
}
