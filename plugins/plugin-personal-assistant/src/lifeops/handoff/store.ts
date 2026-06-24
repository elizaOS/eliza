/**
 * `HandoffStore` — per-room handoff state.
 *
 * Promoted to a first-class `@elizaos/agent` runtime service in LifeOps Slice 3
 * (`HandoffService`, serviceType `eliza_handoff`). The store implementation, its
 * types, and the pure resume-evaluation helpers (`evaluateResume`,
 * `describeResumeCondition`) now live inward in `@elizaos/agent`; this module
 * re-exports them and adds {@link resolveHandoffStore}, which prefers the
 * registered runtime service (first-wins dedup) and falls back to constructing
 * the cache-backed store directly when the service is absent.
 *
 * Backing storage: runtime cache, keyed per-room (unchanged).
 */

import {
  createHandoffStore,
  type HandoffStore,
  resolveHandoffService,
} from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  type HandoffEnterOpts,
  type HandoffStatus,
  type HandoffStore,
  type ResumeCondition,
  type ResumeEvaluation,
  type ResumeEvaluationInput,
} from "@elizaos/agent";

/**
 * Resolve the handoff store: the registered runtime service when present, else a
 * directly-constructed cache-backed store. Both read/write the same per-room
 * cache keys, so the fallback is behaviorally identical.
 */
export function resolveHandoffStore(runtime: IAgentRuntime): HandoffStore {
  const service = resolveHandoffService(runtime);
  return service ? service.getStore() : createHandoffStore(runtime);
}
