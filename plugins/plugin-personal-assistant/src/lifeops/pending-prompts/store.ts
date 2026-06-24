/**
 * `PendingPromptsStore` — backing store for `PendingPromptsProvider`.
 *
 * Promoted to a first-class `@elizaos/agent` runtime service in LifeOps Slice 3
 * (`PendingPromptsService`, serviceType `eliza_pending_prompts`). The store
 * implementation and its types now live inward in `@elizaos/agent`; this module
 * re-exports them and adds {@link resolvePendingPromptsStore}, which prefers the
 * registered runtime service (first-wins dedup) and falls back to constructing
 * the cache-backed store directly when the service is absent. PA consumers
 * resolve through the service so the store is shared runtime state.
 *
 * Backing storage: runtime cache, keyed per room (unchanged).
 */

import {
  createPendingPromptsStore,
  type PendingPromptsStore,
  resolvePendingPromptsService,
} from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export {
  createPendingPromptsStore,
  type ExpectedReplyKind,
  type PendingPrompt,
  type PendingPromptRecordInput,
  type PendingPromptsStore,
  type RecordedPendingPrompt,
} from "@elizaos/agent";

/**
 * Resolve the pending-prompts store: the registered runtime service when
 * present, else a directly-constructed cache-backed store. Both read/write the
 * same per-room cache keys, so the fallback is behaviorally identical.
 */
export function resolvePendingPromptsStore(
  runtime: IAgentRuntime,
): PendingPromptsStore {
  const service = resolvePendingPromptsService(runtime);
  return service ? service.getStore() : createPendingPromptsStore(runtime);
}
