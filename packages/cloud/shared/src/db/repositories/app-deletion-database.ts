/** Original placement identity and an atomic capacity release after confirmed DROP. */
import { and, eq, sql } from "drizzle-orm";
import {
  AppDeletionRecoveryPendingError,
  appDeletionDigest,
} from "../../lib/services/app-deletion-authority";
import type { JobExecutionAuthority } from "../../lib/services/job-execution-authority";
import { appDatabases } from "../schemas/app-databases";
import { jobs } from "../schemas/jobs";
import { tenantDbClusters } from "../schemas/tenant-db-clusters";
import { withAppDeletionChildExecution } from "./app-deletion-execution";
import { assertJobExecutionAuthority } from "./job-execution-authority";

export async function readOriginalDeletionDatabase(authority: JobExecutionAuthority) {
  return withAppDeletionChildExecution(authority, async (tx, context) => {
    if (context.data.kind !== "database")
      throw new AppDeletionRecoveryPendingError("Deletion child is not a database");
    if (context.alreadyConfirmed || context.job.result?.appDeletionConfirmed === true) return null;
    const [database] = await tx
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, context.data.resourceId),
          eq(appDatabases.app_id, context.data.appId),
        ),
      )
      .for("update");
    await assertJobExecutionAuthority(tx, authority);
    if (
      !database?.user_database_uri ||
      database.tenant_db_cluster_id !== context.data.originalClusterId ||
      appDeletionDigest([
        database.id,
        context.data.appId,
        database.user_database_uri,
        database.tenant_db_cluster_id,
      ]) !== context.data.resourceDigest
    )
      throw new AppDeletionRecoveryPendingError(
        "Original database placement is unavailable or changed",
      );
    return { data: context.data, encryptedUri: database.user_database_uri };
  });
}

export async function confirmDeletionDatabase(authority: JobExecutionAuthority): Promise<void> {
  await withAppDeletionChildExecution(authority, async (tx, context) => {
    if (context.data.kind !== "database")
      throw new AppDeletionRecoveryPendingError("Deletion child is not a database");
    if (context.alreadyConfirmed || context.job.result?.appDeletionConfirmed === true) return;
    const [database] = await tx
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, context.data.resourceId),
          eq(appDatabases.app_id, context.data.appId),
        ),
      )
      .for("update");
    if (
      !database?.user_database_uri ||
      database.tenant_db_cluster_id !== context.data.originalClusterId ||
      appDeletionDigest([
        database.id,
        context.data.appId,
        database.user_database_uri,
        database.tenant_db_cluster_id,
      ]) !== context.data.resourceDigest
    )
      throw new AppDeletionRecoveryPendingError(
        "Original database placement changed before confirmation",
      );
    const [cluster] = await tx
      .update(tenantDbClusters)
      .set({
        database_count: sql`${tenantDbClusters.database_count} - 1`,
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(
        and(
          eq(tenantDbClusters.id, context.data.originalClusterId!),
          sql`${tenantDbClusters.database_count} > 0`,
        ),
      )
      .returning({ id: tenantDbClusters.id });
    if (!cluster)
      throw new AppDeletionRecoveryPendingError(
        "Original database capacity receipt is unavailable",
      );
    await assertJobExecutionAuthority(tx, authority);
    const [cleared] = await tx
      .update(appDatabases)
      .set({
        tenant_db_cluster_id: null,
        user_database_uri: null,
        user_database_status: "none",
        user_database_error: null,
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(and(eq(appDatabases.id, database.id), eq(appDatabases.app_id, context.data.appId)))
      .returning();
    if (!cleared || cleared.tenant_db_cluster_id !== null || cleared.user_database_uri !== null)
      throw new AppDeletionRecoveryPendingError(
        "Original database placement release was not persisted",
      );
    const [confirmed] = await tx
      .update(jobs)
      .set({
        result: {
          appDeletionConfirmed: true,
          appDeletionJobId: context.data.appDeletionJobId,
          appId: context.data.appId,
          resourceId: context.data.resourceId,
          resourceDigest: context.data.resourceDigest,
          kind: "database",
        },
        result_storage: "inline",
        result_key: null,
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(eq(jobs.id, context.job.id))
      .returning({ id: jobs.id });
    if (!confirmed)
      throw new AppDeletionRecoveryPendingError("Database deletion receipt was not persisted");
  });
}
