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
};
