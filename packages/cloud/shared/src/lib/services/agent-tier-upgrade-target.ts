/**
 * Single-flight mint of the dedicated target for a shared-agent tier upgrade
 * (#15355, hardened in #15943). One boundary owns the WHOLE span — managed
 * credential minting, environment preparation, target insertion, and the
 * provision-job enqueue — so concurrent upgrade requests for one source agent
 * converge on exactly one target, one prepared environment, and one job.
 *
 * The invariant that makes the compensation problem disappear: the target row,
 * its provenance receipt, and its provision job commit in ONE transaction under the per-source
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

import { ElizaError } from "@elizaos/core/edge";
import { and, asc, desc, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import type { AgentSandbox, AgentSandboxStatus } from "../../db/repositories/agent-sandboxes";
import type { Job } from "../../db/repositories/jobs";
import { agentSandboxBackups, agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { personalDedicatedAdoptionSelections } from "../../db/schemas/personal-dedicated-adoption-selections";
import {
  type PersonalDedicatedUpgradeAuthority,
  personalDedicatedUpgradeAuthorities,
} from "../../db/schemas/personal-dedicated-upgrade-authorities";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import { parseGateCreditBalance } from "./agent-billing-gate";
import { encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import { apiKeysService } from "./api-keys";
import {
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
  readPersonalElizaCutover,
  stripReservedElizaConfigKeys,
} from "./eliza-agent-config";
import {
  configureElizaLifecycleTransaction,
  elizaAgentCreateAdvisoryLockSql,
  elizaAgentTierUpgradeAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import { assertOrgAgentQuota, buildAgentSandboxInsertValues } from "./eliza-sandbox";
import { prepareManagedElizaSharedEnvironment } from "./managed-eliza-config";
import {
  type PersonalDedicatedActivationAuthority,
  type PersonalDedicatedBackupProvenance,
  personalDedicatedActivationAuthority,
  personalDedicatedActivationAuthorityFromReceipt,
  personalDedicatedActivationAuthorityKey,
  personalDedicatedInventoryFingerprint,
  personalDedicatedStateDisposition,
} from "./personal-dedicated-adoption-provenance";
import { EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES, JOB_TYPES } from "./provisioning-job-types";
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

function liveTargetWhere(organizationId: string) {
  return and(
    eq(agentSandboxes.organization_id, organizationId),
    eq(agentSandboxes.execution_tier, "dedicated-always"),
    inArray(agentSandboxes.status, LIVE_TARGET_STATUSES),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
  );
}

function exactAuthorityWhere(organizationId: string, userId: string, sourceAgentId: string) {
  return and(
    eq(personalDedicatedUpgradeAuthorities.organization_id, organizationId),
    eq(personalDedicatedUpgradeAuthorities.user_id, userId),
    eq(personalDedicatedUpgradeAuthorities.source_agent_id, sourceAgentId),
    eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
    eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
  );
}

/** A reserved JSON key is absent only when it is not present at all. */
function agentConfigKeyAbsent(key: string) {
  return sql`NOT (COALESCE(${agentSandboxes.agent_config}, '{}'::jsonb) ? ${key})`;
}

function adoptableUnmarkedTargetBaseWhere(organizationId: string, userId: string) {
  return and(
    eq(agentSandboxes.organization_id, organizationId),
    eq(agentSandboxes.user_id, userId),
    eq(agentSandboxes.execution_tier, "dedicated-always"),
    inArray(agentSandboxes.status, ADOPTABLE_UNMARKED_TARGET_STATUSES),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
    // Presence is quarantine-bearing even when a corrupted/caller-forged value
    // is JSON null or has the wrong shape. Only truly absent keys are eligible;
    // authority itself lives in the receipt table.
    agentConfigKeyAbsent(AGENT_UPGRADED_FROM_KEY),
    agentConfigKeyAbsent(AGENT_PERSONAL_CUTOVER_KEY),
  );
}

export function adoptableUnmarkedTargetWhere(organizationId: string, userId: string) {
  return and(
    adoptableUnmarkedTargetBaseWhere(organizationId, userId),
    notExists(
      dbWrite
        .select({ id: personalDedicatedUpgradeAuthorities.id })
        .from(personalDedicatedUpgradeAuthorities)
        .where(eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id)),
    ),
  );
}

function unselectedAdoptableTargetWhere(organizationId: string, userId: string) {
  return and(
    adoptableUnmarkedTargetWhere(organizationId, userId),
    notExists(
      dbWrite
        .select({ id: personalDedicatedAdoptionSelections.id })
        .from(personalDedicatedAdoptionSelections)
        .where(eq(personalDedicatedAdoptionSelections.dedicated_agent_id, agentSandboxes.id)),
    ),
  );
}

function exactSelectionWhere(organizationId: string, userId: string, sourceAgentId: string) {
  return and(
    eq(personalDedicatedAdoptionSelections.organization_id, organizationId),
    eq(personalDedicatedAdoptionSelections.user_id, userId),
    eq(personalDedicatedAdoptionSelections.source_agent_id, sourceAgentId),
    eq(personalDedicatedAdoptionSelections.schema_version, 1),
    eq(personalDedicatedAdoptionSelections.dedicated_agent_id, agentSandboxes.id),
  );
}

