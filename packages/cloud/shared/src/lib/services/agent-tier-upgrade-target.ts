/**
 * Single-flight mint of the dedicated target for a shared-agent tier upgrade
 * (#15355, hardened in #15943). One boundary owns the WHOLE span — managed
 * credential minting, environment preparation, target insertion, and the
 * provision-job enqueue — so concurrent upgrade requests for one source agent
 * converge on exactly one target, one prepared environment, and one job.
 *
 * The invariant that makes the compensation problem disappear: the target row
 * and its provision job commit in ONE transaction under the per-source
 * advisory lock. A failure anywhere in that transaction rolls back the target
 * with the job, so there is never a committed target awaiting an enqueue that
 * a cleanup path might delete out from under a live job — the delete path
 * simply does not exist. Conversely every committed target is born with its
 * full managed environment and an active provision job, so reattaching
 * callers only ever read durable state; they never prepare credentials or
 * write environment state of their own.
 *
 * Credential minting (the agent API key) cannot run inside the transaction:
 * it goes through the api-keys service on its own connection, and against
 * single-session PGlite a nested query would deadlock the open transaction.
 * So preparation happens UNLOCKED against a pre-generated target id, and the
 * locked transaction re-checks for a competing target before making anything
 * durable. Two near-simultaneous fresh requests may therefore each mint a
 * candidate key, but each key is bound to its caller's own prospective id —
 * the loser's key never touches any row and is revoked on the spot, so the
 * durable end state is always exactly one credential set for the one target.
 *
 * Consumed only by the upgrade-tier route (cloud/api), which resolves quota
 * and identity-copy inputs before calling in.
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import type { AgentSandbox, AgentSandboxStatus } from "../../db/repositories/agent-sandboxes";
import type { Job } from "../../db/repositories/jobs";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { logger } from "../utils/logger";
import { encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import { apiKeysService } from "./api-keys";
import { AGENT_UPGRADED_FROM_KEY } from "./eliza-agent-config";
import { elizaAgentTierUpgradeAdvisoryLockSql } from "./eliza-provision-lock";
import { assertOrgAgentQuota, buildAgentSandboxInsertValues } from "./eliza-sandbox";
import { prepareManagedElizaSharedEnvironment } from "./managed-eliza-config";
import { provisioningJobService } from "./provisioning-jobs";

/**
 * Statuses under which an existing migration target still owns the upgrade.
 * Matches the quota-counted set: any resource-holding target must be resumed
 * or reattached to, never shadowed by a second mint.
 */
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
  /** BYO env copied from the source row, already stripped of reserved platform keys. */
  environmentVars?: Record<string, string>;
  characterId?: string;
  maxNonTerminalAgents: number;
}

export type TierUpgradeTargetResult =
  | { created: true; agent: AgentSandbox; job: Job }
  | { created: false; agent: AgentSandbox };

