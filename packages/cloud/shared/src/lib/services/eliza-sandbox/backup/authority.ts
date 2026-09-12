/** Checks snapshot and restore ownership against canonical revisions and guarded database transactions. Reviewed restore admission holds its existing fence until the caller explicitly releases it. */

import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import {
  type AgentSandbox,
  type AgentSandboxBackup,
  agentSandboxesRepository,
  reconstructStoredAgentSandboxBackupChain,
} from "../../../../db/repositories/agent-sandboxes";
import {
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
  type StoredAgentSandboxBackup,
} from "../../../../db/schemas/agent-sandboxes";
import { personalDedicatedAdoptionSelections } from "../../../../db/schemas/personal-dedicated-adoption-selections";
import { ApiError } from "../../../api/cloud-worker-errors";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "../../eliza-provision-lock";
import {
  personalDedicatedActivationAuthority,
  personalDedicatedActivationAuthorityFromReceipt,
  personalDedicatedActivationAuthorityKey,
  personalDedicatedBackupProvenanceFromStored,
} from "../../personal-dedicated-adoption-provenance";
import { isContainerBackedExecutionTier } from "../../sandbox-provider-types";
import {
  ProvisionRestoreOverride,
  ReviewedProvisionAuthorityOverride,
  ReviewedProvisionRestoreOverride,
} from "./restore-contract.js";

export type SnapshotAuthorityCapture = Pick<
  AgentSandbox,
  | "id"
  | "organization_id"
  | "status"
  | "execution_tier"
  | "pool_status"
  | "deleted_at"
  | "deletion_attempt_id"
  | "sandbox_id"
  | "node_id"
  | "container_name"
  | "bridge_url"
  | "health_url"
  | "bridge_port"
  | "web_ui_port"
  | "headscale_ip"
  | "environment_revision"
  | "lifecycle_revision"
>;

export const SNAPSHOT_AUTHORITY_CHANGED = "Sandbox changed while snapshot was being captured";

export function snapshotAuthorityRejection(rec: SnapshotAuthorityCapture): string | undefined {
  if (!isContainerBackedExecutionTier(rec.execution_tier)) {
    return "Agent snapshot requires a container-backed execution tier";
  }
  if (rec.pool_status !== null) {
    return "Agent snapshot cannot target pool-owned capacity";
  }
  if (rec.deleted_at !== null) {
    return "Agent snapshot cannot target a deleted agent";
  }
  if (rec.deletion_attempt_id !== null) {
    return "Agent snapshot cannot start while agent deletion is in progress";
  }
  return undefined;
}

export function snapshotCaptureStillCanonical(
  current: SnapshotAuthorityCapture,
  captured: SnapshotAuthorityCapture,
): boolean {
  return (
    current.id === captured.id &&
    current.organization_id === captured.organization_id &&
    current.status === captured.status &&
    current.execution_tier === captured.execution_tier &&
    current.pool_status === captured.pool_status &&
    (current.deleted_at?.getTime() ?? null) === (captured.deleted_at?.getTime() ?? null) &&
    current.deletion_attempt_id === captured.deletion_attempt_id &&
    current.sandbox_id === captured.sandbox_id &&
    current.node_id === captured.node_id &&
    current.container_name === captured.container_name &&
    current.bridge_url === captured.bridge_url &&
    current.health_url === captured.health_url &&
    current.bridge_port === captured.bridge_port &&
    current.web_ui_port === captured.web_ui_port &&
    current.headscale_ip === captured.headscale_ip &&
    current.environment_revision === captured.environment_revision &&
    current.lifecycle_revision === captured.lifecycle_revision
  );
}

export type RestoreAuthorityCapture = SnapshotAuthorityCapture;

export const RESTORE_AUTHORITY_CHANGED = "Sandbox changed while restore was being prepared";

export const RESTORE_BACKUP_CHANGED = "Backup changed while restore was being prepared";

export function restoreAuthorityRejection(rec: RestoreAuthorityCapture): string | undefined {
  if (!isContainerBackedExecutionTier(rec.execution_tier)) {
    return "Agent restore requires a container-backed execution tier";
  }
  if (rec.pool_status !== null) {
    return "Agent restore cannot target pool-owned capacity";
  }
  if (rec.deleted_at !== null) {
    return "Agent restore cannot target a deleted agent";
  }
  if (rec.deletion_attempt_id !== null) {
    return "Agent restore cannot start while agent deletion is in progress";
  }
  return undefined;
}