const adoptionBackupProjection = {
  id: agentSandboxBackups.id,
  sandboxRecordId: agentSandboxBackups.sandbox_record_id,
  snapshotType: agentSandboxBackups.snapshot_type,
  stateDataStorage: agentSandboxBackups.state_data_storage,
  stateDataKey: agentSandboxBackups.state_data_key,
  backupKind: agentSandboxBackups.backup_kind,
  parentBackupId: agentSandboxBackups.parent_backup_id,
  contentHash: agentSandboxBackups.content_hash,
  verificationStatus: agentSandboxBackups.verification_status,
  verifiedAt: agentSandboxBackups.verified_at,
  catalogVersion: agentSandboxBackups.catalog_version,
  catalogState: agentSandboxBackups.catalog_state,
  catalogPayloadDigest: agentSandboxBackups.catalog_payload_digest,
  catalogRevision: agentSandboxBackups.catalog_revision,
  catalogOrganizationId: agentSandboxBackups.catalog_organization_id,
  catalogAgentId: agentSandboxBackups.catalog_agent_id,
  sourceProvider: agentSandboxBackups.source_provider,
  sourceNodeRecordId: agentSandboxBackups.source_node_record_id,
  sourceNodeId: agentSandboxBackups.source_node_id,
  sourceProviderServerId: agentSandboxBackups.source_provider_server_id,
  sourceProviderHandle: agentSandboxBackups.source_provider_handle,
  sourceContainerId: agentSandboxBackups.source_container_id,
  manifestVersion: agentSandboxBackups.manifest_version,
  manifestDigest: agentSandboxBackups.manifest_digest,
  objectInventoryDigest: agentSandboxBackups.object_inventory_digest,
  imageDigest: agentSandboxBackups.image_digest,
  databaseSchemaVersion: agentSandboxBackups.database_schema_version,
  pluginSetDigest: agentSandboxBackups.plugin_set_digest,
  watermarkDigest: agentSandboxBackups.watermark_digest,
  restoreReceiptDigest: agentSandboxBackups.restore_receipt_digest,
  catalogDeletedAt: agentSandboxBackups.catalog_deleted_at,
  createdAt: agentSandboxBackups.created_at,
};

async function selectionReceiptMatchesInventory(params: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  receipt: typeof personalDedicatedAdoptionSelections.$inferSelect;
  candidates: AgentSandbox[];
  backups: PersonalDedicatedBackupProvenance[];
}): Promise<boolean> {
  const currentActivationAuthority = personalDedicatedActivationAuthority(
    params.organizationId,
    params.receipt.dedicated_agent_id,
    params.backups,
  );
  const receiptActivationAuthority = personalDedicatedActivationAuthorityFromReceipt(
    params.receipt.activation_kind,
    params.receipt.activation_backup_id,
    params.receipt.activation_backup_hash,
    params.receipt.activation_backup_chain,
  );
  if (
    params.receipt.candidate_count !== params.candidates.length ||
    params.receipt.state_disposition !==
      personalDedicatedStateDisposition(
        params.organizationId,
        params.receipt.dedicated_agent_id,
        params.backups,
      ) ||
    personalDedicatedActivationAuthorityKey(currentActivationAuthority) !==
      personalDedicatedActivationAuthorityKey(receiptActivationAuthority)
  ) {
    return false;
  }
  return (
    params.receipt.inventory_fingerprint ===
    (await personalDedicatedInventoryFingerprint({
      organizationId: params.organizationId,
      userId: params.userId,
      sourceAgentId: params.sourceAgentId,
      retainedAgentId: params.receipt.dedicated_agent_id,
      candidates: params.candidates,
      backups: params.backups,
    }))
  );
}

function adoptedTargetWhere(organizationId: string, userId: string, sourceAgentId: string) {
  return and(
    liveTargetWhere(organizationId),
    eq(agentSandboxes.user_id, userId),
    exactAuthorityWhere(organizationId, userId, sourceAgentId),
  );
}

function unverifiedReservedMarkerWhere(organizationId: string, userId: string) {
  return and(
    liveTargetWhere(organizationId),
    eq(agentSandboxes.user_id, userId),
    or(
      sql`COALESCE(${agentSandboxes.agent_config}, '{}'::jsonb) ? ${AGENT_UPGRADED_FROM_KEY}`,
      sql`COALESCE(${agentSandboxes.agent_config}, '{}'::jsonb) ? ${AGENT_PERSONAL_CUTOVER_KEY}`,
    ),
    notExists(
      dbWrite
        .select({ id: personalDedicatedUpgradeAuthorities.id })
        .from(personalDedicatedUpgradeAuthorities)
        .where(
          and(
            eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
            eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
          ),
        ),
    ),
  );
}

export type PersonalDedicatedAdoptionResolution =
  | { state: "unavailable" }
  | { state: "ambiguous" }
  | {
      state: "available" | "adopted";
      agent: AgentSandbox;
      selectionActivationAuthority?: PersonalDedicatedActivationAuthority;
      selectionActivationReceiptId?: string;
    };

export class PersonalDedicatedAdoptionError extends ElizaError {
  override readonly name = "PersonalDedicatedAdoptionError";
}

export class PersonalDedicatedSelectionRequiredError extends ElizaError {
  override readonly name = "PersonalDedicatedSelectionRequiredError";
}

