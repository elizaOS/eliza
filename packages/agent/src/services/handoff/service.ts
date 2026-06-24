/**
 * HandoffService — the runtime-owned per-room handoff state, exposed as a
 * registered runtime service.
 *
 * Handoff is a runtime primitive: the room-policy provider and the
 * `MESSAGE.handoff` resume-detection branch consume the store via
 * `runtime.getService(...)` rather than constructing the cache-backed store
 * itself. The service is a thin factory over the per-runtime
 * {@link HandoffStore}; the store is cache-backed (no SQL), keyed per room.
 *
 * Mirrors `KnowledgeGraphService` (lifecycle + getService accessor).
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
