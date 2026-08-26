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
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import type { AgentSandbox, AgentSandboxStatus } from "../../db/repositories/agent-sandboxes";
import type { Job } from "../../db/repositories/jobs";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import { parseGateCreditBalance } from "./agent-billing-gate";
import { encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import { apiKeysService } from "./api-keys";
import {
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
  readPersonalElizaCutover,
  readUpgradedFromAgentId,
} from "./eliza-agent-config";
import {
  configureElizaLifecycleTransaction,
  elizaAgentCreateAdvisoryLockSql,
  elizaAgentTierUpgradeAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
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
  "error",
];

/** Existing owner rows that can be deliberately bound without minting capacity. */
const ADOPTABLE_UNMARKED_TARGET_STATUSES: AgentSandboxStatus[] = [
  "running",
  "stopped",
  "sleeping",
  "error",
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
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
    sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY} = ${sourceAgentId}`,
  );
}

function adoptableUnmarkedTargetWhere(organizationId: string, userId: string) {
  return and(
    eq(agentSandboxes.organization_id, organizationId),
    eq(agentSandboxes.user_id, userId),
    eq(agentSandboxes.execution_tier, "dedicated-always"),
    inArray(agentSandboxes.status, ADOPTABLE_UNMARKED_TARGET_STATUSES),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
    isNull(sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY}`),
    isNull(sql`${agentSandboxes.agent_config} -> ${AGENT_PERSONAL_CUTOVER_KEY}`),
  );
}

function adoptedTargetWhere(organizationId: string, userId: string, sourceAgentId: string) {
  return and(liveTargetWhere(organizationId, sourceAgentId), eq(agentSandboxes.user_id, userId));
}

export type PersonalDedicatedAdoptionResolution =
  | { state: "unavailable" }
  | { state: "ambiguous" }
  | { state: "available" | "adopted"; agent: AgentSandbox };

export class PersonalDedicatedAdoptionError extends ElizaError {
  override readonly name = "PersonalDedicatedAdoptionError";
}

function classifyAdoptionRows(
  adopted: AgentSandbox[],
  available: AgentSandbox[],
): PersonalDedicatedAdoptionResolution {
  if (adopted.length + available.length > 1) return { state: "ambiguous" };
  if (adopted[0]) return { state: "adopted", agent: adopted[0] };
  if (available[0]) return { state: "available", agent: available[0] };
  return { state: "unavailable" };
}

/**
 * Resolve the sole same-owner Dedicated row that may be explicitly adopted.
 * No target id comes from the client: the server either finds one exact row or
 * returns an unavailable/ambiguous state without writing anything.
 */
export async function resolvePersonalDedicatedAdoption(params: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
}): Promise<PersonalDedicatedAdoptionResolution> {
  const adopted = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(adoptedTargetWhere(params.organizationId, params.userId, params.sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);

  const available = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);
  return classifyAdoptionRows(adopted, available);
}

async function resolvePersonalDedicatedAdoptionInTx(
  tx: DbTransaction,
  params: {
    organizationId: string;
    userId: string;
    sourceAgentId: string;
  },
): Promise<PersonalDedicatedAdoptionResolution> {
  const adopted = await tx
    .select()
    .from(agentSandboxes)
    .where(adoptedTargetWhere(params.organizationId, params.userId, params.sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2)
    .for("update");

  const available = await tx
    .select()
    .from(agentSandboxes)
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2)
    .for("update");
  return classifyAdoptionRows(adopted, available);
}

async function previewPersonalDedicatedAdoptionInTx(
  tx: DbTransaction,
  params: {
    organizationId: string;
    userId: string;
    sourceAgentId: string;
  },
): Promise<PersonalDedicatedAdoptionResolution> {
  const adopted = await tx
    .select()
    .from(agentSandboxes)
    .where(adoptedTargetWhere(params.organizationId, params.userId, params.sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);

  const available = await tx
    .select()
    .from(agentSandboxes)
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);
  return classifyAdoptionRows(adopted, available);
}

export interface AdoptPersonalDedicatedTargetParams {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  expectedTargetId: string;
  expectedLifecycleRevision: number;
  expectedStatus: AgentSandboxStatus;
  expectedBalance: number;
  expectedHourlyRate: number;
  expectedDailyRate: number;
  expectedMinimumBalance: number;
  expectedMinimumRunwayDays: number;
}

export interface AdoptPersonalDedicatedTargetResult {
  agent: AgentSandbox;
  alreadyAdopted: boolean;
  job?: Job;
  jobCreated: boolean;
}