async function assertNoExistingAdoptionCandidateInTx(
  tx: DbTransaction,
  params: Pick<CreateTierUpgradeTargetParams, "organizationId" | "userId" | "sourceAgentId">,
): Promise<void> {
  const [selection] = await tx
    .select({ id: personalDedicatedAdoptionSelections.id })
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
        eq(personalDedicatedAdoptionSelections.user_id, params.userId),
        eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1);
  const [candidate] = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .leftJoin(
      personalDedicatedUpgradeAuthorities,
      eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
    )
    .where(
      and(
        adoptableUnmarkedTargetBaseWhere(params.organizationId, params.userId),
        isNull(personalDedicatedUpgradeAuthorities.id),
      ),
    )
    .limit(1);
  if (selection || candidate) {
    throw new PersonalDedicatedSelectionRequiredError(
      "An existing Dedicated target must use the same-row adoption contract",
      {
        code: "PERSONAL_DEDICATED_SELECTION_REQUIRES_ADOPTION",
        context: {
          organizationId: params.organizationId,
          userId: params.userId,
          sourceAgentId: params.sourceAgentId,
        },
      },
    );
  }
}

function classifyAdoptionRows(
  adopted: AgentSandbox[],
  hasAuthorityReceipt: boolean,
  selected: AgentSandbox[],
  hasSelectionReceipt: boolean,
  available: AgentSandbox[],
  hasQuarantinedMarker = false,
): PersonalDedicatedAdoptionResolution {
  if (adopted.length > 1 || selected.length > 1 || (hasQuarantinedMarker && adopted.length > 0)) {
    return { state: "ambiguous" };
  }
  if (hasAuthorityReceipt) {
    return adopted[0] ? { state: "adopted", agent: adopted[0] } : { state: "unavailable" };
  }
  if (hasSelectionReceipt) {
    return selected[0] ? { state: "available", agent: selected[0] } : { state: "unavailable" };
  }
  if (hasQuarantinedMarker) return { state: "unavailable" };
  if (available.length > 1) return { state: "ambiguous" };
  if (available[0]) return { state: "available", agent: available[0] };
  return { state: "unavailable" };
}

