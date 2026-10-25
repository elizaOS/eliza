/** Non-secret, deterministic state binding for duplicate Dedicated selection. */

import { hasAgentBackupRestoreAuthority } from "../../db/repositories/agent-backup-restore-authority";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import type {
  AgentBackupCatalogState,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";

export type PersonalDedicatedStateDisposition =
  | "verified_backup_present"
  | "fresh_boot_no_verified_backup";

export interface PersonalDedicatedReviewedBackupChainEntry {
  backupId: string;
  backupKind: "full" | "incremental";
  parentBackupId: string | null;
  contentHash: string;
  catalogVersion: number | null;
  catalogState: string | null;
}

export type PersonalDedicatedActivationAuthority =
  | { kind: "fresh-boot" }
  | {
      kind: "from-legacy-backup";
      backupId: string;
      backupHash: string;
      backupChain: PersonalDedicatedReviewedBackupChainEntry[];
    }
  | { kind: "catalog-restore-required"; backupId: string; backupHash: string };

export interface PersonalDedicatedBackupProvenance {
  id: string;
  sandboxRecordId: string | null;
  snapshotType: string;
  stateDataStorage: string;
  stateDataKey: string | null;
  backupKind: string;
  parentBackupId: string | null;
  contentHash: string | null;
  verificationStatus: string | null;
  verifiedAt: Date | null;
  catalogVersion: number | null;
  catalogState: AgentBackupCatalogState | null;
  catalogPayloadDigest: string | null;
  catalogRevision: bigint;
  catalogOrganizationId: string | null;
  catalogAgentId: string | null;
  sourceProvider: string | null;
  sourceNodeRecordId: string | null;
  sourceNodeId: string | null;
  sourceProviderServerId: string | null;
  sourceProviderHandle: string | null;
  sourceContainerId: string | null;
  manifestVersion: number | null;
  manifestDigest: string | null;
  objectInventoryDigest: string | null;
  imageDigest: string | null;
  databaseSchemaVersion: string | null;
  pluginSetDigest: string | null;
  watermarkDigest: string | null;
  restoreReceiptDigest: string | null;
  catalogDeletedAt: Date | null;
  createdAt: Date;
}

export function personalDedicatedBackupProvenanceFromStored(
  backup: StoredAgentSandboxBackup,
): PersonalDedicatedBackupProvenance {
  return {
    id: backup.id,
    sandboxRecordId: backup.sandbox_record_id,
    snapshotType: backup.snapshot_type,
    stateDataStorage: backup.state_data_storage,
    stateDataKey: backup.state_data_key,
    backupKind: backup.backup_kind,
    parentBackupId: backup.parent_backup_id,
    contentHash: backup.content_hash,
    verificationStatus: backup.verification_status,
    verifiedAt: backup.verified_at,
    catalogVersion: backup.catalog_version,
    catalogState: backup.catalog_state,
    catalogPayloadDigest: backup.catalog_payload_digest,
    catalogRevision: backup.catalog_revision,
    catalogOrganizationId: backup.catalog_organization_id,
    catalogAgentId: backup.catalog_agent_id,
    sourceProvider: backup.source_provider,
    sourceNodeRecordId: backup.source_node_record_id,
    sourceNodeId: backup.source_node_id,
    sourceProviderServerId: backup.source_provider_server_id,
    sourceProviderHandle: backup.source_provider_handle,
    sourceContainerId: backup.source_container_id,
    manifestVersion: backup.manifest_version,
    manifestDigest: backup.manifest_digest,
    objectInventoryDigest: backup.object_inventory_digest,
    imageDigest: backup.image_digest,
    databaseSchemaVersion: backup.database_schema_version,
    pluginSetDigest: backup.plugin_set_digest,
    watermarkDigest: backup.watermark_digest,
    restoreReceiptDigest: backup.restore_receipt_digest,
    catalogDeletedAt: backup.catalog_deleted_at,
    createdAt: backup.created_at,
  };
}

const FINGERPRINT_VERSION = "personal-dedicated-selection-v2";

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Bind every non-secret state authority that determines whether activation
 * restores prior state or starts clean. Raw database, environment, node, and
 * provider coordinates are only inputs to the one-way composite digest and
 * are never returned to an API caller.
 */
export async function personalDedicatedInventoryFingerprint(params: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  retainedAgentId: string;
  candidates: AgentSandbox[];
  backups: PersonalDedicatedBackupProvenance[];
}): Promise<string> {
  const candidates = [...params.candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      lifecycleRevision: candidate.lifecycle_revision,
      environmentRevision: candidate.environment_revision,
      environmentDigestInput: candidate.environment_vars,
      databaseStatus: candidate.database_status,
      databaseIdentityDigestInput: candidate.database_uri,
      snapshotId: candidate.snapshot_id,
      lastBackupAt: candidate.last_backup_at,
      lastBackupAttemptAt: candidate.last_backup_attempt_at,
      backupUnsupportedReason: candidate.backup_unsupported_reason,
      nodeIdentityDigestInput: candidate.node_id,
      containerIdentityDigestInput: candidate.container_name,
      imageReferenceDigestInput: candidate.docker_image,
      imageDigest: candidate.image_digest,
      previousImageDigest: candidate.previous_image_digest,
      billingStatus: candidate.billing_status,
      hourlyRate: candidate.hourly_rate,
      scheduledShutdownAt: candidate.scheduled_shutdown_at,
      activationPhase: candidate.activation_phase,
      activationBackupId: candidate.activation_backup_id,
      activationBackupHash: candidate.activation_backup_hash,
      activationReceiptHash: candidate.activation_receipt_hash,
      activationImageDigest: candidate.activation_image_digest,
    }));
  const backups = [...params.backups]
    .sort((left, right) => {
      const sandboxOrder = (left.sandboxRecordId ?? "").localeCompare(right.sandboxRecordId ?? "");
      return sandboxOrder || left.id.localeCompare(right.id);
    })
    .map((backup) => ({
      ...backup,
      // Periodic verification rewrites its observation timestamp even when the
      // exact payload remains healthy. Bind presence, not that mutable clock.
      verifiedAt: backup.verifiedAt instanceof Date,
    }));
  return await sha256(
    JSON.stringify(
      canonical({
        version: FINGERPRINT_VERSION,
        organizationId: params.organizationId,
        userId: params.userId,
        sourceAgentId: params.sourceAgentId,
        retainedAgentId: params.retainedAgentId,
        candidates,
        backups,
      }),
    ),
  );
}