function adoptionError(
  code:
    | "PERSONAL_DEDICATED_ADOPTION_UNAVAILABLE"
    | "PERSONAL_DEDICATED_ADOPTION_AMBIGUOUS"
    | "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
  message: string,
  params: AdoptPersonalDedicatedTargetParams,
): PersonalDedicatedAdoptionError {
  return new PersonalDedicatedAdoptionError(message, {
    code,
    context: {
      organizationId: params.organizationId,
      sourceAgentId: params.sourceAgentId,
      expectedTargetId: params.expectedTargetId,
    },
  });
}

/**
 * Atomically bind the sole existing same-owner Dedicated row to personal
 * Eliza and, when it is not already running, enqueue same-id provisioning.
 * The marker and job commit together under the canonical org/source/agent
 * lock order. Personal cutover remains a separate running-target transaction.
 */
export async function adoptPersonalDedicatedTargetWithProvision(
  params: AdoptPersonalDedicatedTargetParams,
): Promise<AdoptPersonalDedicatedTargetResult> {
  return dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));

    // Lock the billing authority before the per-source/per-agent lifecycle
    // locks. This makes quote confirmation serial with balance mutations and
    // preserves the global org -> source -> agent lock order.
    const [organization] = await tx
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .for("update")
      .limit(1);
    if (!organization) {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
        "The Dedicated adoption billing authority is unavailable",
        params,
      );
    }

    await tx.execute(
      elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
    );

    const preview = await previewPersonalDedicatedAdoptionInTx(tx, params);
    if (preview.state === "unavailable") {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_UNAVAILABLE",
        "No eligible existing Dedicated target is available",
        params,
      );
    }
    if (preview.state === "ambiguous") {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_AMBIGUOUS",
        "More than one existing Dedicated target is eligible",
        params,
      );
    }
    if (preview.agent.id !== params.expectedTargetId) {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
        "The eligible Dedicated target changed after quoting",
        params,
      );
    }

    await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, preview.agent.id));
    const resolution = await resolvePersonalDedicatedAdoptionInTx(tx, params);
    if (
      resolution.state === "unavailable" ||
      resolution.state === "ambiguous" ||
      resolution.agent.id !== params.expectedTargetId
    ) {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
        "The eligible Dedicated target changed while acquiring lifecycle authority",
        params,
      );
    }

    let currentBalance: number;
    try {
      currentBalance = parseGateCreditBalance(organization.creditBalance);
    } catch {
      // error-policy:J1 a corrupt locked billing value must fail closed before
      // either the ownership marker or provisioning job is written.
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
        "The Dedicated adoption billing quote can no longer be verified",
        params,
      );
    }
    const quoteStillCurrent =
      currentBalance.toFixed(6) === params.expectedBalance.toFixed(6) &&
      AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6) === params.expectedHourlyRate.toFixed(6) &&
      AGENT_PRICING.DAILY_RUNNING_COST.toFixed(6) === params.expectedDailyRate.toFixed(6) &&
      AGENT_PRICING.UPGRADE_MINIMUM_BALANCE.toFixed(6) ===
        params.expectedMinimumBalance.toFixed(6) &&
      AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS === params.expectedMinimumRunwayDays;
    if (!quoteStillCurrent) {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
        "The Dedicated adoption billing quote changed while acquiring lifecycle authority",
        params,
      );
    }

    let target = resolution.agent;
    const alreadyAdopted = resolution.state === "adopted";
    if (
      target.lifecycle_revision !== params.expectedLifecycleRevision ||
      target.status !== params.expectedStatus
    ) {
      throw adoptionError(
        "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
        "The eligible Dedicated target state changed after quoting",
        params,
      );
    }
    if (!alreadyAdopted) {
      const [updated] = await tx
        .update(agentSandboxes)
        .set({
          agent_config: {
            ...((target.agent_config as Record<string, unknown> | null) ?? {}),
            [AGENT_UPGRADED_FROM_KEY]: params.sourceAgentId,
          },
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, target.id),
            eq(agentSandboxes.organization_id, params.organizationId),
            eq(agentSandboxes.user_id, params.userId),
            eq(agentSandboxes.lifecycle_revision, params.expectedLifecycleRevision),
            eq(agentSandboxes.status, params.expectedStatus),
            isNull(agentSandboxes.pool_status),
            isNull(agentSandboxes.deleted_at),
            isNull(agentSandboxes.deletion_attempt_id),
            isNull(sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY}`),
          ),
        )
        .returning();
      if (!updated) {
        throw adoptionError(
          "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
          "The eligible Dedicated target changed while adopting",
          params,
        );
      }
      target = updated;
    }

    if (target.status === "running") {
      return { agent: target, alreadyAdopted, jobCreated: false };
    }

    const enqueue = await provisioningJobService.enqueueAgentProvisionOnceInTx(tx, {
      agentId: target.id,
      organizationId: params.organizationId,
      userId: params.userId,
      agentName: target.agent_name ?? target.id,
    });
    return {
      agent: target,
      alreadyAdopted,
      job: enqueue.job,
      jobCreated: enqueue.created,
    };
  });
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
 * Resolve the Dedicated target that has completed the personal-Eliza cutover.
 * A merely running migration target is not authoritative: Shared continues to
 * serve until transcript import and this server-owned marker both succeed.
 * Afterward the marker stays authoritative through sleep/error/restart states;
 * silently falling back would split later turns into the archived Shared log.
 */
export async function findActivePersonalDedicatedTarget(
  organizationId: string,
  sourceAgentId: string,
): Promise<AgentSandbox | null> {
  const [target] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.organization_id, organizationId),
        eq(agentSandboxes.execution_tier, "dedicated-always"),
        sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY} = ${sourceAgentId}`,
      ),
    )
    .orderBy(desc(agentSandboxes.created_at))
    .limit(1);
  if (!target) return null;
  return isAuthoritativePersonalDedicatedTarget(target, sourceAgentId) ? target : null;
}

