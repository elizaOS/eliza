/**
 * GlobalPauseService — the runtime-owned vacation / pause-mode singleton,
 * exposed as a registered runtime service.
 *
 * Global pause is a runtime primitive: the scheduled-task runner consults the
 * store pre-fire via `runtime.getService(...)` rather than constructing the
 * cache-backed store itself. The service is a thin factory over the per-runtime
 * {@link GlobalPauseStore}; the store is cache-backed (no SQL), single canonical
 * key.
 *
 * Mirrors `KnowledgeGraphService` (lifecycle + getService accessor).
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
