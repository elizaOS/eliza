import { and, eq, inArray, ne, sql } from "drizzle-orm";
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
import {
  type AppDeletionQuiescenceCandidate,
  readUnsettledAppDeletionRows,
} from "./app-deletion-quiescence";

/** Completed immutable child receipts are read without locking children after
 * the app: child execution uses child->app, so reversing it would deadlock. */
export async function assertAppDeletionReady(
  tx: DbTransaction,
  context: AppDeletionExecutionContext,
  candidates: AppDeletionQuiescenceCandidate[],
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
  const childById = new Map(childRows.map((row) => [row.id, row]));
  for (const item of plan) {
    const child = childById.get(item.jobId);
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
  const current = await readUnsettledAppDeletionRows(tx, context.data.organizationId);
  const ownContainerIds = new Set(
    plan.filter((item) => item.kind === "container").map((item) => item.resourceId),
  );
  const byId = new Map(candidates.map((candidate) => [candidate.raw.id, candidate]));
  for (const row of current) {
    const original = byId.get(row.job.id);
    if (
      !original ||
      row.revision !== original.revision ||
      row.job.data_storage !== original.raw.data_storage ||
      row.job.data_key !== original.raw.data_key ||
      JSON.stringify(row.job.data) !== JSON.stringify(original.raw.data)
    )
      throw new AppDeletionRecoveryPendingError(
        "Job target changed during deletion quiescence check",
        { jobId: row.job.id },
      );
    const target = original.restored.data;
    if (typeof target.appId === "string") {
      if (target.appId === context.data.appId)
        throw new AppDeletionRecoveryPendingError("App execution remains unresolved", {
          jobId: row.job.id,
        });
      continue;
    }
    if (typeof target.containerId !== "string" || ownContainerIds.has(target.containerId))
      throw new AppDeletionRecoveryPendingError("App execution remains unresolved", {
        jobId: row.job.id,
      });
    const [container] = await tx
      .select({ appId: containers.project_name })
      .from(containers)
      .where(
        and(
          eq(containers.id, target.containerId),
          eq(containers.organization_id, context.data.organizationId),
        ),
      );
    if (!container || container.appId === context.data.appId)
      throw new AppDeletionRecoveryPendingError(
        "Container job target is not known to be another app",
        { jobId: row.job.id },
      );
  }
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
  const [binding] = await tx
    .select({ id: secretBindings.id })
    .from(secretBindings)
    .where(and(eq(secretBindings.project_id, appId), eq(secretBindings.project_type, "app")))
    .limit(1);
  const [domain] = await tx
    .select({ id: managedDomains.id })
    .from(managedDomains)
    .where(eq(managedDomains.appId, appId))
    .limit(1);
  if (binding || domain)
    throw new AppDeletionRecoveryPendingError("App metadata cleanup was not persisted");
}