function attachSelectionActivationAuthority(
  resolution: PersonalDedicatedAdoptionResolution,
  receipt: typeof personalDedicatedAdoptionSelections.$inferSelect | undefined,
  receiptValid: boolean,
): PersonalDedicatedAdoptionResolution {
  if (
    !receipt ||
    (resolution.state !== "available" && resolution.state !== "adopted") ||
    resolution.agent.id !== receipt.dedicated_agent_id ||
    (resolution.state === "available" && !receiptValid)
  ) {
    return resolution;
  }
  const authority = personalDedicatedActivationAuthorityFromReceipt(
    receipt.activation_kind,
    receipt.activation_backup_id,
    receipt.activation_backup_hash,
    receipt.activation_backup_chain,
  );
  if (!authority) return { state: "unavailable" };
  return {
    ...resolution,
    selectionActivationAuthority: authority,
    selectionActivationReceiptId: receipt.id,
  };
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
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedUpgradeAuthorities,
      exactAuthorityWhere(params.organizationId, params.userId, params.sourceAgentId),
    )
    .where(adoptedTargetWhere(params.organizationId, params.userId, params.sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);
  const [authorityReceipt] = await dbWrite
    .select({ id: personalDedicatedUpgradeAuthorities.id })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.user_id, params.userId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
      ),
    )
    .limit(1);

  const selected = await dbWrite
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedAdoptionSelections,
      exactSelectionWhere(params.organizationId, params.userId, params.sourceAgentId),
    )
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .limit(2);
  const [selectionReceipt] = await dbWrite
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
        eq(personalDedicatedAdoptionSelections.user_id, params.userId),
        eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1);
  const selectionCandidates = selectionReceipt
    ? await dbWrite
        .select()
        .from(agentSandboxes)
        .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
        .orderBy(asc(agentSandboxes.id))
        .limit(101)
    : [];
  const selectionBackups =
    selectionCandidates.length > 0
      ? ((await dbWrite
          .select(adoptionBackupProjection)
          .from(agentSandboxBackups)
          .where(
            inArray(
              agentSandboxBackups.sandbox_record_id,
              selectionCandidates.map((candidate) => candidate.id),
            ),
          )
          .orderBy(
            asc(agentSandboxBackups.sandbox_record_id),
            asc(agentSandboxBackups.id),
          )) as PersonalDedicatedBackupProvenance[])
      : [];
  const selectionReceiptValid = selectionReceipt
    ? await selectionReceiptMatchesInventory({
        ...params,
        receipt: selectionReceipt,
        candidates: selectionCandidates,
        backups: selectionBackups,
      })
    : false;

  const available = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(unselectedAdoptableTargetWhere(params.organizationId, params.userId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);
  const [quarantined] = await dbWrite
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(unverifiedReservedMarkerWhere(params.organizationId, params.userId))
    .limit(1);
  return attachSelectionActivationAuthority(
    classifyAdoptionRows(
      adopted.map((row) => row.agent),
      Boolean(authorityReceipt),
      selectionReceiptValid ? selected.map((row) => row.agent) : [],
      Boolean(selectionReceipt),
      available,
      Boolean(quarantined),
    ),
    selectionReceipt,
    selectionReceiptValid,
  );
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
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedUpgradeAuthorities,
      exactAuthorityWhere(params.organizationId, params.userId, params.sourceAgentId),
    )
    .where(adoptedTargetWhere(params.organizationId, params.userId, params.sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2)
    .for("update");
  const [authorityReceipt] = await tx
    .select({ id: personalDedicatedUpgradeAuthorities.id })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.user_id, params.userId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
      ),
    )
    .limit(1)
    .for("update");

  const selected = await tx
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedAdoptionSelections,
      exactSelectionWhere(params.organizationId, params.userId, params.sourceAgentId),
    )
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .limit(2)
    .for("update");
  const [selectionReceipt] = await tx
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
        eq(personalDedicatedAdoptionSelections.user_id, params.userId),
        eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1)
    .for("update");
  const selectionCandidates = selectionReceipt
    ? await tx
        .select()
        .from(agentSandboxes)
        .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
        .orderBy(asc(agentSandboxes.id))
        .limit(101)
        .for("update")
    : [];
  const selectionBackups =
    selectionCandidates.length > 0
      ? ((await tx
          .select(adoptionBackupProjection)
          .from(agentSandboxBackups)
          .where(
            inArray(
              agentSandboxBackups.sandbox_record_id,
              selectionCandidates.map((candidate) => candidate.id),
            ),
          )
          .orderBy(asc(agentSandboxBackups.sandbox_record_id), asc(agentSandboxBackups.id))
          .for("share")) as PersonalDedicatedBackupProvenance[])
      : [];
  const selectionReceiptValid = selectionReceipt
    ? await selectionReceiptMatchesInventory({
        ...params,
        receipt: selectionReceipt,
        candidates: selectionCandidates,
        backups: selectionBackups,
      })
    : false;

  const available = await tx
    .select()
    .from(agentSandboxes)
    .where(unselectedAdoptableTargetWhere(params.organizationId, params.userId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2)
    .for("update");
  const [quarantined] = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(unverifiedReservedMarkerWhere(params.organizationId, params.userId))
    .limit(1)
    .for("update");
  return attachSelectionActivationAuthority(
    classifyAdoptionRows(
      adopted.map((row) => row.agent),
      Boolean(authorityReceipt),
      selectionReceiptValid ? selected.map((row) => row.agent) : [],
      Boolean(selectionReceipt),
      available,
      Boolean(quarantined),
    ),
    selectionReceipt,
    selectionReceiptValid,
  );
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
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedUpgradeAuthorities,
      exactAuthorityWhere(params.organizationId, params.userId, params.sourceAgentId),
    )
    .where(adoptedTargetWhere(params.organizationId, params.userId, params.sourceAgentId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);
  const [authorityReceipt] = await tx
    .select({ id: personalDedicatedUpgradeAuthorities.id })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.user_id, params.userId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
      ),
    )
    .limit(1);

  const selected = await tx
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedAdoptionSelections,
      exactSelectionWhere(params.organizationId, params.userId, params.sourceAgentId),
    )
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .limit(2);
  const [selectionReceipt] = await tx
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
        eq(personalDedicatedAdoptionSelections.user_id, params.userId),
        eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1);
  const selectionCandidates = selectionReceipt
    ? await tx
        .select()
        .from(agentSandboxes)
        .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
        .orderBy(asc(agentSandboxes.id))
        .limit(101)
    : [];
  const selectionBackups =
    selectionCandidates.length > 0
      ? ((await tx
          .select(adoptionBackupProjection)
          .from(agentSandboxBackups)
          .where(
            inArray(
              agentSandboxBackups.sandbox_record_id,
              selectionCandidates.map((candidate) => candidate.id),
            ),
          )
          .orderBy(
            asc(agentSandboxBackups.sandbox_record_id),
            asc(agentSandboxBackups.id),
          )) as PersonalDedicatedBackupProvenance[])
      : [];
  const selectionReceiptValid = selectionReceipt
    ? await selectionReceiptMatchesInventory({
        ...params,
        receipt: selectionReceipt,
        candidates: selectionCandidates,
        backups: selectionBackups,
      })
    : false;

  const available = await tx
    .select()
    .from(agentSandboxes)
    .where(unselectedAdoptableTargetWhere(params.organizationId, params.userId))
    .orderBy(desc(agentSandboxes.created_at))
    .limit(2);
  const [quarantined] = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(unverifiedReservedMarkerWhere(params.organizationId, params.userId))
    .limit(1);
  return attachSelectionActivationAuthority(
    classifyAdoptionRows(
      adopted.map((row) => row.agent),
      Boolean(authorityReceipt),
      selectionReceiptValid ? selected.map((row) => row.agent) : [],
      Boolean(selectionReceipt),
      available,
      Boolean(quarantined),
    ),
    selectionReceipt,
    selectionReceiptValid,
  );
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
  expectedActivationAuthorityKey: string;
}

export interface AdoptPersonalDedicatedTargetResult {
  agent: AgentSandbox;
  alreadyAdopted: boolean;
  job?: Job;
  jobCreated: boolean;
}

async function findActiveExclusiveLifecycleJobInTx(
  tx: DbTransaction,
  organizationId: string,
  agentId: string,
): Promise<Job | null> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, organizationId),
        eq(jobs.agent_id, agentId),
        inArray(jobs.type, [...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
        sql`${jobs.status} IN ('pending', 'in_progress')`,
      ),
    )
    .orderBy(desc(jobs.created_at))
    .limit(1);
  return job ?? null;
}

