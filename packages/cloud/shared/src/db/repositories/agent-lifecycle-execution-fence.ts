/** Keeps a stop intent current across its own worker ownership bookkeeping. */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { agentComputeStopIntents } from "../schemas/agent-compute-stop-intents";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import type { Job } from "../schemas/jobs";

/** Caller holds the lifecycle lock and has validated the job's execution lease. */
export async function updateAgentLifecycleExecutionFence(
  tx: DbTransaction,
  job: Pick<Job, "id" | "type" | "organization_id" | "agent_id">,
  executionGeneration: string,
  action: "claim" | "release",
): Promise<{ id: string } | undefined> {
  if (!job.agent_id) throw new Error("Lifecycle execution has no agent identity");
  const identity = and(
    eq(agentSandboxes.id, job.agent_id),
    eq(agentSandboxes.organization_id, job.organization_id),
  );
  const [before] = await tx
    .select({
      id: agentSandboxes.id,
      revision: agentSandboxes.lifecycle_revision,
      jobId: agentSandboxes.lifecycle_job_id,
      generation: agentSandboxes.lifecycle_execution_generation,
    })
    .from(agentSandboxes)
    .where(identity)
    .for("update")
    .limit(1);
  if (!before) return undefined;
  if (action === "claim" && before.jobId === job.id && before.generation === executionGeneration) {
    return { id: before.id };
  }
  const owned = and(
    eq(agentSandboxes.lifecycle_job_id, job.id),
    eq(agentSandboxes.lifecycle_execution_generation, executionGeneration),
  );
  const [updated] = await tx
    .update(agentSandboxes)
    .set({
      lifecycle_job_id: action === "claim" ? job.id : null,
      lifecycle_execution_generation: action === "claim" ? executionGeneration : null,
    })
    .where(
      and(
        identity,
        action === "claim"
          ? or(isNull(agentSandboxes.lifecycle_execution_generation), owned)
          : owned,
      ),
    )
    .returning({ id: agentSandboxes.id, revision: agentSandboxes.lifecycle_revision });
  if (!updated) return undefined;
  if (job.type === "agent_suspend" && updated.revision !== before.revision) {
    if (updated.revision !== before.revision + 1) {
      throw new Error("Lifecycle execution bookkeeping advanced an unexpected revision");
    }
    // This transaction changes only the two execution-owner columns. Carry
    // forward an intent that matched BEFORE that write; an already stale
    // intent must remain stale. Include release so a retry keeps its authority.
    await tx
      .update(agentComputeStopIntents)
      .set({
        lifecycle_revision: updated.revision,
        updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentComputeStopIntents.agent_id, job.agent_id),
          eq(agentComputeStopIntents.organization_id, job.organization_id),
          eq(agentComputeStopIntents.job_id, job.id),
          eq(agentComputeStopIntents.lifecycle_revision, before.revision),
          inArray(agentComputeStopIntents.status, [
            "pending",
            "dispatching",
            "retry",
            "terminal_attention",
          ]),
        ),
      );
  }
  return { id: updated.id };
}
