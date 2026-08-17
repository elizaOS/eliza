/** Durable, tenant-scoped operations for the v2 sandbox-backup catalogue. */

import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import {
  assertAgentBackupCatalogTransition,
  boundedBackupCatalogError,
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  type AgentBackupCopyRole,
  type AgentBackupObject,
  type AgentBackupObjectProvider,
  type AgentBackupObjectTransport,
  agentBackupCatalogAuthorities,
  agentBackupObjects,
} from "../schemas/agent-backup-catalog";
import {
  type AgentBackupCatalogState,
  agentSandboxBackups,
  type StoredAgentSandboxBackup,
} from "../schemas/agent-sandboxes";

const MAX_CATALOG_OBJECT_BYTES = 1024 * 1024 * 1024;

const EXECUTION_OWNED_STATES = [
  "scheduled",
  "capturing",
  "captured",
  "uploading",
  "primary_uploaded",
  "primary_verified",
  "secondary_pending",
  "failed_retryable",
] as const satisfies readonly AgentBackupCatalogState[];

export interface AgentBackupOperationExecution {
  ownerId: string;
  generation: string;
}

export class AgentBackupCatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBackupCatalogConflictError";
  }
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value)) throw new Error(`${field} must be a canonical UUID`);
  return value.toLowerCase();
}

