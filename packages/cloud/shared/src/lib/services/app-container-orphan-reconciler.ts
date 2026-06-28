/**
 * Orphan APP-container reconciler (Apps / Product 2).
 *
 * The sibling of the AGENT orphan reconciler in `docker-node-workloads.ts`, for
 * the OTHER kind of workload on the shared Hetzner-Docker pool: user-deployed
 * APP containers (the `containers` table, NOT `agent_sandboxes`).
 *
 * Both share ONE implementation — the orchestration loop, the SSH wiring, the
 * hard timeouts, the reap-by-immutable-id rm, and the fail-safe group-by-key
 * diff all live in `orphan-container-reconciler.ts`. This module injects only
 * the three app-specific deltas: the `app-` prefix, the `keyOf` that uses the
 * container NAME as the diff key, and the app terminal-status vocab (plus the
 * `containers` status query and a log tag).
 *
 * THE GAP THIS CLOSES
 * App-container teardown (`appCleanupService` / the CONTAINER_DELETE executor)
 * only runs on an EXPLICIT app delete. A mid-deploy crash or a partial failure
 * can leave an `app-<slug>` container running on a node with no live DB row (or
 * a DB row left in a dead terminal state) — it holds a compute slot and host
 * volume forever because nothing in the deploy lifecycle will ever reap it
 * again. Agents already get a periodic sweep for exactly this; apps did not.
 *
 * HOW APP CONTAINERS DIFFER FROM AGENTS
 *   - App containers are named `app-<first 12 of app id>` (see
 *     `containerNameForApp` in `app-deploy-runner.ts`); the name is written
 *     verbatim to `containers.name`. The diff key is therefore the container
 *     NAME itself, not an id parsed out of the name (agents key on the agent id
 *     embedded in `agent-<id>`).
 *   - The backing row lives in `containers`, with the status vocab
 *     pending | building | deploying | running | stopped | failed | deleting |
 *     deleted. A container is LIVE (do NOT reap) when its row is in
 *     pending/building/deploying/running/deleting (`deleting` = a delete job is
 *     in flight and owns teardown). It is an ORPHAN (reap) when its row is
 *     MISSING (`no_db_row`) or in a dead terminal state stopped/failed/deleted
 *     (`terminal_db_row`).
 *   - `containers.name` has NO unique constraint, so one `app-<slug>` name maps
 *     to MANY rows (one per deploy) — the shared diff's group-by-key
 *     `every-terminal` fail-safe (#9307) is what protects a live app sharing a
 *     name with stale stopped/failed rows. (For agents the key is a PRIMARY KEY
 *     so each key has at most one row and the same fail-safe reduces to a plain
 *     single-status check — identical decisions.)
 *
 * Non-`app-`-prefixed containers on a shared node (agents `agent-…`, the older
 * direct `cloud-container-…` provider path, infra containers like postgres) are
 * never matched by the `--filter name=app-` listing and never touched here.
 */

import { inArray } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { containers } from "../../db/schemas/containers";
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
 */
const TERMINAL_CONTAINER_STATUSES = new Set<string>(["stopped", "failed", "deleted"]);

/**
 * The app reconciler's `keyOf`: the diff key is the container NAME itself (apps
 * write the deterministic `app-<slug>` verbatim to `containers.name`). Returns
 * null for names outside the managed-app pattern so unrelated containers on a
 * shared node are never considered. A bare `app-` with no slug is rejected
 * (mirrors the agent reconciler rejecting a bare `agent-`).
 */
export function appContainerKeyOf(name: string): string | null {
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