function backupCreatedAtDescending(
  left: PersonalDedicatedBackupProvenance,
  right: PersonalDedicatedBackupProvenance,
): number {
  return right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id);
}

function isSha256Digest(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{64}$/.test(value);
}

function reviewedLegacyBackupChain(
  selected: PersonalDedicatedBackupProvenance,
  retainedAgentId: string,
  backups: PersonalDedicatedBackupProvenance[],
): PersonalDedicatedReviewedBackupChainEntry[] | undefined {
  const byId = new Map(backups.map((backup) => [backup.id, backup]));
  const chain: PersonalDedicatedReviewedBackupChainEntry[] = [];
  const seen = new Set<string>();
  let cursor: PersonalDedicatedBackupProvenance | undefined = selected;
  while (cursor) {
    if (seen.has(cursor.id) || cursor.sandboxRecordId !== retainedAgentId) return undefined;
    if (!cursor.contentHash || !/^[a-f0-9]{64}$/.test(cursor.contentHash)) return undefined;
    if (cursor.backupKind !== "full" && cursor.backupKind !== "incremental") return undefined;
    if (
      cursor.verificationStatus !== "verified" ||
      !(cursor.verifiedAt instanceof Date) ||
      cursor.catalogDeletedAt !== null ||
      !(
        cursor.catalogVersion === null ||
        (cursor.catalogVersion === 1 && cursor.catalogState === "legacy_unmigrated")
      )
    ) {
      return undefined;
    }
    seen.add(cursor.id);
    chain.push({
      backupId: cursor.id,
      backupKind: cursor.backupKind,
      parentBackupId: cursor.parentBackupId,
      contentHash: cursor.contentHash,
      catalogVersion: cursor.catalogVersion,
      catalogState: cursor.catalogState,
    });
    if (chain.length > 100) return undefined;
    if (cursor.backupKind === "full") return chain;
    if (!cursor.parentBackupId) return undefined;
    cursor = byId.get(cursor.parentBackupId);
  }
  return undefined;
}

