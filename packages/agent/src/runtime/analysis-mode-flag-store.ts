/**
 * Process-wide singleton instance of `AnalysisModeFlagStore` for the agent
 * layer. Downstream consumers in `@elizaos/agent` (chat-routes SSE emit, UI
 * sidecar serializer — both PUNT for now) should read the flag through
 * `getAnalysisModeFlagStore()` so every reader sees the same per-room state.
 *
 * The activation hook in `@elizaos/core` (see
 * `packages/core/src/services/analysis-mode-handler.ts`) maintains its own
 * module-local store because `core` cannot import `agent`. Once the SSE +
 * UI sidecar work lands, both layers should be unified — likely by attaching
 * this singleton to the runtime so `core` can read it via a structural
 * interface. Until then, this module exists as the canonical placeholder for
 * agent-side reads.
 */

import { AnalysisModeFlagStore } from "./analysis-mode-flag.js";

let singleton: AnalysisModeFlagStore | null = null;

export function getAnalysisModeFlagStore(): AnalysisModeFlagStore {
  if (singleton === null) {
    singleton = new AnalysisModeFlagStore();
  }
  return singleton;
}

/** Test helper. Resets the module-level instance so tests can isolate state. */
export function __resetAnalysisModeFlagStoreForTests(): void {
  singleton = null;
}