export function restoreCaptureStillCanonical(
  current: RestoreAuthorityCapture,
  captured: RestoreAuthorityCapture,
): boolean {
  return snapshotCaptureStillCanonical(current, captured);
}

/**
 * Bind a reconstructed payload to the exact legacy-visible backup row that
 * selected it. Verification/catalogue bookkeeping may change independently,
 * but the payload locator, chain identity, and restore semantics may not.
 */
export function storedRestorePointStillCanonical(
  current: StoredAgentSandboxBackup,
  captured: StoredAgentSandboxBackup,
): boolean {
  return (
    current.id === captured.id &&
    current.sandbox_record_id === captured.sandbox_record_id &&
    current.snapshot_type === captured.snapshot_type &&
    current.state_data_storage === captured.state_data_storage &&
    current.state_data_key === captured.state_data_key &&
    current.size_bytes === captured.size_bytes &&
    current.backup_kind === captured.backup_kind &&
    current.parent_backup_id === captured.parent_backup_id &&
    current.base_backup_id === captured.base_backup_id &&
    current.content_hash === captured.content_hash &&
    current.catalog_state === captured.catalog_state &&
    current.created_at.getTime() === captured.created_at.getTime() &&
    JSON.stringify(current.state_data) === JSON.stringify(captured.state_data)
  );
}

export const MAX_RESTORE_AUTHORITY_CHAIN_DEPTH = 100;

/** Capture every legacy-visible row needed to reconstruct one restore point. */
export async function captureStoredRestoreChain(
  backupId: string,
  sandboxRecordId: string,
): Promise<StoredAgentSandboxBackup[] | undefined> {
  const chain: StoredAgentSandboxBackup[] = [];
  const seen = new Set<string>();
  let cursorId: string | null = backupId;

  while (cursorId) {
    if (seen.has(cursorId)) throw new Error(`Backup chain cycle at ${cursorId}`);
    seen.add(cursorId);
    const cursor = await agentSandboxesRepository.getStoredBackupById(cursorId);
    if (!cursor || cursor.sandbox_record_id !== sandboxRecordId) return undefined;
    chain.push(cursor);
    if (cursor.backup_kind === "full") return chain;
    if (!cursor.parent_backup_id) {
      throw new Error(`Incremental backup ${cursor.id} has no parent`);
    }
    if (chain.length > MAX_RESTORE_AUTHORITY_CHAIN_DEPTH) {
      throw new Error(
        `Backup chain for ${backupId} exceeds ${MAX_RESTORE_AUTHORITY_CHAIN_DEPTH} rows`,
      );
    }
    cursorId = cursor.parent_backup_id;
  }

  return undefined;
}

export function storedRestoreChainStillCanonical(
  current: StoredAgentSandboxBackup[],
  captured: StoredAgentSandboxBackup[],
): boolean {
  if (current.length !== captured.length) return false;
  const currentById = new Map(current.map((row) => [row.id, row]));
  return captured.every((row) => {
    const candidate = currentById.get(row.id);
    return candidate !== undefined && storedRestorePointStillCanonical(candidate, row);
  });
}

export function storedRestoreChainMatchesReviewedAuthority(
  storedChain: readonly StoredAgentSandboxBackup[],
  sandboxRecordId: string,
  directive: ReviewedProvisionRestoreOverride,
): boolean {
  if (
    storedChain.length !== directive.expectedBackupChain.length ||
    directive.expectedBackupChain[0]?.backupId !== directive.backupId ||
    directive.expectedBackupChain[0]?.contentHash !== directive.expectedContentHash
  ) {
    return false;
  }
  const expectedById = new Map(
    directive.expectedBackupChain.map((entry) => [entry.backupId, entry]),
  );
  return storedChain.every((stored) => {
    const expected = expectedById.get(stored.id);
    return (
      expected !== undefined &&
      stored.id === expected.backupId &&
      stored.sandbox_record_id === sandboxRecordId &&
      stored.backup_kind === expected.backupKind &&
      stored.parent_backup_id === expected.parentBackupId &&
      stored.content_hash === expected.contentHash &&
      stored.verification_status === "verified" &&
      stored.verified_at !== null &&
      stored.catalog_version === expected.catalogVersion &&
      stored.catalog_state === expected.catalogState &&
      stored.catalog_deleted_at === null
    );
  });
}

