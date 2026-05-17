/**
 * Anchor consolidation policies.
 *
 *   - `wake.confirmed` → `{ mode: "merge", sortBy: "priority_desc" }` so the
 *     morning brief, gm reminder, sleep recap, quiet-user-watcher
 *     observations, and overdue followups (all firing on the same anchor)
 *     render as one cohesive read instead of N separate notifications.
 *   - `bedtime.target` → `{ mode: "sequential", staggerMinutes: 5 }` so the
 *     gn reminder and the sleep-recap (from plugin-health) don't arrive at
 *     the same instant.
 */

import type { AnchorConsolidationPolicy } from "./contract-stubs.js";

export const DEFAULT_CONSOLIDATION_POLICIES: ReadonlyArray<AnchorConsolidationPolicy> =
  [
    {
      anchorKey: "wake.confirmed",
      mode: "merge",
      sortBy: "priority_desc",
      // No batch-size cap; merge any number of co-firing tasks.
    },
    {
      anchorKey: "bedtime.target",
      mode: "sequential",
      staggerMinutes: 5,
    },
  ];
