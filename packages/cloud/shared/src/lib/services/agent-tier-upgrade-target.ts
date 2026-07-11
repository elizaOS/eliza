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
 * Candidate credentials are revoked ONLY after durable state proves the
 * prospective id was never adopted: a transaction rejection can be an
 * ambiguous commit (commit landed, acknowledgment lost), so the catch path
 * re-reads the live target before touching any key.
 *
 * Lock order (global discipline, deadlock-free by strict ordering):
 * org agent-create lock → per-source tier-upgrade lock → per-agent provision
 * lock. The org lock makes the quota count→insert atomic against EVERY other
 * quota-consuming creation path (createAgent, coding containers, and upgrades
 * of a different source agent); the per-source lock serializes upgrades of one
 * source; the provision lock is acquired by the nested job enqueue.
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
import { jobs } from "../../db/schemas/jobs";
import { logger } from "../utils/logger";
import { encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import { apiKeysService } from "./api-keys";
import { AGENT_UPGRADED_FROM_KEY } from "./eliza-agent-config";
import {
  elizaAgentCreateAdvisoryLockSql,
  elizaAgentTierUpgradeAdvisoryLockSql,
} from "./eliza-provision-lock";
import { assertOrgAgentQuota, buildAgentSandboxInsertValues } from "./eliza-sandbox";
import { prepareManagedElizaSharedEnvironment } from "./managed-eliza-config";
import { JOB_TYPES } from "./provisioning-job-types";
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
 * that durable state has PROVEN was never adopted (lost the mint race to a
 * competitor, or the boundary transaction verifiably rolled back). Callers
 * must establish that proof first — `resolveOutcomeAfterBoundaryRejection`
 * re-reads the live target before this ever runs — so the key named for the
 * prospective id can never belong to a live target.
 */
async function revokeAbandonedTargetCredentials(prospectiveTargetId: string): Promise<void> {
  try {
    await apiKeysService.revokeForAgent(prospectiveTargetId);
  } catch (error) {
    // error-policy:J6 best-effort teardown — the key references a target id
    // that provably never existed; the caller's primary outcome (reattach or
    // the original failure) is what must surface.
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
 * Classifies a boundary-transaction rejection by re-reading durable state on a
 * fresh connection: a rejection is NOT proof of rollback — the COMMIT may have
 * landed with only its acknowledgment lost. Exactly three provable outcomes:
 *
 *  - the candidate id IS the live target → the commit landed; recover the
 *    result (with its provision job) instead of failing, and never touch the
 *    credential the durable row's environment references;
 *  - a COMPETITOR's target is live → this caller lost the race; its candidate
 *    credential is provably unreferenced and safe to revoke;
 *  - NO live target exists → the transaction provably rolled back; the
 *    candidate credential is safe to revoke, and the original error stands.
 *
 * When the verification itself fails, nothing is provable: the credential is
 * PRESERVED (a stranded-but-active key is recoverable hygiene debt, #16071; a
 * revoked live-target key breaks a paying user's agent) and the original
 * error surfaces with the uncertainty logged.
 */
async function resolveOutcomeAfterBoundaryRejection(
  params: CreateTierUpgradeTargetParams,
  candidateTargetId: string,
  rejection: unknown,
): Promise<TierUpgradeTargetResult | null> {
  let live: AgentSandbox | null;
  try {
    live = await findLiveTierUpgradeTarget(params.organizationId, params.sourceAgentId);
  } catch (verificationError) {
    // error-policy:J2 context-adding uncertainty path — the ORIGINAL rejection
    // is rethrown by the caller; this records that durability could not be
    // verified and that the candidate credential was deliberately preserved.
    logger.error(
      "[agent-tier-upgrade] Could not verify durability after a boundary rejection — preserving candidate credentials",
      {
        sourceAgentId: params.sourceAgentId,
        candidateTargetId,
        orgId: params.organizationId,
        rejection: rejection instanceof Error ? rejection.message : String(rejection),
        verificationError:
          verificationError instanceof Error
            ? verificationError.message
            : String(verificationError),
      },
    );
    return null;
  }

  if (live?.id === candidateTargetId) {
    // Ambiguous commit recovered: target (and, atomically, its job) are
    // durable. Hand back the committed pair; the credential stays untouched.
    const job = await findActiveTierUpgradeProvisionJob(params.organizationId, candidateTargetId);
    logger.warn(
      "[agent-tier-upgrade] Boundary transaction rejected AFTER a durable commit — recovered the committed target",
      {
        sourceAgentId: params.sourceAgentId,
        dedicatedAgentId: candidateTargetId,
        orgId: params.organizationId,
        jobId: job?.id ?? null,
        rejection: rejection instanceof Error ? rejection.message : String(rejection),
      },
    );
    if (job) return { created: true, agent: live, job };
    // Job already claimed-and-finished (or otherwise not active): reattach —
    // the route's idempotent re-enqueue handles a dead job safely.
    return { created: false, agent: live };
  }

  if (live) {
    // A competitor's commit is durable — this caller's candidate was provably
    // never adopted.
    await revokeAbandonedTargetCredentials(candidateTargetId);
    return { created: false, agent: live };
  }

  // Provable rollback: no live target for this source. Candidate credentials
  // are unreferenced; the original rejection is the real outcome.
  await revokeAbandonedTargetCredentials(candidateTargetId);
  return null;
}

/** The candidate/target's active provision job, if one is pending or running. */
async function findActiveTierUpgradeProvisionJob(
  organizationId: string,
  agentId: string,
): Promise<Job | null> {
  const [job] = await dbWrite
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, JOB_TYPES.AGENT_PROVISION),
        eq(jobs.organization_id, organizationId),
        eq(jobs.agent_id, agentId),
        sql`${jobs.status} IN ('pending', 'in_progress')`,
      ),
    )
    .orderBy(desc(jobs.created_at))
    .limit(1);
  return job ?? null;
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
  // Phase 1 — reattach fast path and pre-mint quota refusal under the locks.
  // Anything durable a previous winner committed is visible here, so retries
  // and post-commit racers return without preparing any state of their own.
  const preexisting = await dbWrite.transaction(async (tx) => {
    // Org lock FIRST (global order: org → tier-upgrade → provision): the
    // quota count is only atomic if every quota-consuming creation path —
    // createAgent, coding containers, upgrades of OTHER source agents —
    // serializes on the same org-wide lock (#16042 review).
    await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
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
  let storedEnvironmentVars: Record<string, string>;
  try {
    const prepared = await prepareManagedElizaSharedEnvironment({
      existingEnv: params.environmentVars ?? {},
      organizationId: params.organizationId,
      userId: params.userId,
      agentSandboxId: targetId,
    });
    storedEnvironmentVars = await encryptAgentEnvVarsForStorage(
      params.organizationId,
      prepared.environmentVars,
    );
  } catch (error) {
    // No target transaction has started, so this candidate id cannot have
    // durable ownership. Preparation may already have minted its API key
    // before a later token/encryption step rejected; revoke it here instead of
    // misclassifying an ordinary phase-2 failure as crash-only hygiene debt.
    await revokeAbandonedTargetCredentials(targetId);
    throw error;
  }

  let result: TierUpgradeTargetResult;
  try {
    // Phase 3 — the durable single-flight boundary: re-check, quota-check,
    // insert the target, and enqueue its provision job in ONE transaction
    // under the org + per-source locks. A rollback discards target and job
    // together.
    result = await dbWrite.transaction(async (tx) => {
      // Same global lock order as phase 1: org → tier-upgrade (→ the nested
      // enqueue's provision lock). The org lock is what makes the quota
      // count→insert atomic against createAgent and other-source upgrades.
      await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
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
    // A rejection is NOT proof of rollback — verify durability before any
    // cleanup (an ambiguous commit-ack loss leaves target+job live, and the
    // candidate credential is then the LIVE target's credential).
    const recovered = await resolveOutcomeAfterBoundaryRejection(params, targetId, error);
    if (recovered) return recovered;
    throw error;
  }

  // Lost the race between phases 1 and 3: another request committed the
  // target first. Our prepared credentials were never referenced — drop them.
  if (!result.created) await revokeAbandonedTargetCredentials(targetId);
  return result;
}
