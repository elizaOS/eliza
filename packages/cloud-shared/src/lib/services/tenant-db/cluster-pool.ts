/**
 * Tenant DB cluster pool (Apps / Product 2) — least-loaded selection + race-safe
 * slot claiming. Picks where a new per-tenant database should be created so the
 * apps data plane scales past any single cluster's cap by spreading tenants
 * across N clusters and rolling onto a fresh one when the current set fills.
 *
 * Pure selection logic + a thin coordinator over an injected store, so the
 * whole policy is unit-testable with no DB. Backend-agnostic (self-managed PG
 * or Neon-as-cluster) — a cluster is just {host, adminDsn, capacity, load}.
 */

/** A cluster the pool may allocate a tenant database onto. */
export interface ClusterCandidate {
  id: string;
  host: string;
  /** Encrypted admin DSN for running provisioning DDL on this cluster. */
  adminDsnEncrypted: string;
  databaseCount: number;
  maxDatabases: number;
  isActive: boolean;
}

/** The cluster chosen for a tenant + its (claimed) slot. */
export interface AllocatedCluster {
  id: string;
  host: string;
  adminDsnEncrypted: string;
}

/**
 * Storage seam. `listAllocatable` returns candidate clusters (ideally
 * pre-filtered to active + has-capacity, but the pool defends regardless).
 * `tryClaimSlot` atomically increments `database_count` only if still under
 * `max_databases`, returning false if it raced to full — the DB-level guard
 * that keeps two concurrent allocations from overfilling a cluster.
 */
export interface ClusterPoolStore {
  listAllocatable(): Promise<ClusterCandidate[]>;
  tryClaimSlot(clusterId: string): Promise<boolean>;
  /** Decrement `database_count` after a tenant DB is dropped (floor at 0). */
  releaseSlot(clusterId: string): Promise<boolean>;
  /** Load a cluster's admin credentials for deprovision DDL. */
  findById(clusterId: string): Promise<AllocatedCluster | null>;
}

/** Thrown when every active cluster is at capacity — operators add a cluster. */
export class NoClusterCapacityError extends Error {
  constructor(message = "No tenant DB cluster has capacity; add a cluster") {
    super(message);
    this.name = "NoClusterCapacityError";
  }
}

/**
 * Pure: pick the least-loaded active cluster that still has capacity. Ties
 * break by id for deterministic selection. Returns null when none qualify.
 */
export function selectLeastLoadedCluster(
  clusters: readonly ClusterCandidate[],
): ClusterCandidate | null {
  let best: ClusterCandidate | null = null;
  for (const c of clusters) {
    if (!c.isActive || c.databaseCount >= c.maxDatabases) continue;
    if (
      best === null ||
      c.databaseCount < best.databaseCount ||
      (c.databaseCount === best.databaseCount && c.id < best.id)
    ) {
      best = c;
    }
  }
  return best;
}

export class ClusterPool {
  private readonly store: ClusterPoolStore;
  private readonly maxAttempts: number;

  constructor(store: ClusterPoolStore, opts: { maxAttempts?: number } = {}) {
    this.store = store;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  /**
   * Allocate a slot on the least-loaded cluster, claiming it atomically. Re-reads
   * and retries when a claim loses a race (the cluster filled under us), and
   * throws {@link NoClusterCapacityError} once nothing claimable remains.
   */
  async allocate(): Promise<AllocatedCluster> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const candidates = await this.store.listAllocatable();
      const chosen = selectLeastLoadedCluster(candidates);
      if (!chosen) break;
      const claimed = await this.store.tryClaimSlot(chosen.id);
      if (claimed) {
        return {
          id: chosen.id,
          host: chosen.host,
          adminDsnEncrypted: chosen.adminDsnEncrypted,
        };
      }
      // Lost the race for that slot — loop and re-select.
    }
    throw new NoClusterCapacityError();
  }

  async release(clusterId: string): Promise<boolean> {
    return this.store.releaseSlot(clusterId);
  }

  async findById(clusterId: string): Promise<AllocatedCluster | null> {
    return this.store.findById(clusterId);
  }
}