export function reviewedProvisionAuthorityHash(
  directive: ReviewedProvisionAuthorityOverride,
): string {
  return crypto.createHash("sha256").update(JSON.stringify(directive)).digest("hex");
}

export async function assertReviewedSelectionReceipt(
  sandboxRecordId: string,
  directive: ReviewedProvisionAuthorityOverride,
): Promise<typeof personalDedicatedAdoptionSelections.$inferSelect> {
  const [selection] = await dbWrite
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.id, directive.selectionId),
        eq(personalDedicatedAdoptionSelections.dedicated_agent_id, sandboxRecordId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1);
  if (!selection) throw new Error(RESTORE_BACKUP_CHANGED);
  const receiptAuthority = personalDedicatedActivationAuthorityFromReceipt(
    selection.activation_kind,
    selection.activation_backup_id,
    selection.activation_backup_hash,
    selection.activation_backup_chain,
  );
  if (directive.kind === "reviewed-fresh-boot") {
    if (receiptAuthority?.kind !== "fresh-boot") throw new Error(RESTORE_BACKUP_CHANGED);
    return selection;
  }
  if (
    receiptAuthority?.kind !== "from-legacy-backup" ||
    personalDedicatedActivationAuthorityKey(receiptAuthority) !==
      personalDedicatedActivationAuthorityKey({
        kind: "from-legacy-backup",
        backupId: directive.backupId,
        backupHash: directive.expectedContentHash,
        backupChain: directive.expectedBackupChain,
      })
  ) {
    throw new Error(RESTORE_BACKUP_CHANGED);
  }
  return selection;
}

export async function assertReviewedFreshBootAuthority(
  sandboxRecordId: string,
  directive: Extract<ProvisionRestoreOverride, { kind: "reviewed-fresh-boot" }>,
): Promise<void> {
  try {
    await assertReviewedSelectionActivationAuthority(sandboxRecordId, directive);
  } catch {
    throw new ApiError(
      409,
      "session_not_ready",
      "Reviewed fresh-boot authority changed before Dedicated provisioning",
    );
  }
}

export async function assertReviewedSelectionActivationAuthority(
  sandboxRecordId: string,
  directive: ReviewedProvisionAuthorityOverride,
): Promise<void> {
  const selection = await assertReviewedSelectionReceipt(sandboxRecordId, directive);
  const backups = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
    .orderBy(asc(agentSandboxBackups.id));
  const currentAuthority = personalDedicatedActivationAuthority(
    selection.organization_id,
    sandboxRecordId,
    backups.map(personalDedicatedBackupProvenanceFromStored),
  );
  const reviewedAuthority =
    directive.kind === "reviewed-fresh-boot"
      ? ({ kind: "fresh-boot" } as const)
      : ({
          kind: "from-legacy-backup",
          backupId: directive.backupId,
          backupHash: directive.expectedContentHash,
          backupChain: directive.expectedBackupChain,
        } as const);
  if (
    personalDedicatedActivationAuthorityKey(currentAuthority) !==
    personalDedicatedActivationAuthorityKey(reviewedAuthority)
  ) {
    throw new Error(RESTORE_BACKUP_CHANGED);
  }
}

export interface ReviewedProvisionAdmissionFence {
  selectionId: string;
  hash: string;
  reviewedRestore?: PreparedReviewedProvisionRestore;
}

export async function releaseReviewedProvisionAdmissionFence(
  fence: ReviewedProvisionAdmissionFence,
): Promise<void> {
  await dbWrite
    .update(personalDedicatedAdoptionSelections)
    .set({ restore_fence_hash: null, restore_fence_started_at: null, updated_at: new Date() })
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.id, fence.selectionId),
        eq(personalDedicatedAdoptionSelections.restore_fence_hash, fence.hash),
      ),
    );
}

