/**
 * Atomically creates or rejoins the dedicated target for a shared-agent tier
 * upgrade. The route consumes this narrow persistence boundary so target
 * identity, quota enforcement, and concurrent request convergence share one
 * transaction without broadening the general sandbox lifecycle service.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { type AgentSandbox, type AgentSandboxStatus } from "../../db/repositories/agent-sandboxes";
import { jobsRepository } from "../../db/repositories/jobs";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import {
  AGENT_UPGRADED_FROM_KEY,
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "./eliza-agent-config";
import { elizaAgentTierUpgradeAdvisoryLockSql } from "./eliza-provision-lock";
import { AgentQuotaExceededError } from "./eliza-sandbox";
import { JOB_TYPES } from "./provisioning-job-types";

const LIVE_TARGET_STATUSES: AgentSandboxStatus[] = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
];

export interface CreateTierUpgradeTargetParams {
  sourceAgentId: string;
  organizationId: string;
  userId: string;
  agentName: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  characterId?: string;
  maxNonTerminalAgents: number;
}

export async function createTierUpgradeTarget(
  params: CreateTierUpgradeTargetParams,
): Promise<{ agent: AgentSandbox; idempotent: boolean }> {
  const environmentVars = params.environmentVars
    ? await encryptAgentEnvVarsForStorage(params.organizationId, params.environmentVars)
    : {};
  const sanitizedConfig = stripReservedElizaConfigKeys(params.agentConfig);
  const agentConfig = params.characterId
    ? withReusedElizaCharacterOwnership(sanitizedConfig)
    : sanitizedConfig;

  return dbWrite.transaction(async (tx) => {
    await tx.execute(
      elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
    );

    const [existing] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, params.organizationId),
          eq(agentSandboxes.execution_tier, "dedicated-always"),
          inArray(agentSandboxes.status, LIVE_TARGET_STATUSES),
          sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY} = ${params.sourceAgentId}`,
        ),
      )
      .orderBy(desc(agentSandboxes.created_at))
      .limit(1);
    if (existing) return { agent: existing, idempotent: true };

    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, params.organizationId),
          sql`${agentSandboxes.pool_status} IS NULL`,
          inArray(agentSandboxes.status, LIVE_TARGET_STATUSES),
        ),
      );
    if (count >= params.maxNonTerminalAgents) {
      throw new AgentQuotaExceededError(count, params.maxNonTerminalAgents);
    }

    const [created] = await tx
      .insert(agentSandboxes)
      .values({
        organization_id: params.organizationId,
        user_id: params.userId,
        agent_name: params.agentName,
        agent_config: {
          ...agentConfig,
          [AGENT_UPGRADED_FROM_KEY]: params.sourceAgentId,
        },
        environment_vars: environmentVars,
        execution_tier: "dedicated-always",
        status: "pending",
        database_status: "none",
        ...(params.characterId ? { character_id: params.characterId } : {}),
      })
      .returning();
    if (!created) throw new Error("Failed to create tier-upgrade target");
    return { agent: created, idempotent: false };
  });
}

/** Returns the active provision job created by a winning concurrent request. */
export async function findActiveTierUpgradeProvisionJob(agentId: string, organizationId: string) {
  const jobs = await jobsRepository.findByDataFieldForWrite({
    type: JOB_TYPES.AGENT_PROVISION,
    organizationId,
    dataField: "agentId",
    dataValue: agentId,
    orderBy: "desc",
  });
  return jobs.find((job) => job.status === "pending" || job.status === "in_progress");
}
