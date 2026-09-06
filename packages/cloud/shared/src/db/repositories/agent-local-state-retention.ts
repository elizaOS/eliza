/**
 * Admits local-state retention under the payment stop's primary lifecycle and
 * execution lease. Retention commits before provider effects; retries preserve
 * the captured container identity and carry only their own revision change.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "../../lib/services/eliza-provision-lock";
import type { DbTransaction } from "../client";
import { agentComputeStopIntents } from "../schemas/agent-compute-stop-intents";
import {
  type AgentLocalStateRetention,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import { jobs } from "../schemas/jobs";
import { agentBillingRepository } from "./agent-billing";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const locatorSchema = z
  .object({
    version: z.literal(1),
    stopIntentId: z.string().uuid(),
    nodeId: z.string().min(1),
    nodeRecordId: z.string().uuid(),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    containerName: z.string().min(1),
    agentId: z.string().uuid(),
    hostname: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535),
    sshUser: z.string().min(1),
    hostKeyFingerprint: z.string().min(1),
    capturedAt: z.string().datetime(),
    bridgeUrl: z.string().url().nullable(),
    healthUrl: z.string().url().nullable(),
    state: z.literal("stop_pending"),
  })
  .strict();

export interface PaymentLocalRetentionAuthority {
  agentId: string;
  organizationId: string;
  jobId: string;
  executionGeneration: string;
  executionOwnerId: string;
}

/** The supplied transaction must commit before any retained stop is sent. */
export async function admitPaymentLocalRetentionInTransaction(
  tx: DbTransaction,
  authority: PaymentLocalRetentionAuthority,
  captured: AgentLocalStateRetention,
): Promise<{ kind: "funded" } | { kind: "retained"; retention: AgentLocalStateRetention }> {
  const parsed = locatorSchema.safeParse(captured);
  if (!parsed.success || captured.agentId !== authority.agentId) {
    throw new ElizaError("Local retention requires a complete captured agent locator", {
      code: "AGENT_LOCAL_RETENTION_LOCATOR_INVALID",
    });
  }
  await configureElizaLifecycleTransaction(tx);
  await tx.execute(elizaProvisionAdvisoryLockSql(authority.organizationId, authority.agentId));
  const [agent] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, authority.agentId),
        eq(agentSandboxes.organization_id, authority.organizationId),
        eq(agentSandboxes.lifecycle_job_id, authority.jobId),
        eq(agentSandboxes.lifecycle_execution_generation, authority.executionGeneration),
        isNull(agentSandboxes.deletion_attempt_id),
        isNull(agentSandboxes.deletion_started_at),
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.pool_status),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        inArray(agentSandboxes.status, ["running", "disconnected", "error", "stopped"]),
      ),
    )
    .for("update")
    .limit(1);
  const [intent] = await tx
    .select()
    .from(agentComputeStopIntents)
    .where(
      and(
        eq(agentComputeStopIntents.id, captured.stopIntentId),
        eq(agentComputeStopIntents.agent_id, authority.agentId),
        eq(agentComputeStopIntents.organization_id, authority.organizationId),
        eq(agentComputeStopIntents.job_id, authority.jobId),
        eq(agentComputeStopIntents.authorization, "billing_request"),
        inArray(agentComputeStopIntents.status, [
          "pending",
          "dispatching",
          "retry",
          "terminal_attention",
        ]),
      ),
    )
    .for("update")
    .limit(1);
  const [execution] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, authority.jobId),
        eq(jobs.type, "agent_suspend"),
        eq(jobs.status, "in_progress"),
        eq(jobs.agent_id, authority.agentId),
        eq(jobs.organization_id, authority.organizationId),
        eq(jobs.execution_generation, authority.executionGeneration),
        isNull(jobs.execution_quiesced_at),
        sql`EXISTS (SELECT 1 FROM ${jobExecutionLeases}
      WHERE job_id = ${authority.jobId} AND execution_generation = ${authority.executionGeneration}
        AND owner_id = ${authority.executionOwnerId} AND expires_at > clock_timestamp())`,
      ),
    )
    .limit(1);
  if (
    !agent ||
    !intent ||
    !execution ||
    agent.lifecycle_revision !== intent.lifecycle_revision ||
    agent.replacement_cleanup_sandbox_id ||
    agent.replacement_cleanup_attempt_id ||
    agent.replacement_cleanup_container_id
  ) {
    throw new ElizaError("Payment stop no longer owns local retention admission", {
      code: "AGENT_LOCAL_RETENTION_AUTHORITY_CHANGED",
      context: { agentId: authority.agentId, jobId: authority.jobId },
    });
  }
  if (agent.local_state_retention) {
    const existing = agent.local_state_retention;
    if (
      (existing.stopIntentId !== captured.stopIntentId && existing.state !== "resumed") ||
      existing.containerId !== captured.containerId ||
      existing.nodeRecordId !== captured.nodeRecordId ||
      existing.nodeId !== captured.nodeId ||
      existing.containerName !== captured.containerName
    ) {
      throw new ElizaError("Existing local state retention cannot be replaced by another locator", {
        code: "AGENT_LOCAL_RETENTION_ALREADY_OWNED",
      });
    }
    const funding = await agentBillingRepository.settlePaymentResumeFundingInTransaction(
      tx,
      authority.agentId,
      authority.organizationId,
      await readPostLockDatabaseNow(tx),
    );
    if (funding === "funded") return { kind: "funded" };
    if (existing.state === "resumed") {
      if (agent.node_id !== existing.nodeId || agent.container_name !== existing.containerName) {
        throw new ElizaError("Resumed local state no longer matches the active placement", {
          code: "AGENT_LOCAL_RETENTION_PLACEMENT_CHANGED",
        });
      }
      // Only operation ownership changes. Never replace the retained host,
      // credentials, endpoint or physical identity with a later caller's data.
      const transferred: AgentLocalStateRetention = {
        ...existing,
        stopIntentId: intent.id,
        state: "stop_pending",
      };
      const [row] = await tx
        .update(agentSandboxes)
        .set({ local_state_retention: transferred })
        .where(
          and(
            eq(agentSandboxes.id, authority.agentId),
            eq(agentSandboxes.organization_id, authority.organizationId),
          ),
        )
        .returning({ revision: sql<string>`${agentSandboxes.lifecycle_revision}::text` });
      if (!row)
        throw new ElizaError("Retained ownership transfer lost its agent", {
          code: "AGENT_LOCAL_RETENTION_WRITE_LOST",
        });
      await tx
        .update(agentComputeStopIntents)
        .set({ lifecycle_revision: sql`${row.revision}::bigint` })
        .where(eq(agentComputeStopIntents.id, intent.id));
      return { kind: "retained", retention: transferred };
    }
    return { kind: "retained", retention: existing };
  }
  if (agent.node_id !== captured.nodeId || agent.container_name !== captured.containerName) {
    throw new ElizaError("Captured local state is no longer the agent's canonical container", {
      code: "AGENT_LOCAL_RETENTION_PLACEMENT_CHANGED",
    });
  }
  const [node] = await tx
    .select({ id: dockerNodes.id })
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, captured.nodeRecordId),
        eq(dockerNodes.node_id, captured.nodeId),
        eq(dockerNodes.hostname, captured.hostname),
        eq(dockerNodes.ssh_port, captured.sshPort),
        eq(dockerNodes.ssh_user, captured.sshUser),
        eq(dockerNodes.host_key_fingerprint, captured.hostKeyFingerprint),
      ),
    )
    .for("update")
    .limit(1);
  if (!node)
    throw new ElizaError("Captured local-state node authority changed", {
      code: "AGENT_LOCAL_RETENTION_NODE_CHANGED",
    });
  const funding = await agentBillingRepository.settlePaymentResumeFundingInTransaction(
    tx,
    authority.agentId,
    authority.organizationId,
    await readPostLockDatabaseNow(tx),
  );
  if (funding === "funded") return { kind: "funded" };
  const [retained] = await tx
    .update(agentSandboxes)
    .set({ local_state_retention: parsed.data })
    .where(
      and(
        eq(agentSandboxes.id, authority.agentId),
        eq(agentSandboxes.organization_id, authority.organizationId),
      ),
    )
    .returning({ revision: sql<string>`${agentSandboxes.lifecycle_revision}::text` });
  if (!retained)
    throw new ElizaError("Local retention write lost its agent", {
      code: "AGENT_LOCAL_RETENTION_WRITE_LOST",
    });
  await tx
    .update(agentComputeStopIntents)
    .set({ lifecycle_revision: sql`${retained.revision}::bigint` })
    .where(eq(agentComputeStopIntents.id, intent.id));
  return { kind: "retained", retention: parsed.data };
}

/** Publication must not follow a mutable node mapping away from retained state. */
export async function assertRetainedNodePublicationAuthorityInTransaction(
  tx: DbTransaction,
  retention: AgentLocalStateRetention,
): Promise<void> {
  const [node] = await tx
    .select({ id: dockerNodes.id })
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, retention.nodeRecordId),
        eq(dockerNodes.node_id, retention.nodeId),
        eq(dockerNodes.hostname, retention.hostname),
        eq(dockerNodes.ssh_port, retention.sshPort),
        eq(dockerNodes.ssh_user, retention.sshUser),
        eq(dockerNodes.host_key_fingerprint, retention.hostKeyFingerprint),
      ),
    )
    .for("share")
    .limit(1);
  if (!node)
    throw new ElizaError("Retained node authority changed before publication", {
      code: "AGENT_LOCAL_RETENTION_NODE_PUBLICATION_CHANGED",
      context: { nodeRecordId: retention.nodeRecordId, agentId: retention.agentId },
    });
}
