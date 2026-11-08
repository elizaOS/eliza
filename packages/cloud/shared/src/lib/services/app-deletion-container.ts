/** Reuse the container executor, with the original app-deletion target fenced. */
import { and, eq, sql } from "drizzle-orm";
import { withAppDeletionChildExecution } from "../../db/repositories/app-deletion-execution";
import { assertJobExecutionAuthority } from "../../db/repositories/job-execution-authority";
import { containers } from "../../db/schemas/containers";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { jobs } from "../../db/schemas/jobs";
import { AppDeletionRecoveryPendingError, appDeletionDigest } from "./app-deletion-authority";
import { type ContainerExecutorDeps, executeContainerDelete } from "./container-job-executors";
import type { JobExecutionAuthority } from "./job-execution-authority";

export async function readOriginalDeletionContainer(authority: JobExecutionAuthority) {
  return withAppDeletionChildExecution(authority, async (tx, context) => {
    if (context.data.kind !== "container")
      throw new AppDeletionRecoveryPendingError("Deletion child is not a container");
    if (context.alreadyConfirmed || context.job.result?.appDeletionConfirmed === true) return null;
    const [row] = await tx
      .select()
      .from(containers)
      .where(
        and(
          eq(containers.id, context.data.resourceId),
          eq(containers.organization_id, context.data.organizationId),
        ),
      )
      .for("update");
    const [node] = await tx
      .select({ hostname: dockerNodes.hostname })
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, context.data.originalNodeId!));
    await assertJobExecutionAuthority(tx, authority);
    if (
      !node ||
      node.hostname !== context.data.originalNodeHost ||
      !row ||
      row.project_name !== context.data.appId ||
      row.node_id !== context.data.originalNodeId ||
      row.metadata?.hostname !== context.data.originalNodeHost ||
      row.metadata?.hostContainerId !== context.data.originalHostContainerId ||
      appDeletionDigest([
        row.id,
        row.project_name,
        row.node_id,
        context.data.originalNodeHost!,
        context.data.originalHostContainerId!,
      ]) !== context.data.resourceDigest
    )
      throw new AppDeletionRecoveryPendingError("Original container provider identity changed");
    return { job: context.job, data: context.data };
  });
}

export async function dispatchAppDeletionContainer(
  authority: JobExecutionAuthority,
  deps: ContainerExecutorDeps,
): Promise<void> {
  const original = await readOriginalDeletionContainer(authority);
  if (!original) return;
  if (deps.provider.targetNodeId !== original.data.originalNodeId)
    throw new AppDeletionRecoveryPendingError("Container backend does not own the original node");
  await executeContainerDelete(original.job, {
    ...deps,
    assertExecutionCurrent: async () => {
      if (!(await readOriginalDeletionContainer(authority)))
        throw new AppDeletionRecoveryPendingError("Original container already settled");
      await deps.assertExecutionCurrent?.();
    },
  });
  await withAppDeletionChildExecution(authority, async (tx, context) => {
    if (context.alreadyConfirmed || context.job.result?.appDeletionConfirmed === true) return;
    const [row] = await tx
      .select()
      .from(containers)
      .where(
        and(
          eq(containers.id, context.data.resourceId),
          eq(containers.organization_id, context.data.organizationId),
        ),
      )
      .for("update");
    await assertJobExecutionAuthority(tx, authority);
    if (
      !row ||
      row.status !== "deleted" ||
      row.node_id !== context.data.originalNodeId ||
      row.metadata?.hostContainerId !== context.data.originalHostContainerId
    )
      throw new AppDeletionRecoveryPendingError(
        "Original container removal has no terminal receipt",
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
          kind: "container",
        },
        result_storage: "inline",
        result_key: null,
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(eq(jobs.id, context.job.id))
      .returning({ id: jobs.id });
    if (!confirmed)
      throw new AppDeletionRecoveryPendingError("Container deletion receipt was not persisted");
  });
}