/** One source of truth for the two server-owned markers that activate cutover. */
export function isAuthoritativePersonalDedicatedTarget(
  target: Pick<AgentSandbox, "agent_config">,
  sourceAgentId: string,
): boolean {
  const agentConfig = target.agent_config as Record<string, unknown> | null;
  return (
    readUpgradedFromAgentId(agentConfig) === sourceAgentId &&
    readPersonalElizaCutover(agentConfig)?.sourceAgentId === sourceAgentId
  );
}

/**
 * Atomically make one healthy Dedicated migration target authoritative after
 * the caller has completed the server-owned transcript import. The per-source
 * lock serializes completion with retry/reprovision activity, and an exact
 * existing marker is an idempotent success.
 */
export async function finalizePersonalTierUpgradeCutover(params: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  dedicatedAgentId: string;
  cutoverToken: string;
  sharedMessageCount: number;
  sharedScheduledTaskCount: number;
  sharedTodoCount: number;
  sharedTodoMutationCount: number;
  sharedTodoDigest: string;
}): Promise<AgentSandbox> {
  return dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(
      elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
    );
    const [target] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          liveTargetWhere(params.organizationId, params.sourceAgentId),
          eq(agentSandboxes.id, params.dedicatedAgentId),
          eq(agentSandboxes.user_id, params.userId),
          eq(agentSandboxes.status, "running"),
        ),
      )
      .for("update")
      .limit(1);
    if (!target) {
      throw new ElizaError(
        "Dedicated cutover target is not healthy or does not own this personal Eliza",
        {
          code: "PERSONAL_DEDICATED_CUTOVER_TARGET_INVALID",
          context: {
            sourceAgentId: params.sourceAgentId,
            dedicatedAgentId: params.dedicatedAgentId,
            organizationId: params.organizationId,
          },
        },
      );
    }

    const existing = readPersonalElizaCutover(
      target.agent_config as Record<string, unknown> | null,
    );
    const sameCutover =
      existing?.sourceAgentId === params.sourceAgentId &&
      existing.cutoverToken === params.cutoverToken;
    if (
      sameCutover &&
      existing.sharedMessageCount === params.sharedMessageCount &&
      existing.sharedScheduledTaskCount === params.sharedScheduledTaskCount &&
      existing.sharedTodoCount === params.sharedTodoCount &&
      existing.sharedTodoMutationCount === params.sharedTodoMutationCount &&
      existing.sharedTodoDigest === params.sharedTodoDigest
    ) {
      return target;
    }

    const [updated] = await tx
      .update(agentSandboxes)
      .set({
        agent_config: {
          ...((target.agent_config as Record<string, unknown> | null) ?? {}),
          [AGENT_PERSONAL_CUTOVER_KEY]: {
            mode: "dedicated",
            sourceAgentId: params.sourceAgentId,
            conversationId: params.sourceAgentId,
            cutoverToken: params.cutoverToken,
            sharedMessageCount: params.sharedMessageCount,
            sharedScheduledTaskCount: params.sharedScheduledTaskCount,
            sharedTodoCount: params.sharedTodoCount,
            sharedTodoMutationCount: params.sharedTodoMutationCount,
            sharedTodoDigest: params.sharedTodoDigest,
            activatedAt: sameCutover ? existing.activatedAt : new Date().toISOString(),
          },
        },
        updated_at: new Date(),
      })
      .where(eq(agentSandboxes.id, target.id))
      .returning();
    if (!updated) {
      throw new ElizaError("Failed to finalize personal Dedicated cutover", {
        code: "PERSONAL_DEDICATED_CUTOVER_UPDATE_FAILED",
        context: {
          sourceAgentId: params.sourceAgentId,
          dedicatedAgentId: params.dedicatedAgentId,
        },
      });
    }
    return updated;
  });
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
    await configureElizaLifecycleTransaction(tx);
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
      await configureElizaLifecycleTransaction(tx);
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
