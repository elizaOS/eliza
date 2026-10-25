// Persists app databases records for cloud services through the shared DB boundary.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type AllocatedCluster,
  type ClusterCandidate,
  ClusterPool,
} from "../../lib/services/tenant-db/cluster-pool";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type AppDatabase, appDatabases, type NewAppDatabase } from "../schemas/app-databases";
import type { UserDatabaseStatus } from "../schemas/apps";
import { tenantDbClusters } from "../schemas/tenant-db-clusters";

export type { AppDatabase, NewAppDatabase };

type DatabaseStateColumns = Pick<
  AppDatabase,
  | "app_id"
  | "user_database_uri"
  | "user_database_region"
  | "user_database_status"
  | "user_database_error"
  | "tenant_db_cluster_id"
>;

export type AppDatabaseState = DatabaseStateColumns & {
  source: "app_databases";
};

export type TenantDbClusterPlacement = AllocatedCluster;

type AppDatabaseStateUpdate = Partial<
  Pick<
    NewAppDatabase,
    | "user_database_uri"
    | "user_database_region"
    | "user_database_status"
    | "user_database_error"
    | "tenant_db_cluster_id"
  >
>;

function compactUpdate(data: AppDatabaseStateUpdate): AppDatabaseStateUpdate {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as AppDatabaseStateUpdate;
}

/**
 * Repository for canonical app database provisioning state.
 *
 * Active reads and writes use `app_databases`; legacy `apps.user_database_*`
 * columns are retired by the consolidation migration.
 */
export class AppDatabasesRepository {
  async findByAppId(appId: string): Promise<AppDatabase | undefined> {
    return await dbRead.query.appDatabases.findFirst({
      where: eq(appDatabases.app_id, appId),
    });
  }

  async findStateByAppId(appId: string): Promise<AppDatabaseState | undefined> {
    return this.findStateByAppIdUsingDb(dbRead, appId);
  }

  async findStateByAppIdForWrite(appId: string): Promise<AppDatabaseState | undefined> {
    return this.findStateByAppIdUsingDb(dbWrite, appId);
  }

  async listStatesByAppIds(appIds: string[]): Promise<Map<string, AppDatabaseState>> {
    if (appIds.length === 0) {
      return new Map();
    }

    const rows = await dbRead.query.appDatabases.findMany({
      where: inArray(appDatabases.app_id, appIds),
    });

    return new Map(rows.map((row) => [row.app_id, this.toState(row)]));
  }

  async trySetProvisioning(appId: string, region: string): Promise<AppDatabase | undefined> {
    const [database] = await sqlRows<AppDatabase>(
      dbWrite,
      sql`
        INSERT INTO ${appDatabases} (
          app_id,
          user_database_status,
          user_database_error,
          user_database_region,
          updated_at
        )
        VALUES (${appId}, 'provisioning', NULL, ${region}, NOW())
        ON CONFLICT (app_id) DO UPDATE
        SET
          user_database_status = 'provisioning',
          user_database_error = NULL,
          user_database_region = EXCLUDED.user_database_region,
          updated_at = NOW()
        WHERE ${appDatabases.user_database_status} IN ('none', 'error')
        RETURNING *
      `,
    );

    return database;
  }

  async findTenantDbPlacementByAppId(appId: string): Promise<TenantDbClusterPlacement | undefined> {
    const [placement] = await dbRead
      .select({
        id: tenantDbClusters.id,
        host: tenantDbClusters.host,
        adminDsnEncrypted: tenantDbClusters.admin_dsn_encrypted,
      })
      .from(appDatabases)
      .innerJoin(tenantDbClusters, eq(appDatabases.tenant_db_cluster_id, tenantDbClusters.id))
      .where(eq(appDatabases.app_id, appId))
      .limit(1);

    return placement;
  }

  async claimTenantDbPlacementForApp(appId: string): Promise<TenantDbClusterPlacement> {
    return await dbWrite.transaction(async (tx) => {
      const now = new Date();
      await tx
        .insert(appDatabases)
        .values({
          app_id: appId,
          updated_at: now,
        } as NewAppDatabase)
        .onConflictDoNothing({ target: appDatabases.app_id });

      const [locked] = await tx
        .select({
          tenant_db_cluster_id: appDatabases.tenant_db_cluster_id,
        })
        .from(appDatabases)
        .where(eq(appDatabases.app_id, appId))
        .for("update")
        .limit(1);

      if (!locked) {
        throw new Error("Failed to lock app database row for tenant DB placement");
      }

      if (locked.tenant_db_cluster_id) {
        const [existing] = await tx
          .select({
            id: tenantDbClusters.id,
            host: tenantDbClusters.host,
            adminDsnEncrypted: tenantDbClusters.admin_dsn_encrypted,
          })
          .from(tenantDbClusters)
          .where(eq(tenantDbClusters.id, locked.tenant_db_cluster_id))
          .limit(1);
        if (existing) {
          return existing;
        }
      }

      const pool = new ClusterPool({
        async listAllocatable(): Promise<ClusterCandidate[]> {
          return await tx
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
        },
        async tryClaimSlot(clusterId: string): Promise<boolean> {
          const claimed = await tx
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
      });

      const allocated = await pool.allocate();
      await tx
        .update(appDatabases)
        .set({
          tenant_db_cluster_id: allocated.id,
          updated_at: new Date(),
        })
        .where(eq(appDatabases.app_id, appId));

      return allocated;
    });
  }

  async clearTenantDbPlacementForApp(appId: string, clusterId: string): Promise<void> {
    await dbWrite
      .update(appDatabases)
      .set({
        tenant_db_cluster_id: null,
        updated_at: new Date(),
      })
      .where(and(eq(appDatabases.app_id, appId), eq(appDatabases.tenant_db_cluster_id, clusterId)));
  }

  async updateState(appId: string, data: AppDatabaseStateUpdate): Promise<AppDatabase> {
    const update = compactUpdate(data);
    const now = new Date();
    const [database] = await dbWrite
      .insert(appDatabases)
      .values({
        app_id: appId,
        ...update,
        updated_at: now,
      } as NewAppDatabase)
      .onConflictDoUpdate({
        target: appDatabases.app_id,
        set: {
          ...update,
          updated_at: now,
        },
      })
      .returning();

    return database;
  }

  private async findStateByAppIdUsingDb(
    database: typeof dbRead,
    appId: string,
  ): Promise<AppDatabaseState | undefined> {
    const canonical = await database.query.appDatabases.findFirst({
      where: eq(appDatabases.app_id, appId),
    });

    if (canonical) {
      return this.toState(canonical);
    }

    return undefined;
  }

  private toState(database: AppDatabase): AppDatabaseState {
    return {
      app_id: database.app_id,
      user_database_uri: database.user_database_uri,
      user_database_region: database.user_database_region,
      user_database_status: database.user_database_status as UserDatabaseStatus,
      user_database_error: database.user_database_error,
      tenant_db_cluster_id: database.tenant_db_cluster_id,
      source: "app_databases",
    };
  }
}

export const appDatabasesRepository = new AppDatabasesRepository();
