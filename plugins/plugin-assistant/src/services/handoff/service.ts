/**
 * Provides per-room handoff and resume state for assistant conversation policy.
 * Hosts register the service explicitly; direct consumers share the same runtime
 * cache keys when the service is absent.
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { createHandoffStore, type HandoffStore } from "./store.ts";

export const HANDOFF_SERVICE = "eliza_handoff";

export class HandoffService extends Service {
  static override serviceType = HANDOFF_SERVICE;

  override capabilityDescription =
    "Runtime handoff store: per-room handoff state gating agent contributions, cache-backed";

  static async start(runtime: IAgentRuntime): Promise<HandoffService> {
    return new HandoffService(runtime);
  }

  async stop(): Promise<void> {}

  /** The cache-backed per-room handoff store for this runtime. */
  getStore(): HandoffStore {
    return createHandoffStore(this.runtime);
  }
}

/**
 * Resolve the registered {@link HandoffService}. Returns `null` when the
 * runtime has not registered it (e.g. the "eliza" plugin is absent).
 */
export function resolveHandoffService(
  runtime: IAgentRuntime,
): HandoffService | null {
  return runtime.getService<HandoffService>(HANDOFF_SERVICE);
}

/** Resolves the registered store or its equivalent runtime-cache implementation. */
export function resolveHandoffStore(runtime: IAgentRuntime): HandoffStore {
  const service = resolveHandoffService(runtime);
  return service ? service.getStore() : createHandoffStore(runtime);
}