function requireSafeBytes(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} must be a safe integer between 0 and ${max}`);
  }
  return value;
}

/** Lock the existing per-agent catalogue authority before any revision CAS. */
export async function lockAgentBackupCatalogAuthority(
  tx: DbTransaction,
  organizationId: string,
  agentId: string,
): Promise<typeof agentBackupCatalogAuthorities.$inferSelect> {
  const [authority] = await tx
    .select()
    .from(agentBackupCatalogAuthorities)
    .where(
      and(
        eq(agentBackupCatalogAuthorities.organization_id, organizationId),
        eq(agentBackupCatalogAuthorities.agent_id, agentId),
      ),
    )
    .for("update")
    .limit(1);
  if (!authority) {
    throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
  }
  return authority;
}

export async function advanceAgentBackupCatalogRevision(
  tx: DbTransaction,
  params: { organizationId: string; agentId: string; expectedRevision: bigint },
): Promise<bigint> {
  const [updated] = await tx
    .update(agentBackupCatalogAuthorities)
    .set({
      catalog_revision: sql`${agentBackupCatalogAuthorities.catalog_revision} + 1`,
      updated_at: sql`NOW()`,
    })
    .where(
      and(
        eq(agentBackupCatalogAuthorities.organization_id, params.organizationId),
        eq(agentBackupCatalogAuthorities.agent_id, params.agentId),
        eq(agentBackupCatalogAuthorities.catalog_revision, params.expectedRevision),
      ),
    )
    .returning({ catalogRevision: agentBackupCatalogAuthorities.catalog_revision });
  if (!updated) {
    throw new AgentBackupCatalogConflictError("Backup catalogue revision CAS lost");
  }
  return updated.catalogRevision;
}

export async function stampAgentBackupCatalogRevision(
  tx: DbTransaction,
  params: {
    backupId: string;
    organizationId: string;
    agentId: string;
    expectedRevision: bigint;
  },
): Promise<bigint> {
  const catalogRevision = await advanceAgentBackupCatalogRevision(tx, params);
  const [stamped] = await tx
    .update(agentSandboxBackups)
    .set({ catalog_revision: catalogRevision, catalog_updated_at: sql`NOW()` })
    .where(
      and(
        eq(agentSandboxBackups.id, params.backupId),
        eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        eq(agentSandboxBackups.catalog_agent_id, params.agentId),
      ),
    )
    .returning({ id: agentSandboxBackups.id });
  if (!stamped) {
    throw new AgentBackupCatalogConflictError("Backup catalogue revision stamp was lost");
  }
  return catalogRevision;
}

function requireOperationExecution(execution: AgentBackupOperationExecution): void {
  requireBoundedIdentity(execution.ownerId, "execution.ownerId");
  requireUuid(execution.generation, "execution.generation");
}

async function assertOwnedOperationExecution(
  tx: DbTransaction,
  row: StoredAgentSandboxBackup,
  execution: AgentBackupOperationExecution,
): Promise<void> {
  requireOperationExecution(execution);
  const [owned] = await tx
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.id, row.id),
        eq(agentSandboxBackups.catalog_lease_owner, execution.ownerId),
        eq(agentSandboxBackups.catalog_lease_generation, execution.generation),
        gt(agentSandboxBackups.catalog_lease_expires_at, sql`NOW()`),
        sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (!owned) {
    throw new AgentBackupCatalogConflictError(
      "Backup operation execution lease is absent, expired, or detached from its sandbox",
    );
  }
}

async function sha256Hex(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  stableBytes.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AgentBackupObjectInventoryEntry {
  component: string;
  chunkIndex: number;
  contentHmacSha256: string;
  ciphertextSha256: string;
  sizeBytes: number;
}

/** Canonical digest shared by the authenticated manifest and catalogue gate. */
export async function agentBackupObjectInventoryDigest(
  objects: readonly AgentBackupObjectInventoryEntry[],
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      version: 2,
      objects: objects
        .map((object) => ({
          component: object.component,
          index: object.chunkIndex,
          contentHmac: object.contentHmacSha256,
          cipherSha: object.ciphertextSha256,
          encryptedBytes: object.sizeBytes,
        }))
        .sort((left, right) => {
          if (left.component < right.component) return -1;
          if (left.component > right.component) return 1;
          return left.index - right.index;
        }),
    }),
  );
}

async function assertTransitionEvidence(
  tx: DbTransaction,
  backupId: string,
  to: AgentBackupCatalogState,
): Promise<void> {
  if (to === "uploading") {
    const [row] = await tx
      .select({ digest: agentSandboxBackups.manifest_digest })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId))
      .limit(1);
    if (!row?.digest) throw new AgentBackupCatalogConflictError("Upload requires a manifest");
    return;
  }
  if (to === "primary_uploaded" || to === "primary_verified") {
    const [backup] = await tx
      .select({
        expectedCount: agentSandboxBackups.manifest_object_count,
        expectedDigest: agentSandboxBackups.object_inventory_digest,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId))
      .limit(1);
    if (!backup?.expectedCount || !backup.expectedDigest) {
      throw new AgentBackupCatalogConflictError("Primary upload is missing manifest inventory");
    }
    const primaryObjects = await tx
      .select({
        component: agentBackupObjects.component,
        chunkIndex: agentBackupObjects.chunk_index,
        contentHmacSha256: agentBackupObjects.content_hmac_sha256,
        ciphertextSha256: agentBackupObjects.ciphertext_sha256,
        sizeBytes: agentBackupObjects.size_bytes,
      })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.backup_id, backupId),
          eq(agentBackupObjects.copy_role, "primary"),
        ),
      );
    const inventoryDigest = await agentBackupObjectInventoryDigest(primaryObjects);
    if (
      primaryObjects.length !== backup.expectedCount ||
      inventoryDigest !== backup.expectedDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Primary object inventory does not match the authenticated manifest",
      );
    }
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        incomplete: sql<number>`count(*) FILTER (
          WHERE ${agentBackupObjects.state} NOT IN ('present', 'verified')
        )::int`,
        unverified: sql<number>`count(*) FILTER (
          WHERE ${agentBackupObjects.state} <> 'verified'
        )::int`,
      })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.backup_id, backupId),
          eq(agentBackupObjects.copy_role, "primary"),
        ),
      );
    if (!counts || counts.total < 1) {
      throw new AgentBackupCatalogConflictError("Primary upload has no catalogued objects");
    }
    if (to === "primary_uploaded" && counts.incomplete !== 0) {
      throw new AgentBackupCatalogConflictError("Primary upload still has incomplete objects");
    }
    if (to === "primary_verified" && counts.unverified !== 0) {
      throw new AgentBackupCatalogConflictError("Primary objects are not all verified");
    }
    return;
  }
  if (to === "protected") {
    const [coverage] = await sqlRows<{
      expectedCount: number | null;
      primaryCount: number;
      secondaryCount: number;
      missingSecondary: number;
      invalidSecondary: number;
    }>(
      tx,
      sql`
        SELECT
          backup.manifest_object_count AS "expectedCount",
          count(*)::int AS "primaryCount",
          count(*) FILTER (WHERE secondary_object.id IS NULL)::int AS "missingSecondary",
          (
            SELECT count(*)::int
            FROM ${agentBackupObjects} AS all_secondary
            WHERE all_secondary.backup_id = backup.id
              AND all_secondary.copy_role = 'secondary'
          ) AS "secondaryCount",
          (
            SELECT count(*)::int
            FROM ${agentBackupObjects} AS candidate_secondary
            WHERE candidate_secondary.backup_id = backup.id
              AND candidate_secondary.copy_role = 'secondary'
              AND (
                candidate_secondary.state <> 'verified'
                OR NOT EXISTS (
                  SELECT 1
                  FROM ${agentBackupObjects} AS exact_primary
                  WHERE exact_primary.backup_id = candidate_secondary.backup_id
                    AND exact_primary.organization_id = candidate_secondary.organization_id
                    AND exact_primary.component = candidate_secondary.component
                    AND exact_primary.chunk_index = candidate_secondary.chunk_index
                    AND exact_primary.copy_role = 'primary'
                    AND exact_primary.state = 'verified'
                    AND exact_primary.content_hmac_sha256 = candidate_secondary.content_hmac_sha256
                    AND exact_primary.ciphertext_sha256 = candidate_secondary.ciphertext_sha256
                    AND exact_primary.size_bytes = candidate_secondary.size_bytes
                )
              )
          ) AS "invalidSecondary"
        FROM ${agentSandboxBackups} AS backup
        JOIN ${agentBackupObjects} AS primary_object
          ON primary_object.backup_id = backup.id
        LEFT JOIN ${agentBackupObjects} AS secondary_object
          ON secondary_object.backup_id = primary_object.backup_id
          AND secondary_object.organization_id = primary_object.organization_id
          AND secondary_object.component = primary_object.component
          AND secondary_object.chunk_index = primary_object.chunk_index
          AND secondary_object.copy_role = 'secondary'
          AND secondary_object.state = 'verified'
          AND secondary_object.content_hmac_sha256 = primary_object.content_hmac_sha256
          AND secondary_object.ciphertext_sha256 = primary_object.ciphertext_sha256
          AND secondary_object.size_bytes = primary_object.size_bytes
        WHERE backup.id = ${backupId}
          AND primary_object.copy_role = 'primary'
          AND primary_object.state = 'verified'
        GROUP BY backup.id, backup.manifest_object_count
      `,
    );
    if (
      !coverage ||
      coverage.expectedCount == null ||
      coverage.primaryCount !== coverage.expectedCount ||
      coverage.secondaryCount !== coverage.expectedCount ||
      coverage.missingSecondary !== 0 ||
      coverage.invalidSecondary !== 0
    ) {
      throw new AgentBackupCatalogConflictError(
        "Backup cannot be protected until every primary object has a verified secondary copy",
      );
    }
  }
}

export async function transitionAgentBackupOperation(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  lifecycleGeneration: string;
  expectedState: AgentBackupCatalogState;
  to: AgentBackupCatalogState;
  resumeState?: AgentBackupCatalogState | null;
  execution?: AgentBackupOperationExecution;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.lifecycleGeneration, "lifecycleGeneration");
  if (params.to === "restore_verified") {
    throw new Error("Restore verification is committed only by restore coordinator authority");
  }
  if (params.to === "deleting" || params.to === "deleted") {
    throw new Error("Deletion states are owned by the durable GC outbox");
  }
  if (params.to === "failed_retryable" || params.to === "failed_terminal") {
    throw new Error("Failure states require failAgentBackupOperation with bounded error evidence");
  }

  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.lifecycleGeneration),
        ),
      )
      .for("update")
      .limit(1);
    if (!row?.catalog_state) throw new AgentBackupCatalogConflictError("Backup operation missing");
    const executionOwned = EXECUTION_OWNED_STATES.includes(
      row.catalog_state as (typeof EXECUTION_OWNED_STATES)[number],
    );
    if (executionOwned) {
      if (!params.execution) {
        throw new AgentBackupCatalogConflictError(
          "Backup pipeline transition requires an owned execution lease",
        );
      }
      await assertOwnedOperationExecution(tx, row, params.execution);
    } else if (params.execution) {
      requireOperationExecution(params.execution);
    }
    if (row.catalog_state === params.to) {
      const isCompletedRetryResume =
        params.expectedState === "failed_retryable" &&
        params.resumeState === params.to &&
        row.catalog_resume_state === null;
      if (
        !isCompletedRetryResume &&
        (row.catalog_resume_state ?? null) !== (params.resumeState ?? null)
      ) {
        throw new AgentBackupCatalogConflictError(
          "Backup transition replay has a different retry state",
        );
      }
      return row;
    }
    if (row.catalog_state !== params.expectedState) {
      throw new AgentBackupCatalogConflictError(
        `Backup transition expected ${params.expectedState}, found ${row.catalog_state}`,
      );
    }
    if (
      row.catalog_state === "failed_retryable" &&
      (row.catalog_resume_state === null ||
        params.resumeState !== row.catalog_resume_state ||
        params.to !== row.catalog_resume_state)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Retry must resume the exact state recorded by the failed operation",
      );
    }
    if (params.to === "expiration_pending") {
      const [retentionEligible] = await tx
        .select({ id: agentSandboxBackups.id })
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.id, row.id),
            lte(agentSandboxBackups.retention_until, sql`NOW()`),
            sql`${agentSandboxBackups.retention_reason} <> 'legal-hold'`,
          ),
        )
        .limit(1);
      if (!retentionEligible) {
        throw new AgentBackupCatalogConflictError(
          row.retention_reason === "legal-hold"
            ? "A legal-hold backup requires an explicit hold-release authority before deletion"
            : "Backup retention has not expired according to the primary database clock",
        );
      }
      const [dependent] = await tx
        .select({ id: agentSandboxBackups.id })
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.catalog_version, 2),
            eq(agentSandboxBackups.catalog_organization_id, row.catalog_organization_id as string),
            eq(agentSandboxBackups.catalog_agent_id, row.catalog_agent_id as string),
            or(
              eq(agentSandboxBackups.parent_backup_id, row.id),
              eq(agentSandboxBackups.base_backup_id, row.id),
            ),
            sql`${agentSandboxBackups.catalog_state} IS DISTINCT FROM 'deleted'`,
            sql`NOT (
              ${agentSandboxBackups.catalog_state} = 'failed_terminal'
              AND NOT EXISTS (
                SELECT 1 FROM agent_backup_objects AS terminal_object
                WHERE terminal_object.backup_id = ${agentSandboxBackups.id}
              )
            )`,
          ),
        )
        .limit(1);
      if (dependent) {
        throw new AgentBackupCatalogConflictError(
          "Backup cannot expire before every dependent incremental is deleted",
        );
      }
    }
    assertAgentBackupCatalogTransition({
      from: row.catalog_state,
      to: params.to,
      resumeState: params.resumeState,
    });
    await assertTransitionEvidence(tx, row.id, params.to);
    if (!row.catalog_organization_id || !row.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      row.catalog_organization_id,
      row.catalog_agent_id,
    );
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: row.catalog_organization_id,
      agentId: row.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    const releasePipelineLease = params.to === "protected";
    const [updated] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: params.to,
        catalog_revision: catalogRevision,
        catalog_resume_state:
          params.to === "failed_retryable" || params.to === "failed_terminal"
            ? params.resumeState
            : null,
        catalog_last_error_code:
          params.to === "failed_retryable" || params.to === "failed_terminal"
            ? row.catalog_last_error_code
            : null,
        catalog_last_error:
          params.to === "failed_retryable" || params.to === "failed_terminal"
            ? row.catalog_last_error
            : null,
        catalog_next_attempt_at: null,
        catalog_lease_owner: releasePipelineLease ? null : row.catalog_lease_owner,
        catalog_lease_generation: releasePipelineLease ? null : row.catalog_lease_generation,
        catalog_lease_expires_at: releasePipelineLease ? null : row.catalog_lease_expires_at,
        catalog_updated_at: sql`NOW()`,
        primary_verified_at:
          params.to === "primary_verified"
            ? sql`COALESCE(${agentSandboxBackups.primary_verified_at}, NOW())`
            : row.primary_verified_at,
        secondary_verified_at:
          params.to === "protected"
            ? sql`COALESCE(${agentSandboxBackups.secondary_verified_at}, NOW())`
            : row.secondary_verified_at,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, row.id),
          eq(agentSandboxBackups.catalog_state, row.catalog_state),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup transition lost its CAS");
    return updated;
  });
}

export async function failAgentBackupOperation(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  lifecycleGeneration: string;
  expectedState: Exclude<
    AgentBackupCatalogState,
    "legacy_unmigrated" | "failed_retryable" | "failed_terminal" | "deleting" | "deleted"
  >;
  terminal: boolean;
  error: { code: string; message: string };
  retryDelayMs?: number;
  execution: AgentBackupOperationExecution;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.lifecycleGeneration, "lifecycleGeneration");
  const error = boundedBackupCatalogError(params.error);
  const target = params.terminal ? "failed_terminal" : "failed_retryable";
  const retryDelayMs = params.retryDelayMs ?? 0;
  if (
    (!params.terminal &&
      (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 86_400_000)) ||
    (params.terminal && retryDelayMs !== 0)
  ) {
    throw new Error(
      params.terminal
        ? "A terminal backup failure cannot schedule a retry"
        : "retryDelayMs must be between 1 and 86400000",
    );
  }

  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.lifecycleGeneration),
        ),
      )
      .for("update")
      .limit(1);
    if (!row?.catalog_state) throw new AgentBackupCatalogConflictError("Backup operation missing");
    if (row.catalog_state === target) {
      if (
        row.catalog_resume_state !== params.expectedState ||
        row.catalog_last_error_code !== error.code ||
        row.catalog_last_error !== error.message
      ) {
        throw new AgentBackupCatalogConflictError("Backup failure replay does not match");
      }
      return row;
    }
    await assertOwnedOperationExecution(tx, row, params.execution);
    if (row.catalog_state !== params.expectedState) {
      throw new AgentBackupCatalogConflictError(
        `Backup failure expected ${params.expectedState}, found ${row.catalog_state}`,
      );
    }
    assertAgentBackupCatalogTransition({
      from: row.catalog_state,
      to: target,
      resumeState: row.catalog_state,
    });
    if (!row.catalog_organization_id || !row.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      row.catalog_organization_id,
      row.catalog_agent_id,
    );
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: row.catalog_organization_id,
      agentId: row.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    const [updated] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: target,
        catalog_revision: catalogRevision,
        catalog_resume_state: row.catalog_state,
        catalog_attempts: sql`${agentSandboxBackups.catalog_attempts} + 1`,
        catalog_next_attempt_at: params.terminal
          ? null
          : sql`NOW() + (${retryDelayMs} * INTERVAL '1 millisecond')`,
        catalog_last_error_code: error.code,
        catalog_last_error: error.message,
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
        catalog_updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, row.id),
          eq(agentSandboxBackups.catalog_state, row.catalog_state),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup failure CAS lost");
    return updated;
  });
}

export interface ReserveAgentBackupObjectInput {
  organizationId: string;
  backupId: string;
  copyRole: AgentBackupCopyRole;
  component: string;
  chunkIndex: number;
  transport: AgentBackupObjectTransport;
  provider: AgentBackupObjectProvider;
  endpointAlias: string;
  endpointIdentityFingerprint: string;
  bucket: string;
  region: string;
  contentHmacSha256: string;
  ciphertextSha256: string;
  sizeBytes: number;
  execution: AgentBackupOperationExecution;
}

const AGENT_BACKUP_COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The repository, never a caller, owns the tenant-scoped immutable key namespace. */
export function buildAgentBackupObjectKey(input: {
  organizationId: string;
  backupId: string;
  copyRole: AgentBackupCopyRole;
  component: string;
  chunkIndex: number;
}): string {
  const organizationId = requireUuid(input.organizationId, "organizationId");
  const backupId = requireUuid(input.backupId, "backupId");
  if (input.copyRole !== "primary" && input.copyRole !== "secondary") {
    throw new Error("copyRole must be primary or secondary");
  }
  if (!AGENT_BACKUP_COMPONENT_PATTERN.test(input.component)) {
    throw new Error("component must be a canonical backup component name");
  }
  requireSafeBytes(input.chunkIndex, "chunkIndex", 8_191);
  return [
    "agent-sandbox-backups",
    "v2",
    organizationId,
    backupId,
    input.copyRole,
    input.component,
    `${input.chunkIndex.toString().padStart(8, "0")}.bin`,
  ].join("/");
}

function assertObjectReplay(
  row: AgentBackupObject,
  input: ReserveAgentBackupObjectInput,
  objectKey: string,
): void {
  const matches =
    row.organization_id === input.organizationId.toLowerCase() &&
    row.backup_id === input.backupId.toLowerCase() &&
    row.copy_role === input.copyRole &&
    row.component === input.component &&
    row.chunk_index === input.chunkIndex &&
    row.transport === input.transport &&
    row.provider === input.provider &&
    row.endpoint_alias === input.endpointAlias &&
    row.endpoint_identity_fingerprint === input.endpointIdentityFingerprint &&
    row.bucket === input.bucket &&
    row.region === input.region &&
    row.object_key === objectKey &&
    row.content_hmac_sha256 === input.contentHmacSha256 &&
    row.ciphertext_sha256 === input.ciphertextSha256 &&
    row.size_bytes === input.sizeBytes;
  if (!matches) {
    throw new AgentBackupCatalogConflictError(
      "Backup object slot was already reserved with different immutable bytes or locator",
    );
  }
}

export async function reserveAgentBackupObject(
  input: ReserveAgentBackupObjectInput,
): Promise<AgentBackupObject> {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.backupId, "backupId");
  requireBoundedIdentity(input.component, "component");
  requireBoundedIdentity(input.endpointAlias, "endpointAlias");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.endpointIdentityFingerprint)) {
    throw new Error("endpointIdentityFingerprint must be a canonical SHA-256 fingerprint");
  }
  requireBoundedIdentity(input.bucket, "bucket");
  requireBoundedIdentity(input.region, "region");
  requireSha256Hex(input.contentHmacSha256, "contentHmacSha256");
  requireSha256Hex(input.ciphertextSha256, "ciphertextSha256");
  requireSafeBytes(input.chunkIndex, "chunkIndex", 8_191);
  requireSafeBytes(input.sizeBytes, "sizeBytes", MAX_CATALOG_OBJECT_BYTES);
  if (input.copyRole === "primary" && input.provider !== "cloudflare-r2") {
    throw new Error("Primary backup objects must use Cloudflare R2");
  }
  if (input.copyRole === "secondary" && input.provider !== "hetzner-object-storage") {
    throw new Error("Secondary backup objects must use Hetzner Object Storage");
  }
  const objectKey = buildAgentBackupObjectKey(input);
  const keyFingerprint = await sha256Hex(objectKey);

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup || !backup.catalog_state) {
      throw new AgentBackupCatalogConflictError("Backup catalogue operation missing");
    }
    await assertOwnedOperationExecution(tx, backup, input.execution);
    const roleStateAllowed =
      input.copyRole === "primary"
        ? backup.catalog_state === "captured" || backup.catalog_state === "uploading"
        : backup.catalog_state === "secondary_pending";
    if (!roleStateAllowed) {
      throw new AgentBackupCatalogConflictError(
        `${input.copyRole} backup object cannot be reserved while operation is ${backup.catalog_state}`,
      );
    }
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    if (input.copyRole === "secondary") {
      const [primary] = await tx
        .select({
          state: agentBackupObjects.state,
          contentHmacSha256: agentBackupObjects.content_hmac_sha256,
          ciphertextSha256: agentBackupObjects.ciphertext_sha256,
          sizeBytes: agentBackupObjects.size_bytes,
        })
        .from(agentBackupObjects)
        .where(
          and(
            eq(agentBackupObjects.backup_id, input.backupId),
            eq(agentBackupObjects.organization_id, input.organizationId),
            eq(agentBackupObjects.copy_role, "primary"),
            eq(agentBackupObjects.component, input.component),
            eq(agentBackupObjects.chunk_index, input.chunkIndex),
          ),
        )
        .for("key share")
        .limit(1);
      if (
        primary?.state !== "verified" ||
        primary.contentHmacSha256 !== input.contentHmacSha256 ||
        primary.ciphertextSha256 !== input.ciphertextSha256 ||
        primary.sizeBytes !== input.sizeBytes
      ) {
        throw new AgentBackupCatalogConflictError(
          "Secondary object must exactly replicate a verified primary manifest chunk",
        );
      }
    }

    const [inserted] = await tx
      .insert(agentBackupObjects)
      .values({
        organization_id: input.organizationId.toLowerCase(),
        backup_id: input.backupId.toLowerCase(),
        copy_role: input.copyRole,
        component: input.component,
        chunk_index: input.chunkIndex,
        state: "reserved",
        transport: input.transport,
        provider: input.provider,
        endpoint_alias: input.endpointAlias,
        endpoint_identity_fingerprint: input.endpointIdentityFingerprint,
        bucket: input.bucket,
        region: input.region,
        object_key: objectKey,
        key_fingerprint: keyFingerprint,
        content_hmac_sha256: input.contentHmacSha256,
        ciphertext_sha256: input.ciphertextSha256,
        size_bytes: input.sizeBytes,
      })
      .onConflictDoNothing()
      .returning({ id: agentBackupObjects.id });
    const [row] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.backup_id, input.backupId),
          eq(agentBackupObjects.component, input.component),
          eq(agentBackupObjects.chunk_index, input.chunkIndex),
          eq(agentBackupObjects.copy_role, input.copyRole),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new Error("Backup object reservation disappeared");
    assertObjectReplay(row, input, objectKey);
    if (inserted) {
      await stampAgentBackupCatalogRevision(tx, {
        backupId: backup.id,
        organizationId: backup.catalog_organization_id,
        agentId: backup.catalog_agent_id,
        expectedRevision: authority.catalog_revision,
      });
    }
    return row;
  });
}

/** Persist the provider-write intent before any external PUT can start. */
export async function markAgentBackupObjectUploading(params: {
  organizationId: string;
  objectId: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupObject> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.objectId, "objectId");
  return dbWrite.transaction(async (tx) => {
    const [objectRef] = await tx
      .select({ backupId: agentBackupObjects.backup_id })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
        ),
      )
      .limit(1);
    if (!objectRef) throw new AgentBackupCatalogConflictError("Backup object missing");
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, objectRef.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, backup, params.execution);
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const [row] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.backup_id, objectRef.backupId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new AgentBackupCatalogConflictError("Backup object disappeared");
    if (
      (row.state === "uploading" || row.state === "present" || row.state === "verified") &&
      row.provider_write_started
    ) {
      return row;
    }
    if (row.state !== "reserved" || row.provider_write_started) {
      throw new AgentBackupCatalogConflictError(
        `Cannot start provider upload while object is ${row.state}`,
      );
    }
    const [updated] = await tx
      .update(agentBackupObjects)
      .set({
        state: "uploading",
        provider_write_started: true,
        updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentBackupObjects.id, row.id),
          eq(agentBackupObjects.state, "reserved"),
          eq(agentBackupObjects.provider_write_started, false),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup object upload-start CAS lost");
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}

export async function recordAgentBackupObjectPresent(params: {
  organizationId: string;
  objectId: string;
  providerVersionId?: string | null;
  providerEtag?: string | null;
  providerChecksum?: string | null;
  uploadReceiptDigest: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupObject> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.objectId, "objectId");
  requireSha256Hex(params.uploadReceiptDigest, "uploadReceiptDigest");
  if (params.providerVersionId)
    requireBoundedIdentity(params.providerVersionId, "providerVersionId");
  if (params.providerEtag) requireBoundedIdentity(params.providerEtag, "providerEtag");
  if (params.providerChecksum) requireBoundedIdentity(params.providerChecksum, "providerChecksum");
  if (!params.providerVersionId && !params.providerEtag && !params.providerChecksum) {
    throw new Error("A durable provider version, ETag, or checksum authority is required");
  }

  return dbWrite.transaction(async (tx) => {
    const [objectRef] = await tx
      .select({ backupId: agentBackupObjects.backup_id })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
        ),
      )
      .limit(1);
    if (!objectRef) throw new AgentBackupCatalogConflictError("Backup object missing");
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, objectRef.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, backup, params.execution);
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const [row] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.backup_id, objectRef.backupId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new AgentBackupCatalogConflictError("Backup object disappeared");
    const versionId = params.providerVersionId ?? null;
    const etag = params.providerEtag ?? null;
    const checksum = params.providerChecksum ?? null;
    if (row.state === "present" || row.state === "verified") {
      if (
        !row.provider_write_started ||
        row.provider_version_id !== versionId ||
        row.provider_etag !== etag ||
        row.provider_checksum !== checksum ||
        row.upload_receipt_digest !== params.uploadReceiptDigest
      ) {
        throw new AgentBackupCatalogConflictError(
          "Backup object upload receipt replay does not match the immutable provider object",
        );
      }
      return row;
    }
    if (row.state !== "uploading" || !row.provider_write_started) {
      throw new AgentBackupCatalogConflictError(
        `Cannot record upload while object is ${row.state}`,
      );
    }
    const [updated] = await tx
      .update(agentBackupObjects)
      .set({
        state: "present",
        provider_version_id: versionId,
        provider_etag: etag,
        provider_checksum: checksum,
        upload_receipt_digest: params.uploadReceiptDigest,
        updated_at: sql`NOW()`,
      })
      .where(and(eq(agentBackupObjects.id, row.id), eq(agentBackupObjects.state, row.state)))
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup object upload CAS lost");
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}

export async function markAgentBackupObjectVerified(params: {
  organizationId: string;
  objectId: string;
  uploadReceiptDigest: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupObject> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.objectId, "objectId");
  requireSha256Hex(params.uploadReceiptDigest, "uploadReceiptDigest");
  return dbWrite.transaction(async (tx) => {
    const [objectRef] = await tx
      .select({ backupId: agentBackupObjects.backup_id })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
        ),
      )
      .limit(1);
    if (!objectRef) throw new AgentBackupCatalogConflictError("Backup object missing");
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, objectRef.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, backup, params.execution);
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const [object] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.backup_id, backup.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!object || object.upload_receipt_digest !== params.uploadReceiptDigest) {
      throw new AgentBackupCatalogConflictError(
        "Backup object verification is missing its exact upload receipt",
      );
    }
    if (object.state === "verified") return object;
    if (object.state !== "present") {
      throw new AgentBackupCatalogConflictError(
        `Cannot verify backup object while it is ${object.state}`,
      );
    }
    const [updated] = await tx
      .update(agentBackupObjects)
      .set({
        state: "verified",
        verified_at: sql`COALESCE(${agentBackupObjects.verified_at}, NOW())`,
        updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.upload_receipt_digest, params.uploadReceiptDigest),
          sql`${agentBackupObjects.state} IN ('present', 'verified')`,
        ),
      )
      .returning();
    if (!updated) {
      throw new AgentBackupCatalogConflictError(
        "Backup object verification is missing its exact upload receipt",
      );
    }
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}