/**
 * Resolve the exact activation behavior reviewed by the selection receipt.
 * Catalogue-v2 payloads use a separate restore pipeline and therefore fail
 * closed here instead of being handed to legacy provisioning as a fresh boot.
 */
export function personalDedicatedActivationAuthority(
  organizationId: string,
  retainedAgentId: string,
  backups: PersonalDedicatedBackupProvenance[],
): PersonalDedicatedActivationAuthority {
  const restorable = backups
    .filter((backup) => {
      if (backup.sandboxRecordId !== retainedAgentId || backup.catalogDeletedAt !== null) {
        return false;
      }

      // Migration 0219 attached catalogue v1 / legacy_unmigrated metadata to
      // historical backups without moving them out of the legacy restore lane.
      const legacyVisible =
        backup.catalogVersion === null ||
        (backup.catalogVersion === 1 && backup.catalogState === "legacy_unmigrated");
      if (legacyVisible) {
        return (
          backup.verificationStatus === "verified" &&
          backup.verifiedAt instanceof Date &&
          Boolean(backup.contentHash)
        );
      }

      // Canonical catalogue restore authority is catalog-v2 + manifest-v3
      // protected by both providers. Earlier manifests and intermediate
      // upload/verification states are not executable restore points.
      return (
        backup.catalogVersion === 2 &&
        backup.catalogOrganizationId === organizationId &&
        backup.catalogAgentId === retainedAgentId &&
        backup.manifestVersion === 3 &&
        hasAgentBackupRestoreAuthority(backup.catalogState) &&
        isSha256Digest(backup.catalogPayloadDigest) &&
        isSha256Digest(backup.manifestDigest) &&
        isSha256Digest(backup.objectInventoryDigest)
      );
    })
    .sort(backupCreatedAtDescending);

  for (const selected of restorable) {
    if (selected.catalogVersion !== 2) {
      const backupChain = reviewedLegacyBackupChain(selected, retainedAgentId, backups);
      if (backupChain) {
        return {
          kind: "from-legacy-backup",
          backupId: selected.id,
          backupHash: selected.contentHash!,
          backupChain,
        };
      }
      continue;
    }
    // The restorable catalogue predicate above requires this digest.
    return {
      kind: "catalog-restore-required",
      backupId: selected.id,
      backupHash: selected.catalogPayloadDigest!,
    };
  }
  return { kind: "fresh-boot" };
}

export function personalDedicatedStateDisposition(
  organizationId: string,
  retainedAgentId: string,
  backups: PersonalDedicatedBackupProvenance[],
): PersonalDedicatedStateDisposition {
  return personalDedicatedActivationAuthority(organizationId, retainedAgentId, backups).kind ===
    "fresh-boot"
    ? "fresh_boot_no_verified_backup"
    : "verified_backup_present";
}