function liveTargetWhere(organizationId: string, sourceAgentId: string) {
  return and(
    eq(agentSandboxes.organization_id, organizationId),
    // The marker alone is not proof of a migration target: agent_config is
    // PATCHable, so a marker planted on a non-dedicated row must never be
    // reattached to — only a dedicated-always row can own the upgrade.
    eq(agentSandboxes.execution_tier, "dedicated-always"),
    inArray(agentSandboxes.status, LIVE_TARGET_STATUSES),
    sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY} = ${sourceAgentId}`,
  );
}

async function findLiveTargetInTx(
  tx: DbTransaction,
  organizationId: string,
  sourceAgentId: string,
): Promise<AgentSandbox | undefined> {
  const [existing] = await tx
    .select()
    .from(agentSandboxes)
    .where(liveTargetWhere(organizationId, sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(1);
  return existing;
}

/**
 * The org's live migration target for this shared agent, if one exists. Plain
 * (unlocked) read for the route's reattach fast path; the single-flight mint
 * repeats this lookup under the per-source advisory lock before inserting.
 */
export async function findLiveTierUpgradeTarget(
  organizationId: string,
  sourceAgentId: string,
): Promise<AgentSandbox | null> {
  const [existing] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(liveTargetWhere(organizationId, sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(1);
  return existing ?? null;
}

/**
 * Best-effort teardown of the credentials prepared for a prospective target
 * that never became durable (lost the mint race, or the mint transaction
 * failed). The key is bound to the prospective id's name, so a race loser can
 * never touch the winner's credentials. One caveat: an AMBIGUOUS commit
 * failure (commit landed, acknowledgment lost) reaches this via the catch with
 * a targetId that IS now live — the revoke then removes a live target's key.
 * That state self-heals: the provision executor re-mints the agent key
 * unconditionally (`createForAgent` revokes-then-mints on every provision
 * run), so the container still boots with working credentials.
 */
async function revokeAbandonedTargetCredentials(prospectiveTargetId: string): Promise<void> {
  try {
    await apiKeysService.revokeForAgent(prospectiveTargetId);
  } catch (error) {
    // error-policy:J6 best-effort teardown — the key references a target id
    // that never existed and is unreachable; the caller's primary outcome
    // (reattach or the original failure) is what must surface.
    logger.warn(
      "[agent-tier-upgrade] Failed to revoke credentials of an abandoned target candidate",
      {
        prospectiveTargetId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * Find-or-create the dedicated migration target for a shared agent, with its
 * managed environment prepared and its provision job enqueued as one durable
 * unit. Reattaching callers get `{ created: false }` with the existing target
 * and cause no writes. Throws `AgentQuotaExceededError` when a fresh mint
 * would exceed the org's non-terminal-agent cap.
 */
export async function createTierUpgradeTargetWithProvision(
  params: CreateTierUpgradeTargetParams,
): Promise<TierUpgradeTargetResult> {
  // Phase 1 — reattach fast path and pre-mint quota refusal under the lock.
  // Anything durable a previous winner committed is visible here, so retries
  // and post-commit racers return without preparing any state of their own.
  const preexisting = await dbWrite.transaction(async (tx) => {
    await tx.execute(
      elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
    );
    const existing = await findLiveTargetInTx(tx, params.organizationId, params.sourceAgentId);
    if (existing) return existing;
    // Refuse over-quota upgrades before any credential is minted. The locked
    // insert transaction below re-asserts this authoritatively.
    await assertOrgAgentQuota(tx, params.organizationId, params.maxNonTerminalAgents);
    return undefined;
  });
  if (preexisting) return { created: false, agent: preexisting };

  // Phase 2 — prepare the target's managed environment UNLOCKED against a
  // pre-generated id. Mints the agent API key and the platform tokens the
  // container boots with; nothing here references or mutates existing rows.
  const targetId = crypto.randomUUID();
  const prepared = await prepareManagedElizaSharedEnvironment({
    existingEnv: params.environmentVars ?? {},
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: targetId,
  });
  const storedEnvironmentVars = await encryptAgentEnvVarsForStorage(
    params.organizationId,
    prepared.environmentVars,
  );

  let result: TierUpgradeTargetResult;
  try {
    // Phase 3 — the durable single-flight boundary: re-check, quota-check,
    // insert the target, and enqueue its provision job in ONE transaction
    // under the per-source lock. A failure rolls back target and job together.
    result = await dbWrite.transaction(async (tx) => {
      await tx.execute(
        elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
      );

      const existing = await findLiveTargetInTx(tx, params.organizationId, params.sourceAgentId);
      if (existing) return { created: false as const, agent: existing };

      await assertOrgAgentQuota(tx, params.organizationId, params.maxNonTerminalAgents);

      const canonical = buildAgentSandboxInsertValues({
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: params.agentName,
        agentConfig: params.agentConfig,
        environmentVars: storedEnvironmentVars,
        executionTier: "dedicated-always",
        ...(params.characterId ? { characterId: params.characterId } : {}),
      });
      const [created] = await tx
        .insert(agentSandboxes)
        .values({
          ...canonical,
          id: targetId,
          agent_config: {
            // The canonical builder strips the reserved `__agent` namespace
            // from caller config; the upgraded-from marker is server-owned and
            // re-applied on top so reattach lookups can find this target.
            ...(canonical.agent_config ?? {}),
            [AGENT_UPGRADED_FROM_KEY]: params.sourceAgentId,
          },
        })
        .returning();
      if (!created) {
        throw new ElizaError("Failed to create tier-upgrade target", {
          code: "TIER_UPGRADE_TARGET_INSERT_FAILED",
          context: { sourceAgentId: params.sourceAgentId, organizationId: params.organizationId },
        });
      }

      const { job } = await provisioningJobService.enqueueAgentProvisionOnceInTx(tx, {
        agentId: created.id,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: created.agent_name ?? created.id,
      });

      logger.info("[agent-tier-upgrade] Created migration target with provision job", {
        sourceAgentId: params.sourceAgentId,
        dedicatedAgentId: created.id,
        orgId: params.organizationId,
        jobId: job.id,
      });
      return { created: true as const, agent: created, job };
    });
  } catch (error) {
    await revokeAbandonedTargetCredentials(targetId);
    throw error;
  }

  // Lost the race between phases 1 and 3: another request committed the
  // target first. Our prepared credentials were never referenced — drop them.
  if (!result.created) await revokeAbandonedTargetCredentials(targetId);
  return result;
}