function adoptionError(
  code:
    | "PERSONAL_DEDICATED_ADOPTION_UNAVAILABLE"
    | "PERSONAL_DEDICATED_ADOPTION_AMBIGUOUS"
    | "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED"
    | "PERSONAL_DEDICATED_ADOPTION_CATALOG_RESTORE_REQUIRED",
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
 * The receipt, compatibility projection, and job commit together under the canonical org/source/agent
 * lock order. Personal cutover remains a separate running-target transaction.
 */
export async function adoptPersonalDedicatedTargetWithProvision(
  params: AdoptPersonalDedicatedTargetParams,
): Promise<AdoptPersonalDedicatedTargetResult> {
  let attemptedResult: AdoptPersonalDedicatedTargetResult | undefined;
  try {
    return await dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
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

      const activationAuthority = resolution.selectionActivationAuthority;
      if (
        personalDedicatedActivationAuthorityKey(activationAuthority) !==
        params.expectedActivationAuthorityKey
      ) {
        throw adoptionError(
          "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
          "The reviewed Dedicated restore authority changed after quoting",
          params,
        );
      }

      // Hourly billing locks sandbox -> organization. Adoption must do the
      // same: reversing these row locks creates a real two-transaction cycle.
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

      let currentBalance: number;
      try {
        currentBalance = parseGateCreditBalance(organization.creditBalance);
      } catch {
        // error-policy:J1 a corrupt locked billing value must fail closed before
        // either the ownership receipt/projection or provisioning job is written.
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
      if (target.status === "running") {
        const conflict = await findActiveExclusiveLifecycleJobInTx(
          tx,
          params.organizationId,
          target.id,
        );
        if (conflict) {
          throw adoptionError(
            "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
            `The existing Dedicated target has an active ${conflict.type} lifecycle job`,
            params,
          );
        }
      }
      if (!alreadyAdopted) {
        await tx.insert(personalDedicatedUpgradeAuthorities).values({
          organization_id: params.organizationId,
          user_id: params.userId,
          source_agent_id: params.sourceAgentId,
          dedicated_agent_id: target.id,
          schema_version: 1,
        });
        const [updated] = await tx
          .update(agentSandboxes)
          .set({
            agent_config: {
              ...stripReservedElizaConfigKeys(
                target.agent_config as Record<string, unknown> | null,
              ),
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
              agentConfigKeyAbsent(AGENT_UPGRADED_FROM_KEY),
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
        attemptedResult = { agent: target, alreadyAdopted, jobCreated: false };
        return attemptedResult;
      }

      if (activationAuthority?.kind === "catalog-restore-required") {
        throw adoptionError(
          "PERSONAL_DEDICATED_ADOPTION_CATALOG_RESTORE_REQUIRED",
          "The selected Dedicated target requires the catalogue restore workflow before activation",
          params,
        );
      }

      const restoreDirective =
        activationAuthority?.kind === "fresh-boot"
          ? ({
              kind: "reviewed-fresh-boot",
              selectionId: resolution.selectionActivationReceiptId!,
            } as const)
          : activationAuthority?.kind === "from-legacy-backup"
            ? ({
                kind: "from-reviewed-backup",
                selectionId: resolution.selectionActivationReceiptId!,
                backupId: activationAuthority.backupId,
                expectedContentHash: activationAuthority.backupHash,
                expectedBackupChain: activationAuthority.backupChain,
              } as const)
            : undefined;

      const enqueue = await provisioningJobService.enqueueAgentProvisionOnceInTx(tx, {
        agentId: target.id,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: target.agent_name ?? target.id,
        restoreDirective,
      });
      attemptedResult = {
        agent: target,
        alreadyAdopted,
        job: enqueue.job,
        jobCreated: enqueue.created,
      };
      return attemptedResult;
    });
  } catch (error) {
    // error-policy:J1 the transaction boundary classifies a rejection against
    // fresh durable state before deciding whether to recover or rethrow it.
    const recovered = await resolveAdoptionOutcomeAfterBoundaryRejection(
      params,
      attemptedResult,
      error,
    );
    if (recovered) return recovered;
    throw error;
  }
}

/**
 * Recover a lost COMMIT acknowledgement only after a fresh durable read proves
 * this exact owner target now carries the server receipt. The callback result
 * preserves whether this transaction created the job, so a recovered commit
 * still receives the same immediate-worker nudge as an acknowledged commit.
 */
async function resolveAdoptionOutcomeAfterBoundaryRejection(
  params: AdoptPersonalDedicatedTargetParams,
  attemptedResult: AdoptPersonalDedicatedTargetResult | undefined,
  rejection: unknown,
): Promise<AdoptPersonalDedicatedTargetResult | null> {
  if (!attemptedResult) return null;
  let durable: PersonalDedicatedAdoptionResolution;
  try {
    durable = await resolvePersonalDedicatedAdoption(params);
  } catch (verificationError) {
    // error-policy:J2 the original boundary rejection remains authoritative;
    // record why its commit state could not be classified on a fresh read.
    logger.error("[agent-tier-adoption] Could not verify durability after a boundary rejection", {
      sourceAgentId: params.sourceAgentId,
      dedicatedAgentId: params.expectedTargetId,
      orgId: params.organizationId,
      rejection: rejection instanceof Error ? rejection.message : String(rejection),
      verificationError:
        verificationError instanceof Error ? verificationError.message : String(verificationError),
    });
    return null;
  }
  if (
    durable.state !== "adopted" ||
    durable.agent.id !== params.expectedTargetId ||
    durable.agent.user_id !== params.userId
  ) {
    return null;
  }

  let durableJob: Job | null = null;
  if (attemptedResult.job) {
    try {
      durableJob = await findTierUpgradeProvisionJobById(
        params.organizationId,
        params.expectedTargetId,
        attemptedResult.job.id,
      );
    } catch (verificationError) {
      // error-policy:J2 preserve the original boundary rejection when the job
      // half of the atomic commit cannot be verified on the fresh connection.
      logger.error(
        "[agent-tier-adoption] Could not verify the durable provision job after a boundary rejection",
        {
          sourceAgentId: params.sourceAgentId,
          dedicatedAgentId: params.expectedTargetId,
          jobId: attemptedResult.job.id,
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
    if (!durableJob) return null;
  }
  logger.warn(
    "[agent-tier-adoption] Boundary transaction rejected after a durable commit; recovered adoption",
    {
      sourceAgentId: params.sourceAgentId,
      dedicatedAgentId: params.expectedTargetId,
      orgId: params.organizationId,
      jobId: durableJob?.id ?? null,
      triggerImmediate: attemptedResult.jobCreated,
      rejection: rejection instanceof Error ? rejection.message : String(rejection),
    },
  );
  return {
    ...attemptedResult,
    agent: durable.agent,
    ...(durableJob ? { job: durableJob } : {}),
  };
}

async function findLiveTargetInTx(
  tx: DbTransaction,
  organizationId: string,
  sourceAgentId: string,
): Promise<AgentSandbox | undefined> {
  const [existing] = await tx
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedUpgradeAuthorities,
      eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
    )
    .where(
      and(
        liveTargetWhere(organizationId),
        eq(personalDedicatedUpgradeAuthorities.organization_id, organizationId),
        eq(personalDedicatedUpgradeAuthorities.organization_id, agentSandboxes.organization_id),
        eq(personalDedicatedUpgradeAuthorities.user_id, agentSandboxes.user_id),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, sourceAgentId),
        eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
      ),
    )
    .orderBy(desc(agentSandboxes.created_at))
    .limit(1);
  if (existing) return existing.agent;
  const [quarantined] = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(
        liveTargetWhere(organizationId),
        sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY} = ${sourceAgentId}`,
        notExists(
          tx
            .select({ id: personalDedicatedUpgradeAuthorities.id })
            .from(personalDedicatedUpgradeAuthorities)
            .where(eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id)),
        ),
      ),
    )
    .limit(1);
  if (quarantined) {
    throw new PersonalDedicatedAuthorityError("Unverified tier-upgrade marker is quarantined", {
      code: "PERSONAL_DEDICATED_AUTHORITY_UNVERIFIED",
      context: { organizationId, sourceAgentId, dedicatedAgentId: quarantined.id },
    });
  }
  return undefined;
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
    .select({ agent: agentSandboxes })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedUpgradeAuthorities,
      eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
    )
    .where(
      and(
        liveTargetWhere(organizationId),
        eq(personalDedicatedUpgradeAuthorities.organization_id, organizationId),
        eq(personalDedicatedUpgradeAuthorities.organization_id, agentSandboxes.organization_id),
        eq(personalDedicatedUpgradeAuthorities.user_id, agentSandboxes.user_id),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, sourceAgentId),
        eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
      ),
    )
    .orderBy(desc(agentSandboxes.created_at))
    .limit(1);
  if (existing) return existing.agent;
  const [quarantined] = await dbWrite
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(
        liveTargetWhere(organizationId),
        sql`${agentSandboxes.agent_config} ->> ${AGENT_UPGRADED_FROM_KEY} = ${sourceAgentId}`,
        notExists(
          dbWrite
            .select({ id: personalDedicatedUpgradeAuthorities.id })
            .from(personalDedicatedUpgradeAuthorities)
            .where(eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id)),
        ),
      ),
    )
    .limit(1);
  if (quarantined) {
    throw new PersonalDedicatedAuthorityError("Unverified tier-upgrade marker is quarantined", {
      code: "PERSONAL_DEDICATED_AUTHORITY_UNVERIFIED",
      context: { organizationId, sourceAgentId, dedicatedAgentId: quarantined.id },
    });
  }
  return null;
}

/**
 * Resolve the Dedicated target that has completed the personal-Eliza cutover.
 * A merely running migration target is not authoritative: Shared continues to
 * serve until transcript import and this server-owned receipt both succeed.
 * Afterward the receipt stays authoritative through sleep/error/restart states;
 * silently falling back would split later turns into the archived Shared log.
 */
export async function findActivePersonalDedicatedTarget(
  organizationId: string,
  userId: string,
  sourceAgentId: string,
): Promise<AgentSandbox | null> {
  const [row] = await dbWrite
    .select({ agent: agentSandboxes, authority: personalDedicatedUpgradeAuthorities })
    .from(agentSandboxes)
    .innerJoin(
      personalDedicatedUpgradeAuthorities,
      eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
    )
    .where(
      and(
        eq(agentSandboxes.organization_id, organizationId),
        eq(agentSandboxes.user_id, userId),
        eq(agentSandboxes.execution_tier, "dedicated-always"),
        eq(personalDedicatedUpgradeAuthorities.organization_id, organizationId),
        eq(personalDedicatedUpgradeAuthorities.user_id, userId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, sourceAgentId),
      ),
    )
    .orderBy(desc(agentSandboxes.created_at))
    .limit(1);
  if (row) {
    if (row.authority.schema_version !== 1) {
      throw new PersonalDedicatedAuthorityError(
        "Personal Dedicated authority version is unsupported",
        {
          code: "PERSONAL_DEDICATED_AUTHORITY_INVALID",
          context: { organizationId, userId, sourceAgentId, dedicatedAgentId: row.agent.id },
        },
      );
    }
    const cutover = cutoverFromAuthority(row.authority);
    if (!cutover) {
      if (row.authority.cutover_token === null) return null;
      throw new PersonalDedicatedAuthorityError("Personal Dedicated cutover receipt is malformed", {
        code: "PERSONAL_DEDICATED_AUTHORITY_INVALID",
        context: { organizationId, userId, sourceAgentId, dedicatedAgentId: row.agent.id },
      });
    }
    return withAuthorityProjection(row.agent, row.authority);
  }

  const [quarantined] = await dbWrite
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(unverifiedReservedMarkerWhere(organizationId, userId))
    .limit(1);
  if (quarantined) {
    throw new PersonalDedicatedAuthorityError(
      "Unverified personal Dedicated marker is quarantined",
      {
        code: "PERSONAL_DEDICATED_AUTHORITY_UNVERIFIED",
        context: { organizationId, userId, sourceAgentId, dedicatedAgentId: quarantined.id },
      },
    );
  }
  return null;
}

export class PersonalDedicatedAuthorityError extends ElizaError {
  override readonly name = "PersonalDedicatedAuthorityError";
}

function cutoverFromAuthority(
  authority: PersonalDedicatedUpgradeAuthority,
): ReturnType<typeof readPersonalElizaCutover> {
  if (
    authority.schema_version !== 1 ||
    !authority.cutover_token ||
    authority.shared_message_count === null ||
    authority.shared_scheduled_task_count === null ||
    authority.shared_todo_count === null ||
    authority.shared_todo_mutation_count === null ||
    !authority.shared_todo_digest ||
    !authority.cutover_activated_at
  ) {
    return null;
  }
  return readPersonalElizaCutover({
    [AGENT_PERSONAL_CUTOVER_KEY]: {
      mode: "dedicated",
      sourceAgentId: authority.source_agent_id,
      conversationId: authority.source_agent_id,
      cutoverToken: authority.cutover_token,
      sharedMessageCount: authority.shared_message_count,
      sharedScheduledTaskCount: authority.shared_scheduled_task_count,
      sharedTodoCount: authority.shared_todo_count,
      sharedTodoMutationCount: authority.shared_todo_mutation_count,
      sharedTodoDigest: authority.shared_todo_digest,
      activatedAt: authority.cutover_activated_at.toISOString(),
    },
  });
}

function withAuthorityProjection(
  target: AgentSandbox,
  authority: PersonalDedicatedUpgradeAuthority,
): AgentSandbox {
  const cutover = cutoverFromAuthority(authority);
  return {
    ...target,
    agent_config: {
      ...stripReservedElizaConfigKeys(target.agent_config as Record<string, unknown> | null),
      [AGENT_UPGRADED_FROM_KEY]: authority.source_agent_id,
      ...(cutover ? { [AGENT_PERSONAL_CUTOVER_KEY]: cutover } : {}),
    },
  };
}

export type PersonalDedicatedCutoverRecovery =
  | { state: "absent" }
  | { state: "conflict" }
  | { state: "committed"; agent: AgentSandbox; userId: string };

/**
 * Recover a pending DO seal from canonical DB authority. Legacy seals omit
 * userId, so the exact user is derived from the receipt instead of caller or
 * stale Durable Object data. Any mismatched or duplicate authority fails
 * closed as a conflict; only a proven absence releases Shared.
 */
export async function resolvePersonalDedicatedCutoverRecovery(params: {
  organizationId: string;
  userId?: string;
  sourceAgentId: string;
  dedicatedAgentId: string;
}): Promise<PersonalDedicatedCutoverRecovery> {
  const rows = await dbWrite
    .select({ agent: agentSandboxes, authority: personalDedicatedUpgradeAuthorities })
    .from(personalDedicatedUpgradeAuthorities)
    .innerJoin(
      agentSandboxes,
      eq(agentSandboxes.id, personalDedicatedUpgradeAuthorities.dedicated_agent_id),
    )
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
        eq(agentSandboxes.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.organization_id, agentSandboxes.organization_id),
        eq(personalDedicatedUpgradeAuthorities.user_id, agentSandboxes.user_id),
        eq(agentSandboxes.execution_tier, "dedicated-always"),
      ),
    )
    .limit(2);
  if (rows.length === 0) {
    const [quarantined] = await dbWrite
      .select({ id: agentSandboxes.id })
      .from(agentSandboxes)
      .where(
        and(
          liveTargetWhere(params.organizationId),
          eq(agentSandboxes.id, params.dedicatedAgentId),
          ...(params.userId ? [eq(agentSandboxes.user_id, params.userId)] : []),
          or(
            sql`COALESCE(${agentSandboxes.agent_config}, '{}'::jsonb) ? ${AGENT_UPGRADED_FROM_KEY}`,
            sql`COALESCE(${agentSandboxes.agent_config}, '{}'::jsonb) ? ${AGENT_PERSONAL_CUTOVER_KEY}`,
          ),
          notExists(
            dbWrite
              .select({ id: personalDedicatedUpgradeAuthorities.id })
              .from(personalDedicatedUpgradeAuthorities)
              .where(
                and(
                  eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
                  eq(personalDedicatedUpgradeAuthorities.schema_version, 1),
                ),
              ),
          ),
        ),
      )
      .limit(1);
    return quarantined ? { state: "conflict" } : { state: "absent" };
  }
  if (rows.length !== 1) return { state: "conflict" };
  const [{ agent, authority }] = rows;
  if (
    agent.id !== params.dedicatedAgentId ||
    agent.user_id !== authority.user_id ||
    (params.userId !== undefined && params.userId !== authority.user_id) ||
    !cutoverFromAuthority(authority)
  ) {
    return { state: "conflict" };
  }
  return {
    state: "committed",
    agent: withAuthorityProjection(agent, authority),
    userId: authority.user_id,
  };
}

/**
 * Atomically make one healthy Dedicated migration target authoritative after
 * the caller has completed the server-owned transcript import. The per-source
 * lock serializes completion with retry/reprovision activity, and an exact
 * existing cutover receipt is an idempotent success.
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
    const [row] = await tx
      .select({ agent: agentSandboxes, authority: personalDedicatedUpgradeAuthorities })
      .from(agentSandboxes)
      .innerJoin(
        personalDedicatedUpgradeAuthorities,
        eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, agentSandboxes.id),
      )
      .where(
        and(
          liveTargetWhere(params.organizationId),
          eq(agentSandboxes.id, params.dedicatedAgentId),
          eq(agentSandboxes.user_id, params.userId),
          eq(agentSandboxes.status, "running"),
          exactAuthorityWhere(params.organizationId, params.userId, params.sourceAgentId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) {
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
    const target = row.agent;

    const existing = cutoverFromAuthority(row.authority);
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
      const projected = withAuthorityProjection(target, row.authority);
      const current = readPersonalElizaCutover(target.agent_config);
      const targetConfig = target.agent_config as Record<string, unknown> | null;
      if (
        targetConfig?.[AGENT_UPGRADED_FROM_KEY] === params.sourceAgentId &&
        current?.sourceAgentId === existing.sourceAgentId &&
        current.cutoverToken === existing.cutoverToken &&
        current.sharedMessageCount === existing.sharedMessageCount &&
        current.sharedScheduledTaskCount === existing.sharedScheduledTaskCount &&
        current.sharedTodoCount === existing.sharedTodoCount &&
        current.sharedTodoMutationCount === existing.sharedTodoMutationCount &&
        current.sharedTodoDigest === existing.sharedTodoDigest &&
        current.activatedAt === existing.activatedAt
      ) {
        return projected;
      }
      const [rehydrated] = await tx
        .update(agentSandboxes)
        .set({ agent_config: projected.agent_config, updated_at: new Date() })
        .where(eq(agentSandboxes.id, target.id))
        .returning();
      if (!rehydrated) {
        throw new ElizaError("Failed to rehydrate personal Dedicated cutover projection", {
          code: "PERSONAL_DEDICATED_CUTOVER_UPDATE_FAILED",
          context: { sourceAgentId: params.sourceAgentId, dedicatedAgentId: target.id },
        });
      }
      return rehydrated;
    }

    const activatedAt = sameCutover ? row.authority.cutover_activated_at! : new Date();
    const [updatedAuthority] = await tx
      .update(personalDedicatedUpgradeAuthorities)
      .set({
        cutover_token: params.cutoverToken,
        shared_message_count: params.sharedMessageCount,
        shared_scheduled_task_count: params.sharedScheduledTaskCount,
        shared_todo_count: params.sharedTodoCount,
        shared_todo_mutation_count: params.sharedTodoMutationCount,
        shared_todo_digest: params.sharedTodoDigest,
        cutover_activated_at: activatedAt,
        updated_at: new Date(),
      })
      .where(eq(personalDedicatedUpgradeAuthorities.id, row.authority.id))
      .returning();
    if (!updatedAuthority) {
      throw new ElizaError("Failed to persist personal Dedicated cutover authority", {
        code: "PERSONAL_DEDICATED_CUTOVER_AUTHORITY_UPDATE_FAILED",
        context: { sourceAgentId: params.sourceAgentId, dedicatedAgentId: target.id },
      });
    }

    const cutover = cutoverFromAuthority(updatedAuthority);
    if (!cutover) {
      throw new ElizaError("Personal Dedicated cutover authority failed validation", {
        code: "PERSONAL_DEDICATED_CUTOVER_AUTHORITY_INVALID",
      });
    }
    const [updated] = await tx
      .update(agentSandboxes)
      .set({
        agent_config: {
          ...stripReservedElizaConfigKeys(target.agent_config as Record<string, unknown> | null),
          [AGENT_UPGRADED_FROM_KEY]: params.sourceAgentId,
          [AGENT_PERSONAL_CUTOVER_KEY]: cutover,
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

/** Exact durable job read used when a COMMIT acknowledgement is ambiguous. */
async function findTierUpgradeProvisionJobById(
  organizationId: string,
  agentId: string,
  jobId: string,
): Promise<Job | null> {
  const [job] = await dbWrite
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.type, JOB_TYPES.AGENT_PROVISION),
        eq(jobs.organization_id, organizationId),
        eq(jobs.agent_id, agentId),
      ),
    )
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
    await assertNoExistingAdoptionCandidateInTx(tx, params);
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
      await assertNoExistingAdoptionCandidateInTx(tx, params);

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
            // from caller config; the upgraded-from value is a compatibility
            // projection while the adjacent receipt remains authoritative.
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

      await tx.insert(personalDedicatedUpgradeAuthorities).values({
        organization_id: params.organizationId,
        user_id: params.userId,
        source_agent_id: params.sourceAgentId,
        dedicated_agent_id: created.id,
        schema_version: 1,
      });

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
