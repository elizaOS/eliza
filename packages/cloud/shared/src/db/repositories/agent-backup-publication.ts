/**
 * Reads the persisted primary-copy authority for post-capture replication.
 * The query is tenant-, operation-, lifecycle-, and execution-lease scoped so
 * secondary workers cannot accept a caller-supplied capture inventory.
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import { type AgentBackupObject, agentBackupObjects } from "../schemas/agent-backup-catalog";
import type { StoredAgentSandboxBackup } from "../schemas/agent-sandboxes";
import { agentSandboxBackups } from "../schemas/agent-sandboxes";
import {
  AgentBackupCatalogConflictError,
  type AgentBackupOperationExecution,
  agentBackupObjectInventoryDigest,
} from "./agent-backup-catalog";

const UINT64_MAX = 18_446_744_073_709_551_615n;
const PROTECTED_SPOOL_CLEANUP_STATES = ["protected", "retained", "restore_verified"] as const;

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireCanonicalUint64(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("lifecycleRevision must be a canonical unsigned decimal integer");
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error("lifecycleRevision must fit uint64");
  return parsed;
}

export interface ListVerifiedPrimaryAgentBackupObjectsInput {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  execution: AgentBackupOperationExecution;
}

/**
 * Return the exact verified primary rows in canonical manifest order while
 * holding the operation row lock for the complete inventory check.
 */
export async function listVerifiedPrimaryAgentBackupObjectsForReplication(
  input: Readonly<ListVerifiedPrimaryAgentBackupObjectsInput>,
): Promise<AgentBackupObject[]> {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.backupId, "backupId");
  requireUuid(input.operationId, "operationId");
  requireUuid(input.activationGeneration, "activationGeneration");
  requireBoundedIdentity(input.execution.ownerId, "execution.ownerId");
  requireUuid(input.execution.generation, "execution.generation");
  const lifecycleRevision = requireCanonicalUint64(input.lifecycleRevision);

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select({
        manifestObjectCount: agentSandboxBackups.manifest_object_count,
        inventoryDigest: agentSandboxBackups.object_inventory_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.backup_operation_id, input.operationId),
          eq(agentSandboxBackups.lifecycle_generation, input.activationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, lifecycleRevision),
          eq(agentSandboxBackups.catalog_state, "secondary_pending"),
          eq(agentSandboxBackups.catalog_lease_owner, input.execution.ownerId),
          eq(agentSandboxBackups.catalog_lease_generation, input.execution.generation),
          gt(agentSandboxBackups.catalog_lease_expires_at, sql`NOW()`),
          sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
        ),
      )
      .for("update")
      .limit(1);
    if (!backup?.manifestObjectCount || !backup.inventoryDigest) {
      throw new AgentBackupCatalogConflictError(
        "Secondary replication authority is absent, expired, or incomplete",
      );
    }

    const objects = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.organization_id, input.organizationId),
          eq(agentBackupObjects.backup_id, input.backupId),
          eq(agentBackupObjects.copy_role, "primary"),
          eq(agentBackupObjects.state, "verified"),
        ),
      )
      .orderBy(agentBackupObjects.component, agentBackupObjects.chunk_index);
    const digest = await agentBackupObjectInventoryDigest(
      objects.map((object) => ({
        component: object.component,
        chunkIndex: object.chunk_index,
        contentHmacSha256: object.content_hmac_sha256,
        ciphertextSha256: object.ciphertext_sha256,
        sizeBytes: object.size_bytes,
      })),
    );
    if (objects.length !== backup.manifestObjectCount || digest !== backup.inventoryDigest) {
      throw new AgentBackupCatalogConflictError(
        "Verified primary inventory does not match the authenticated manifest",
      );
    }
    return objects;
  });
}

export interface AuthorizeAgentBackupProtectedSpoolCleanupInput {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  manifestDigest: string;
  objectInventoryDigest: string;
}

export interface AuthorizeAgentBackupTerminalSpoolCleanupInput {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  terminalErrorCode: string;
}

function requireSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be canonical SHA-256 hex`);
  return value;
}

/**
 * Locate possible catalogue rows for one filesystem operation identifier.
 * Callers must still derive the row's request/authority hashes and invoke the
 * locked authorization check below before creating a cleanup intent.
 */
export async function listAgentBackupProtectedSpoolCleanupCandidates(params: {
  operationId: string;
  limit?: number;
}): Promise<StoredAgentSandboxBackup[]> {
  requireUuid(params.operationId, "operationId");
  const limit = params.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Protected spool cleanup candidate limit must be between 1 and 100");
  }
  return dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.catalog_version, 2),
        eq(agentSandboxBackups.manifest_version, 3),
        eq(agentSandboxBackups.backup_operation_id, params.operationId),
        inArray(agentSandboxBackups.catalog_state, PROTECTED_SPOOL_CLEANUP_STATES),
        sql`${agentSandboxBackups.secondary_verified_at} IS NOT NULL`,
      ),
    )
    .orderBy(agentSandboxBackups.created_at, agentSandboxBackups.id)
    .limit(limit);
}

/**
 * Re-prove the exact protected catalogue row and a matching verified upload
 * receipt from both providers for every manifest object. Merely observing a
 * local spool, a transition response, or secondary_pending is insufficient.
 */
export async function authorizeAgentBackupProtectedSpoolCleanup(
  input: Readonly<AuthorizeAgentBackupProtectedSpoolCleanupInput>,
): Promise<StoredAgentSandboxBackup> {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.backupId, "backupId");
  requireUuid(input.operationId, "operationId");
  requireUuid(input.activationGeneration, "activationGeneration");
  const lifecycleRevision = requireCanonicalUint64(input.lifecycleRevision);
  requireSha256(input.manifestDigest, "manifestDigest");
  requireSha256(input.objectInventoryDigest, "objectInventoryDigest");

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_version, 2),
          eq(agentSandboxBackups.manifest_version, 3),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.backup_operation_id, input.operationId),
          eq(agentSandboxBackups.lifecycle_generation, input.activationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, lifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, input.manifestDigest),
          eq(agentSandboxBackups.object_inventory_digest, input.objectInventoryDigest),
          inArray(agentSandboxBackups.catalog_state, PROTECTED_SPOOL_CLEANUP_STATES),
          sql`${agentSandboxBackups.secondary_verified_at} IS NOT NULL`,
        ),
      )
      .for("update")
      .limit(1);
    if (!backup?.manifest_object_count || !backup.object_inventory_digest) {
      throw new AgentBackupCatalogConflictError(
        "Protected spool cleanup authority is absent or incomplete",
      );
    }

    const objects = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.organization_id, input.organizationId),
          eq(agentBackupObjects.backup_id, input.backupId),
        ),
      )
      .orderBy(
        agentBackupObjects.copy_role,
        agentBackupObjects.component,
        agentBackupObjects.chunk_index,
      )
      .for("share");
    const primaries = objects.filter((object) => object.copy_role === "primary");
    const secondaries = new Map(
      objects
        .filter((object) => object.copy_role === "secondary")
        .map((object) => [`${object.component}:${object.chunk_index}`, object]),
    );
    if (
      primaries.length !== backup.manifest_object_count ||
      secondaries.size !== backup.manifest_object_count ||
      objects.length !== backup.manifest_object_count * 2
    ) {
      throw new AgentBackupCatalogConflictError(
        "Protected spool cleanup requires exact dual-provider object coverage",
      );
    }
    for (const primary of primaries) {
      const secondary = secondaries.get(`${primary.component}:${primary.chunk_index}`);
      if (
        primary.provider !== "cloudflare-r2" ||
        primary.state !== "verified" ||
        !primary.verified_at ||
        !primary.upload_receipt_digest ||
        !/^[0-9a-f]{64}$/.test(primary.upload_receipt_digest) ||
        !secondary ||
        secondary.provider !== "hetzner-object-storage" ||
        secondary.state !== "verified" ||
        !secondary.verified_at ||
        !secondary.upload_receipt_digest ||
        !/^[0-9a-f]{64}$/.test(secondary.upload_receipt_digest) ||
        secondary.content_hmac_sha256 !== primary.content_hmac_sha256 ||
        secondary.ciphertext_sha256 !== primary.ciphertext_sha256 ||
        secondary.size_bytes !== primary.size_bytes
      ) {
        throw new AgentBackupCatalogConflictError(
          "Protected spool cleanup requires matching verified provider receipts",
        );
      }
    }
    const digest = await agentBackupObjectInventoryDigest(
      primaries.map((object) => ({
        component: object.component,
        chunkIndex: object.chunk_index,
        contentHmacSha256: object.content_hmac_sha256,
        ciphertextSha256: object.ciphertext_sha256,
        sizeBytes: object.size_bytes,
      })),
    );
    if (digest !== backup.object_inventory_digest) {
      throw new AgentBackupCatalogConflictError(
        "Protected spool cleanup object inventory differs from the manifest",
      );
    }
    return backup;
  });
}

/**
 * Re-prove an exact pre-publication terminal settlement. Local candidate files
 * are discovery evidence only and cannot authorize deletion without this row.
 */
export async function authorizeAgentBackupTerminalSpoolCleanup(
  input: Readonly<AuthorizeAgentBackupTerminalSpoolCleanupInput>,
): Promise<StoredAgentSandboxBackup> {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.backupId, "backupId");
  requireUuid(input.operationId, "operationId");
  requireUuid(input.activationGeneration, "activationGeneration");
  const lifecycleRevision = requireCanonicalUint64(input.lifecycleRevision);
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(input.terminalErrorCode)) {
    throw new Error("terminalErrorCode must be a bounded canonical error code");
  }

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_version, 2),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.backup_operation_id, input.operationId),
          eq(agentSandboxBackups.lifecycle_generation, input.activationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, lifecycleRevision),
          eq(agentSandboxBackups.catalog_state, "failed_terminal"),
          eq(agentSandboxBackups.catalog_resume_state, "capturing"),
          eq(agentSandboxBackups.catalog_last_error_code, input.terminalErrorCode),
          sql`${agentSandboxBackups.manifest_digest} IS NULL`,
          sql`${agentSandboxBackups.manifest_canonical_draft} IS NULL`,
          sql`${agentSandboxBackups.object_inventory_digest} IS NULL`,
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) {
      throw new AgentBackupCatalogConflictError(
        "Terminal spool cleanup authority is absent, superseded, or incomplete",
      );
    }
    return backup;
  });
}