export async function acquireReviewedProvisionAdmissionFence(
  sandboxRecordId: string,
  organizationId: string,
  directive: ReviewedProvisionAuthorityOverride,
): Promise<ReviewedProvisionAdmissionFence> {
  const hash = reviewedProvisionAuthorityHash(directive);
  await dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(organizationId, sandboxRecordId));
    const [agent] = await tx
      .select({ id: agentSandboxes.id })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, sandboxRecordId),
          eq(agentSandboxes.organization_id, organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!agent) throw new Error(RESTORE_AUTHORITY_CHANGED);
    const [selection] = await tx
      .select()
      .from(personalDedicatedAdoptionSelections)
      .where(
        and(
          eq(personalDedicatedAdoptionSelections.id, directive.selectionId),
          eq(personalDedicatedAdoptionSelections.organization_id, organizationId),
          eq(personalDedicatedAdoptionSelections.dedicated_agent_id, sandboxRecordId),
          eq(personalDedicatedAdoptionSelections.schema_version, 1),
        ),
      )
      .for("update")
      .limit(1);
    if (!selection || (selection.restore_fence_hash && selection.restore_fence_hash !== hash)) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    const receiptAuthority = personalDedicatedActivationAuthorityFromReceipt(
      selection.activation_kind,
      selection.activation_backup_id,
      selection.activation_backup_hash,
      selection.activation_backup_chain,
    );
    const expectedAuthority =
      directive.kind === "reviewed-fresh-boot"
        ? ({ kind: "fresh-boot" } as const)
        : ({
            kind: "from-legacy-backup",
            backupId: directive.backupId,
            backupHash: directive.expectedContentHash,
            backupChain: directive.expectedBackupChain,
          } as const);
    if (
      personalDedicatedActivationAuthorityKey(receiptAuthority) !==
      personalDedicatedActivationAuthorityKey(expectedAuthority)
    ) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    await tx
      .update(personalDedicatedAdoptionSelections)
      .set({
        restore_fence_hash: hash,
        restore_fence_started_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(personalDedicatedAdoptionSelections.id, selection.id));
  });

  const fence: ReviewedProvisionAdmissionFence = { selectionId: directive.selectionId, hash };
  try {
    if (directive.kind === "from-reviewed-backup") {
      fence.reviewedRestore = await assertReviewedProvisionRestoreAuthority(
        sandboxRecordId,
        directive,
      );
    } else {
      await assertReviewedFreshBootAuthority(sandboxRecordId, directive);
    }
    return fence;
  } catch (error) {
    await releaseReviewedProvisionAdmissionFence(fence);
    throw error;
  }
}

export interface PreparedReviewedProvisionRestore {
  storedChain: StoredAgentSandboxBackup[];
  backup: AgentSandboxBackup;
  state: AgentBackupStateData;
}

/**
 * Read, authenticate, decrypt, and reconstruct the exact reviewed chain before
 * provider admission. A second capture closes DB/R2 read races; the provision
 * path repeats this after the job-level check and carries the materialized
 * state to the final locked push rather than downgrading to a mutable id.
 */
export async function assertReviewedProvisionRestoreAuthority(
  sandboxRecordId: string,
  directive: ReviewedProvisionRestoreOverride,
): Promise<PreparedReviewedProvisionRestore> {
  try {
    await assertReviewedSelectionActivationAuthority(sandboxRecordId, directive);
    const storedChain = await captureStoredRestoreChain(directive.backupId, sandboxRecordId);
    if (
      !storedChain ||
      !storedRestoreChainMatchesReviewedAuthority(storedChain, sandboxRecordId, directive)
    ) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    const reconstructed = await reconstructStoredAgentSandboxBackupChain(storedChain);
    const confirmedChain = await captureStoredRestoreChain(directive.backupId, sandboxRecordId);
    if (
      !confirmedChain ||
      !storedRestoreChainStillCanonical(confirmedChain, storedChain) ||
      !storedRestoreChainMatchesReviewedAuthority(confirmedChain, sandboxRecordId, directive)
    ) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    return { storedChain, backup: reconstructed.target, state: reconstructed.state };
  } catch {
    throw new ApiError(
      409,
      "session_not_ready",
      "Reviewed backup authority changed before Dedicated provisioning",
    );
  }
}
