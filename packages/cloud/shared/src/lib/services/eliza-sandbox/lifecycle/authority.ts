/** Owns sandbox lifecycle locking, canonical row admission, and competing-job checks. Every operation uses the exact transaction supplied by the lifecycle caller. */

import { and, eq, inArray, sql } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import {
  type AgentSandbox,
  type AgentSandboxStatus,
} from "../../../../db/repositories/agent-sandboxes";
import { agentSandboxes } from "../../../../db/schemas/agent-sandboxes";
import { jobs } from "../../../../db/schemas/jobs";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "../../eliza-provision-lock";
import { EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES, JOB_TYPES } from "../../provisioning-job-types";
import {
  ContainerBackedServiceAction,
  containerBackedServiceRejection,
  PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES,
} from "./policy.js";
import { LifecycleTx } from "./transaction.js";
export class SandboxLifecycleAuthority {
  /**
   * A row in `deletion_pending` / `deletion_failed` is logically gone — an
   * agent_delete job owns it. Bringing it back up (resume / wake / restart)
   * would resurrect a container we are tearing down, so these states are
   * treated exactly like a missing row: the daemon handler maps "Agent not
   * found" to a terminal no-op instead of resurrecting the agent.
   */
  isAwaitingDeletion(status: AgentSandboxStatus): boolean {
    return status === "deletion_pending" || status === "deletion_failed";
  }

  async lockLifecycle(tx: LifecycleTx, agentId: string, orgId: string): Promise<void> {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(orgId, agentId));
  }

  /**
   * Short authoritative checkpoint before an unlocked backup/probe read. It
   * does not pretend to make PostgreSQL and a remote provider atomic; durable
   * writes still repeat the allowlist under their final lifecycle row lock.
   */
  async revalidateContainerBackedLifecycleGeneration(
    expected: AgentSandbox,
    action: ContainerBackedServiceAction,
  ): Promise<AgentSandbox | undefined> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, expected.id, expected.organization_id);
      const current = await this.getAgentForLifecycleMutation(
        tx,
        expected.id,
        expected.organization_id,
      );
      if (!current) return undefined;
      if (containerBackedServiceRejection(current, action)) return undefined;
      return current.execution_tier === expected.execution_tier &&
        current.status === expected.status &&
        current.sandbox_id === expected.sandbox_id &&
        current.node_id === expected.node_id &&
        current.container_name === expected.container_name &&
        current.bridge_url === expected.bridge_url &&
        current.health_url === expected.health_url &&
        current.environment_revision === expected.environment_revision &&
        current.lifecycle_revision === expected.lifecycle_revision
        ? current
        : undefined;
    });
  }

  async isReplacementCleanupSweepEligibleTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ eligible: boolean }>(sql`
      SELECT (
        replacement_cleanup_attempt_id IS NULL
        OR replacement_cleanup_created_at <=
          NOW() - (${PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES} * INTERVAL '1 minute')
      ) AS eligible
      FROM ${agentSandboxes}
      WHERE id = ${agentId}
        AND organization_id = ${orgId}
      LIMIT 1
    `);
    return result.rows[0]?.eligible === true;
  }

  async hasActiveExclusiveLifecycleJobTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE ${jobs.organization_id} = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND ${jobs.status} IN ('pending', 'in_progress')
        AND ${inArray(jobs.type, EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES)}
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async getAgentForLifecycleMutation(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<AgentSandbox | undefined> {
    // The typed builder maps timestamp columns to Dates before lifecycle code
    // consumes them; the row lock and lifecycle_revision provide ownership.
    const [row] = await tx
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)))
      .for("update")
      .limit(1);
    return row;
  }

  async hasActiveProvisionJobTx(tx: LifecycleTx, agentId: string, orgId: string): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type = ${JOB_TYPES.AGENT_PROVISION}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status IN ('pending', 'in_progress')
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  /**
   * Sleep must not interleave with a queued operation that can install a new
   * compute generation after the sleep snapshot but before its strict stop.
   * The sleep job itself is deliberately absent from this set.
   */
  async hasActiveReplacementJobTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type IN (
        'agent_provision',
        'agent_resume',
        'agent_wake',
        'agent_restart',
        'agent_upgrade',
        'agent_downgrade',
        'agent_admin_canary_image'
      )
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status IN ('pending', 'in_progress')
      LIMIT 1
    `);
    return result.rows.length > 0;
  }
}
