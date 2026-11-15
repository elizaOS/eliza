/** Freeze complete original resource identities in existing child jobs before teardown. */
import { and, eq, sql } from "drizzle-orm";
import {
  type AppDeletionChildData,
  type AppDeletionChildIdentity,
  AppDeletionRecoveryPendingError,
  appDeletionChildId,
  appDeletionDigest,
  readAppDeletionChildData,
  readAppDeletionPlan,
} from "../../lib/services/app-deletion-authority";
import type { JobExecutionAuthority } from "../../lib/services/job-execution-authority";
import { appDatabases } from "../schemas/app-databases";
import { containers } from "../schemas/containers";
import { dockerNodes } from "../schemas/docker-nodes";
import { jobs } from "../schemas/jobs";
import { withAppDeletionExecution } from "./app-deletion-execution";
import { assertJobExecutionAuthority } from "./job-execution-authority";
import { jobsRepository, prepareJobInsertData } from "./jobs";

export async function prepareAppDeletionPlan(
  authority: JobExecutionAuthority,
): Promise<AppDeletionChildIdentity[]> {
  // Hydration may read object storage, so it happens outside all row locks.
  const candidates = await jobsRepository.findUnsettledAppDeletionCandidates(
    authority.organizationId,
  );
  return withAppDeletionExecution(authority, async (tx, context) => {
    if (context.job.result?.revocationsConfirmed !== true)
      throw new AppDeletionRecoveryPendingError(
        "Original credential revocation delivery is not confirmed",
      );
    const saved = readAppDeletionPlan(context.job.result);
    if (saved) return saved;
    if (!context.app)
      throw new AppDeletionRecoveryPendingError("Deleted app has no original resource plan");
    // A legacy "deleted" status alone is not provider evidence. Include its
    // original immutable target too; the child confirms absence on that host.
    const rows = await tx
      .select()
      .from(containers)
      .where(
        and(
          eq(containers.organization_id, authority.organizationId),
          eq(containers.project_name, context.data.appId),
        ),
      )
      .orderBy(containers.id)
      .for("update");
    const containerIds = new Set(rows.map((row) => row.id));
    for (const candidate of candidates) {
      if (candidate.data.appDeletionJobId === context.job.id) continue;
      if (
        candidate.data.appId === context.data.appId ||
        (typeof candidate.data.containerId === "string" &&
          containerIds.has(candidate.data.containerId))
      ) {
        throw new AppDeletionRecoveryPendingError("Original app execution has not quiesced", {
          jobId: candidate.id,
        });
      }
      if (
        typeof candidate.data.appId !== "string" &&
        typeof candidate.data.containerId !== "string"
      ) {
        throw new AppDeletionRecoveryPendingError(
          "An organization job has no attributable original app identity",
          { jobId: candidate.id },
        );
      }
    }
    const [database] = await tx
      .select()
      .from(appDatabases)
      .where(eq(appDatabases.app_id, context.data.appId))
      .for("update");
    if (database?.user_database_status === "provisioning")
      throw new AppDeletionRecoveryPendingError("Original app database provisioning is unresolved");
    const children: Array<{ id: string; type: string; data: AppDeletionChildData }> = [];
    if (database?.user_database_uri || database?.tenant_db_cluster_id) {
      if (!database.user_database_uri || !database.tenant_db_cluster_id)
        throw new AppDeletionRecoveryPendingError(
          "Legacy app database has no complete original placement",
        );
      const digest = appDeletionDigest([
        database.id,
        context.data.appId,
        database.user_database_uri,
        database.tenant_db_cluster_id,
      ]);
      children.push({
        id: appDeletionChildId(context.job.id, "database", database.id),
        type: "app_db_deprovision",
        data: {
          version: 1,
          appId: context.data.appId,
          organizationId: authority.organizationId,
          appDeletionJobId: context.job.id,
          kind: "database",
          resourceId: database.id,
          resourceDigest: digest,
          originalClusterId: database.tenant_db_cluster_id,
        },
      });
    }
    for (const row of rows) {
      const hostId = row.metadata?.hostContainerId;
      const nodeHost = row.metadata?.hostname;
      if (
        typeof hostId !== "string" ||
        !hostId ||
        !row.node_id ||
        typeof nodeHost !== "string" ||
        !nodeHost
      ) {
        throw new AppDeletionRecoveryPendingError("Container provider identity is unresolved", {
          containerId: row.id,
        });
      }
      const [node] = await tx
        .select({ hostname: dockerNodes.hostname })
        .from(dockerNodes)
        .where(eq(dockerNodes.node_id, row.node_id));
      if (!node || node.hostname !== nodeHost)
        throw new AppDeletionRecoveryPendingError(
          "Original container host is not the registered node",
          { containerId: row.id },
        );
      const digest = appDeletionDigest([row.id, context.data.appId, row.node_id, nodeHost, hostId]);
      children.push({
        id: appDeletionChildId(context.job.id, "container", row.id),
        type: "container_delete",
        data: {
          version: 1,
          appId: context.data.appId,
          organizationId: authority.organizationId,
          appDeletionJobId: context.job.id,
          kind: "container",
          resourceId: row.id,
          resourceDigest: digest,
          containerId: row.id,
          originalHostContainerId: hostId,
          originalNodeId: row.node_id,
          originalNodeHost: nodeHost,
        },
      });
    }
    const plan: AppDeletionChildIdentity[] = [];
    for (const child of children) {
      const prepared = await prepareJobInsertData({
        id: child.id,
        type: child.type,
        organization_id: authority.organizationId,
        user_id: context.job.user_id,
        data: { ...child.data },
        data_storage: "inline",
      });
      const [created] = await tx
        .insert(jobs)
        .values({
          ...prepared,
          created_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
          updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
          scheduled_for: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
        })
        .onConflictDoNothing({ target: jobs.id })
        .returning();
      const [existing] = created
        ? [created]
        : await tx.select().from(jobs).where(eq(jobs.id, child.id));
      const original = existing && readAppDeletionChildData(existing.data);
      if (
        !existing ||
        existing.type !== child.type ||
        existing.organization_id !== authority.organizationId ||
        existing.data_storage !== "inline" ||
        !original ||
        original.appDeletionJobId !== context.job.id ||
        original.resourceId !== child.data.resourceId ||
        original.resourceDigest !== child.data.resourceDigest
      )
        throw new AppDeletionRecoveryPendingError(
          "Deterministic deletion child identity conflicts",
          { jobId: child.id },
        );
      plan.push({
        jobId: child.id,
        kind: child.data.kind,
        resourceId: child.data.resourceId,
        digest: child.data.resourceDigest,
      });
    }
    await assertJobExecutionAuthority(tx, authority);
    const [published] = await tx
      .update(jobs)
      .set({
        result: {
          ...context.job.result,
          appId: context.data.appId,
          deletionJobId: context.job.id,
          deletionPlan: plan,
          originalGitHubRepo: context.app.github_repo,
          githubRequired: context.data.deleteGitHubRepo && Boolean(context.app.github_repo),
        },
        result_storage: "inline",
        result_key: null,
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(eq(jobs.id, context.job.id))
      .returning({ id: jobs.id });
    if (!published)
      throw new AppDeletionRecoveryPendingError("Original resource plan was not persisted");
    return plan;
  });
}
