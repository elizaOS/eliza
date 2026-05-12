/**
 * Anchor consolidation policies registered by W1-D.
 *
 * Per IMPL §3.4 + GAP §3.16:
 *   - `wake.confirmed` → `{ mode: "merge", sortBy: "priority_desc" }` so the
 *     morning brief, gm reminder, sleep recap, quiet-user-watcher
 *     observations, and overdue followups (all firing on the same anchor)
 *     render as one cohesive read instead of N separate notifications.
 *   - `bedtime.target` → `{ mode: "sequential", staggerMinutes: 5 }` so the
 *     gn reminder and the sleep-recap (from plugin-health) don't arrive at
 *     the same instant.
 *
 * Stub status: see `contract-stubs.ts` — `AnchorConsolidationPolicy` is
 * declared locally until W1-A's `consolidation-policy.ts` lands.
 */

import type { AnchorConsolidationPolicy } from "./contract-stubs.js";

export const DEFAULT_CONSOLIDATION_POLICIES: ReadonlyArray<
  AnchorConsolidationPolicy
> = [
  {
    anchorKey: "wake.confirmed",
    mode: "merge",
    sortBy: "priority_desc",
    // No batch-size cap on Wave-1; merge any number of co-firing tasks.
    // If users see overstuffed morning messages in practice, W3-A's review
    // pass adds `maxBatchSize` here.
  },
  {
    anchorKey: "bedtime.target",
    mode: "sequential",
    staggerMinutes: 5,
  },
];
