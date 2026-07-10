/**
 * Reconciles app workloads and their DB ambassadors on the shared Docker pool.
 * Both resources map to the workload name stored in `containers`, so a live row
 * protects them together while a missing or fully terminal row makes each
 * observed Docker ID reapable. Multiple deployment rows may share one name;
 * the generic reconciler therefore keeps the resources when any row is live.
 * A `cleanup_required` row also remains live until a retry proves Docker
 * absence, preserving the node-capacity claim across uncertain teardown.
 * Containers outside the `app-` namespace are never listed or touched.
 */

import { inArray } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { containers } from "../../db/schemas/containers";
import { APP_DB_AMBASSADOR_NAME_PREFIX, appContainerNameForAmbassador } from "./app-db-ambassador";
import {
  type LiveContainerRef,
  type OrphanReconcileResult,
  type OrphanReconcilerConfig,
  reconcileOrphanContainersOnNodes,
} from "./orphan-container-reconciler";

// Re-export the shared result type so existing importers (the daemon) keep
// `AppOrphanReconcileResult` from this module.
export type { OrphanReconcileResult as AppOrphanReconcileResult } from "./orphan-container-reconciler";

/**
 * The prefix every Apps/Product-2 container name carries. Kept in lockstep with
 * `containerNameForApp` (`app-<slug>`) in `app-deploy-runner.ts`. Defined here
 * (rather than imported) so this safety-critical reaper has no dependency on the
 * deploy-runner module graph; if that prefix ever changes, the two must change
 * together.
 */
export const APP_CONTAINER_NAME_PREFIX = "app-";

/**
 * `containers.status` values that mean the container should NOT be running. A
 * container backing a row in one of these states is reapable just like one with
 * no row at all: the deploy lifecycle has decided this app has no live
 * container, so a leftover Docker process is a leak.
 *
 * `stopped` and `failed` are the recovery cases — they exist precisely because a
 * deploy ended (cleanly or in error) without the host container being removed.
 * `deleted` is the hard-terminal state. `deleting` is NOT included: a delete job
 * is actively in flight and owns the teardown; reaping under it would race the
 * worker (the exact mirror of the agent reconciler excluding `deletion_pending`).
 * `cleanup_required` is also protected: it deliberately retains node capacity
 * until a provision retry proves Docker absence or successfully replaces the
 * deterministic container name.
 */
const TERMINAL_CONTAINER_STATUSES = new Set<string>(["stopped", "failed", "deleted"]);

/**
 * Map an app workload or its DB ambassador to the workload name stored in
 * `containers.name`. Ambassadors deliberately have no row of their own, so
 * sharing the owner's key makes them live, terminal, or missing as one unit.
 * Names outside the managed namespace and incomplete names are rejected.
 */
export function appContainerKeyOf(name: string): string | null {
  if (name.startsWith(APP_DB_AMBASSADOR_NAME_PREFIX)) {
    return appContainerNameForAmbassador(name);
  }
  return name.startsWith(APP_CONTAINER_NAME_PREFIX) &&
    name.length > APP_CONTAINER_NAME_PREFIX.length
    ? name
    : null;
}

/**
 * Load (key, status) for the `containers` rows matching the given container
 * names, including terminal-state rows. The reconciler needs the status to tell
 * a missing row (`no_db_row`) apart from a terminal one (`terminal_db_row`).
 *
 * This can return MULTIPLE rows for the same name: `containers.name` is the
 * deterministic `app-<first 12 of app id>` with no unique constraint, so an app
 * accumulates one row per deploy. The shared diff groups these per key and only
 * reaps when every row is terminal, so returning the full (unordered) set here
 * is correct and fail-safe.
 */
async function loadContainerStatusesByNames(names: readonly string[]): Promise<LiveContainerRef[]> {
  if (names.length === 0) return [];
  return dbRead
    .select({ key: containers.name, status: containers.status })
    .from(containers)
    .where(inArray(containers.name, names as string[]));
}

/** The three app-specific deltas injected into the shared reconciler. */
const APP_ORPHAN_RECONCILER_CONFIG: OrphanReconcilerConfig = {
  prefix: APP_CONTAINER_NAME_PREFIX,
  keyOf: appContainerKeyOf,
  terminalStatuses: TERMINAL_CONTAINER_STATUSES,
  loadStatuses: loadContainerStatusesByNames,
  logScope: "app-orphan-reconciler",
};

/**
 * Production wiring for the orphan APP-container reconciler. Delegates to the
 * shared sweep with the app deltas. The daemon imports this name.
 */
export function reconcileOrphanAppContainersOnNodes(): Promise<OrphanReconcileResult> {
  return reconcileOrphanContainersOnNodes(APP_ORPHAN_RECONCILER_CONFIG);
}
