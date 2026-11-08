import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  AppDeletionRecoveryPendingError,
  readAppDeletionPlan,
} from "../../lib/services/app-deletion-authority";
import type { DbTransaction } from "../client";
import { appDatabases } from "../schemas/app-databases";
import { containers } from "../schemas/containers";
import { jobs } from "../schemas/jobs";
import { managedDomains } from "../schemas/managed-domains";
import { secretBindings } from "../schemas/secrets";
import type { AppDeletionExecutionContext } from "./app-deletion-execution";

/** Completed immutable child receipts are read without locking children after
 * the app: child execution uses child->app, so reversing it would deadlock. */
export async function assertAppDeletionReady(
  tx: DbTransaction,
  context: AppDeletionExecutionContext,
): Promise<string[]> {
  const plan = readAppDeletionPlan(context.job.result);
  if (!plan) throw new AppDeletionRecoveryPendingError("Original resource plan is unavailable");
  const childRows = plan.length
    ? await tx
        .select()
        .from(jobs)
        .where(
          inArray(
            jobs.id,
            plan.map((item) => item.jobId),
          ),
        )
    : [];
  for (const item of plan) {
    const child = childRows.find((row) => row.id === item.jobId);
    const result = child?.result;
    if (
      !child ||
      child.organization_id !== context.data.organizationId ||
      child.status !== "completed" ||
      child.execution_quiesced_at === null ||
      child.result_storage !== "inline" ||
      result?.appDeletionConfirmed !== true ||
      result.appDeletionJobId !== context.job.id ||
      result.appId !== context.data.appId ||
      result.resourceId !== item.resourceId ||
      result.resourceDigest !== item.digest ||
      result.kind !== item.kind
    )
      throw new AppDeletionRecoveryPendingError(
        "Original resource teardown is not confirmed and quiescent",
        { jobId: item.jobId },
      );
  }
  const [unresolved] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, context.data.organizationId),
        inArray(jobs.type, [
          "app_deploy",
          "app_db_deprovision",
          "container_provision",
          "container_restart",
          "container_upgrade",
          "container_delete",
        ]),
        or(
          inArray(jobs.status, ["pending", "in_progress"]),
          and(isNotNull(jobs.execution_generation), isNull(jobs.execution_quiesced_at)),
        ),
        or(
          sql`${jobs.data}->>'appId' = ${context.data.appId}`,
          ne(jobs.data_storage, "inline"),
          sql`(${jobs.data}->>'appId' IS NULL AND ${jobs.data}->>'containerId' IS NULL)`,
        ),
      ),
    )
    .limit(1);
  if (unresolved)
    throw new AppDeletionRecoveryPendingError("App execution remains unresolved", {
      jobId: unresolved.id,
    });
  const [liveContainer] = await tx
    .select({ id: containers.id })
    .from(containers)
    .where(
      and(
        eq(containers.organization_id, context.data.organizationId),
        eq(containers.project_name, context.data.appId),
        ne(containers.status, "deleted"),
      ),
    )
    .limit(1);
  if (liveContainer) throw new AppDeletionRecoveryPendingError("App container is still live");
  const [database] = await tx
    .select()
    .from(appDatabases)
    .where(eq(appDatabases.app_id, context.data.appId));
  if (
    database &&
    (database.user_database_uri ||
      database.tenant_db_cluster_id ||
      database.user_database_status === "provisioning")
  )
    throw new AppDeletionRecoveryPendingError("App database teardown remains unresolved");
  if (context.job.result?.githubRequired === true) {
    const github = context.job.result.githubDeletion as Record<string, unknown> | undefined;
    if (github?.confirmed !== true)
      throw new AppDeletionRecoveryPendingError("Original repository deletion is unconfirmed");
  } else if (context.job.result?.githubRequired !== false)
    throw new AppDeletionRecoveryPendingError("Repository cleanup decision is missing");
  return plan.map((item) => item.jobId);
}

/** Metadata cleanup shares the acknowledged final cascade transaction. */
export async function removeAppDeletionMetadata(tx: DbTransaction, appId: string): Promise<void> {
  await tx
    .delete(secretBindings)
    .where(and(eq(secretBindings.project_id, appId), eq(secretBindings.project_type, "app")));
  await tx
    .update(managedDomains)
    .set({ appId: null, resourceType: null, updatedAt: sql`clock_timestamp() AT TIME ZONE 'UTC'` })
    .where(eq(managedDomains.appId, appId));
}
