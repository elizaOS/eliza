// Persists tenant db clusters records for cloud services through the shared DB boundary.
import { and, eq, sql } from "drizzle-orm";
import type { ClusterCandidate, ClusterPoolStore } from "../../lib/services/tenant-db/cluster-pool";
import { dbRead, dbWrite } from "../helpers";
import { type NewTenantDbCluster, tenantDbClusters } from "../schemas/tenant-db-clusters";

/**
 * Repository for the apps tenant-DB cluster pool. Implements
 * {@link ClusterPoolStore} over the `tenant_db_clusters` table — the persistent
 * backend the {@link ClusterPool} allocates from.
 */
export const tenantDbClustersRepository: ClusterPoolStore & {
  create(input: NewTenantDbCluster): Promise<{ id: string }>;
  releaseSlot(clusterId: string): Promise<void>;
  findByHost(host: string): Promise<{ id: string; adminDsnEncrypted: string } | null>;
} = {
  async listAllocatable(): Promise<ClusterCandidate[]> {
    const rows = await dbRead
      .select({
        id: tenantDbClusters.id,
        host: tenantDbClusters.host,
        adminDsnEncrypted: tenantDbClusters.admin_dsn_encrypted,
        databaseCount: tenantDbClusters.database_count,
        maxDatabases: tenantDbClusters.max_databases,
        isActive: tenantDbClusters.is_active,
      })
      .from(tenantDbClusters)
      .where(
        and(
          eq(tenantDbClusters.is_active, true),
          sql`${tenantDbClusters.database_count} < ${tenantDbClusters.max_databases}`,
        ),
      );
    return rows;
  },

  /**
   * Atomically claim a database slot: increment `database_count` only if the
   * cluster is still active and under capacity. The `WHERE … < max_databases`
   * guard makes concurrent claims race-safe — two callers can't overfill a
   * cluster — and the empty `RETURNING` set signals "lost the race".
   */
  async tryClaimSlot(clusterId: string): Promise<boolean> {
    const claimed = await dbWrite
      .update(tenantDbClusters)
      .set({
        database_count: sql`${tenantDbClusters.database_count} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tenantDbClusters.id, clusterId),
          eq(tenantDbClusters.is_active, true),
          sql`${tenantDbClusters.database_count} < ${tenantDbClusters.max_databases}`,
        ),
      )
      .returning({ id: tenantDbClusters.id });
    return claimed.length > 0;
  },

  async create(input: NewTenantDbCluster): Promise<{ id: string }> {
    const [row] = await dbWrite
      .insert(tenantDbClusters)
      .values(input)
      .returning({ id: tenantDbClusters.id });
    if (!row) throw new Error("Failed to insert tenant_db_clusters row");
    return row;
  },

  /**
   * Release a database slot when a tenant DB is deprovisioned — the counterpart
   * to {@link tryClaimSlot}. Decrements `database_count`, FLOORED at 0 via
   * `GREATEST(0, …)` so a double-release (or releasing a slot that was never
   * counted) can never drive the count negative and free phantom capacity. Safe
   * to call more than once; callers run it after the DROP DATABASE/ROLE succeeds.
   */
  async releaseSlot(clusterId: string): Promise<void> {
    await dbWrite
      .update(tenantDbClusters)
      .set({
        database_count: sql`GREATEST(0, ${tenantDbClusters.database_count} - 1)`,
        updated_at: new Date(),
      })
      .where(eq(tenantDbClusters.id, clusterId));
  },

  /**
   * Resolve the cluster that owns a tenant DB by its host (the host embedded in
   * the app's stored DSN). Returns the id + encrypted admin DSN needed to open
   * an admin connection for deprovisioning. `host` is unique per cluster.
   */
  async findByHost(host: string): Promise<{ id: string; adminDsnEncrypted: string } | null> {
    const [row] = await dbRead
      .select({
        id: tenantDbClusters.id,
        adminDsnEncrypted: tenantDbClusters.admin_dsn_encrypted,
      })
      .from(tenantDbClusters)
      .where(eq(tenantDbClusters.host, host))
      .limit(1);
    return row ?? null;
  },
};