export function personalDedicatedActivationAuthorityKey(
  authority: PersonalDedicatedActivationAuthority | undefined,
): string {
  if (!authority) return "unreviewed-auto";
  if (authority.kind === "fresh-boot") return authority.kind;
  if (authority.kind === "catalog-restore-required") {
    return `${authority.kind}:${authority.backupId}:${authority.backupHash}`;
  }
  return `${authority.kind}:${authority.backupId}:${authority.backupHash}:${JSON.stringify(
    authority.backupChain.map((entry) => [
      entry.backupId,
      entry.backupKind,
      entry.parentBackupId,
      entry.contentHash,
      entry.catalogVersion,
      entry.catalogState,
    ]),
  )}`;
}

export function isPersonalDedicatedReviewedBackupChain(
  value: unknown,
): value is PersonalDedicatedReviewedBackupChainEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  if (
    !value.every(
      (entry): entry is PersonalDedicatedReviewedBackupChainEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { backupId?: unknown }).backupId === "string" &&
        ((entry as { backupKind?: unknown }).backupKind === "full" ||
          (entry as { backupKind?: unknown }).backupKind === "incremental") &&
        ((entry as { parentBackupId?: unknown }).parentBackupId === null ||
          typeof (entry as { parentBackupId?: unknown }).parentBackupId === "string") &&
        typeof (entry as { contentHash?: unknown }).contentHash === "string" &&
        /^[a-f0-9]{64}$/.test((entry as { contentHash: string }).contentHash) &&
        ((entry as { catalogVersion?: unknown }).catalogVersion === null ||
          (entry as { catalogVersion?: unknown }).catalogVersion === 1) &&
        ((entry as { catalogState?: unknown }).catalogState === null ||
          (entry as { catalogState?: unknown }).catalogState === "legacy_unmigrated"),
    )
  ) {
    return false;
  }
  const first = value[0];
  const last = value.at(-1);
  return (
    last?.backupKind === "full" &&
    last.parentBackupId === null &&
    value.every((entry, index) =>
      entry.backupKind === "full"
        ? index === value.length - 1 && entry.parentBackupId === null
        : entry.parentBackupId === value[index + 1]?.backupId,
    ) &&
    new Set(value.map((entry) => entry.backupId)).size === value.length &&
    Boolean(first)
  );
}

export function personalDedicatedActivationAuthorityFromReceipt(
  activationKind: string,
  backupId: string | null,
  backupHash: string | null,
  backupChain: unknown,
): PersonalDedicatedActivationAuthority | undefined {
  if (
    activationKind === "fresh_boot" &&
    backupId === null &&
    backupHash === null &&
    backupChain === null
  ) {
    return { kind: "fresh-boot" };
  }
  if (
    activationKind === "legacy_backup" &&
    backupId &&
    backupHash &&
    isPersonalDedicatedReviewedBackupChain(backupChain)
  ) {
    if (backupChain[0]?.backupId !== backupId || backupChain[0]?.contentHash !== backupHash) {
      return undefined;
    }
    return { kind: "from-legacy-backup", backupId, backupHash, backupChain };
  }
  if (
    activationKind === "catalog_restore_required" &&
    backupId &&
    backupHash &&
    backupChain === null
  ) {
    return { kind: "catalog-restore-required", backupId, backupHash };
  }
  return undefined;
}

export function personalDedicatedActivationAuthorityReceiptColumns(
  authority: PersonalDedicatedActivationAuthority,
): {
  activation_kind: string;
  activation_backup_id: string | null;
  activation_backup_hash: string | null;
  activation_backup_chain: PersonalDedicatedReviewedBackupChainEntry[] | null;
} {
  if (authority.kind === "fresh-boot") {
    return {
      activation_kind: "fresh_boot",
      activation_backup_id: null,
      activation_backup_hash: null,
      activation_backup_chain: null,
    };
  }
  return {
    activation_kind:
      authority.kind === "from-legacy-backup" ? "legacy_backup" : "catalog_restore_required",
    activation_backup_id: authority.backupId,
    activation_backup_hash: authority.backupHash,
    activation_backup_chain: authority.kind === "from-legacy-backup" ? authority.backupChain : null,
  };
}
