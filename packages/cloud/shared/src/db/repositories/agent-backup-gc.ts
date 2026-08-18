/** Durable exact-generation GC outbox for sandbox backup objects. */

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  boundedBackupCatalogError,
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  type AgentBackupGcOutboxRow,
  type AgentBackupObject,
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../schemas/agent-backup-catalog";
import { agentSandboxBackups, type StoredAgentSandboxBackup } from "../schemas/agent-sandboxes";
import {
  AgentBackupCatalogConflictError,
  advanceAgentBackupCatalogRevision,
  lockAgentBackupCatalogAuthority,
  stampAgentBackupCatalogRevision,
} from "./agent-backup-catalog";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_GC_BATCH = 100;
const MAX_GC_LEASE_MS = 5 * 60 * 1_000;
const MAX_GC_ATTEMPTS = 12;
const MAX_GC_BACKOFF_MS = 6 * 60 * 60 * 1_000;

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value)) throw new Error(`${field} must be a canonical UUID`);
  return value.toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function agentBackupGcLocatorDigest(
  object: Pick<
    AgentBackupObject,
    | "transport"
    | "provider"
    | "endpoint_alias"
    | "endpoint_identity_fingerprint"
    | "bucket"
    | "region"
    | "object_key"
    | "key_fingerprint"
    | "provider_write_started"
    | "provider_version_id"
    | "provider_etag"
    | "provider_checksum"
  >,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      version: 1,
      transport: object.transport,
      provider: object.provider,
      endpointAlias: object.endpoint_alias,
      endpointIdentityFingerprint: object.endpoint_identity_fingerprint,
      bucket: object.bucket,
      region: object.region,
      objectKey: object.object_key,
      keyFingerprint: object.key_fingerprint,
      providerWriteStarted: object.provider_write_started,
      providerVersionId: object.provider_version_id,
      providerEtag: object.provider_etag,
      providerChecksum: object.provider_checksum,
    }),
  );
}

export interface AgentBackupGcClaim {
  outbox: AgentBackupGcOutboxRow;
  object: AgentBackupObject;
}

export interface AgentBackupDeletionCandidate {
  organizationId: string;
  backupId: string;
  operationId: string;
}

function requireGcCandidateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GC_BATCH) {
    throw new Error(`limit must be between 1 and ${MAX_GC_BATCH}`);
  }
}

/**
 * Lock one GC mutation in the global catalogue order:
 * backup -> authority -> object -> outbox. The initial reads resolve immutable
 * foreign keys only; every value is revalidated after the authoritative locks.
 */
async function lockAgentBackupGcMutation(
  tx: DbTransaction,
  outboxId: string,
  options: { skipLockedBackup?: boolean } = {},
) {
  const [intentLocator] = await tx
    .select({
      objectId: agentBackupGcOutbox.object_id,
      organizationId: agentBackupGcOutbox.organization_id,
    })
    .from(agentBackupGcOutbox)
    .where(eq(agentBackupGcOutbox.id, outboxId))
    .limit(1);
  if (!intentLocator) throw new AgentBackupCatalogConflictError("GC intent missing");
  const [objectLocator] = await tx
    .select({ backupId: agentBackupObjects.backup_id })
    .from(agentBackupObjects)
    .where(
      and(
        eq(agentBackupObjects.id, intentLocator.objectId),
        eq(agentBackupObjects.organization_id, intentLocator.organizationId),
      ),
    )
    .limit(1);
  if (!objectLocator) {
    throw new AgentBackupCatalogConflictError("GC object authority is missing");
  }

  const backupQuery = tx
    .select()
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.id, objectLocator.backupId),
        eq(agentSandboxBackups.catalog_organization_id, intentLocator.organizationId),
      ),
    );
  const [backup] = options.skipLockedBackup
    ? await backupQuery.for("update", { skipLocked: true }).limit(1)
    : await backupQuery.for("update").limit(1);
  if (!backup) {
    if (options.skipLockedBackup) return null;
    throw new AgentBackupCatalogConflictError("GC backup authority is missing");
  }
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
        eq(agentBackupObjects.id, intentLocator.objectId),
        eq(agentBackupObjects.organization_id, intentLocator.organizationId),
        eq(agentBackupObjects.backup_id, backup.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!object) throw new AgentBackupCatalogConflictError("GC object authority changed");
  const [intent] = await tx
    .select()
    .from(agentBackupGcOutbox)
    .where(
      and(
        eq(agentBackupGcOutbox.id, outboxId),
        eq(agentBackupGcOutbox.organization_id, intentLocator.organizationId),
        eq(agentBackupGcOutbox.object_id, object.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!intent) throw new AgentBackupCatalogConflictError("GC intent authority changed");
  return { authority, backup, object, intent };
}

/**
 * Return a bounded, tenant-fair batch whose retention clock has expired and
 * whose exact-object deletion can be (re)enqueued idempotently. The mutating
 * enqueue function re-locks and revalidates every invariant, so two daemons
 * observing the same row are safe after response loss.
 */
export async function listDueAgentBackupDeletions(params: {
  limit: number;
}): Promise<AgentBackupDeletionCandidate[]> {
  requireGcCandidateLimit(params.limit);
  const rows = await sqlRows<{
    organization_id: string;
    backup_id: string;
    operation_id: string;
  }>(
    dbWrite,
    sql`
      WITH fair AS MATERIALIZED (
        SELECT DISTINCT ON (backup.catalog_organization_id)
          backup.catalog_organization_id AS organization_id,
          backup.id AS backup_id,
          backup.backup_operation_id AS operation_id,
          backup.retention_until,
          backup.created_at
        FROM ${agentSandboxBackups} AS backup
        WHERE backup.catalog_version = 2
          AND backup.catalog_state IN (
            'protected', 'retained', 'restore_verified',
            'expiration_pending', 'deleting',
            'failed_retryable', 'failed_terminal'
          )
          AND backup.catalog_organization_id IS NOT NULL
          AND backup.backup_operation_id IS NOT NULL
          AND backup.retention_until <= clock_timestamp()
          AND backup.retention_reason <> 'legal-hold'
          AND (
            backup.catalog_state IN (
              'protected', 'retained', 'restore_verified',
              'expiration_pending', 'deleting'
            )
            OR (
              backup.catalog_state = 'failed_retryable'
              AND backup.catalog_attempts >= ${MAX_GC_ATTEMPTS}
              AND EXISTS (
                SELECT 1 FROM ${agentBackupObjects} AS failed_object
                WHERE failed_object.backup_id = backup.id
              )
            )
            OR (
              backup.catalog_state = 'failed_terminal'
              AND EXISTS (
                SELECT 1 FROM ${agentBackupObjects} AS failed_object
                WHERE failed_object.backup_id = backup.id
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentBackupRestoreLeases} AS restore_lease
            WHERE restore_lease.backup_id = backup.id
              AND restore_lease.organization_id = backup.catalog_organization_id
              AND restore_lease.released_at IS NULL
              AND restore_lease.expires_at > clock_timestamp()
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentSandboxBackups} AS child
            WHERE child.catalog_version = 2
              AND child.catalog_organization_id = backup.catalog_organization_id
              AND child.catalog_agent_id = backup.catalog_agent_id
              AND (child.parent_backup_id = backup.id OR child.base_backup_id = backup.id)
              AND child.catalog_state IS DISTINCT FROM 'deleted'
              AND NOT (
                child.catalog_state = 'failed_terminal'
                AND NOT EXISTS (
                  SELECT 1 FROM ${agentBackupObjects} AS child_object
                  WHERE child_object.backup_id = child.id
                )
              )
          )
        ORDER BY backup.catalog_organization_id, backup.retention_until, backup.created_at, backup.id
      )
      SELECT organization_id, backup_id, operation_id
      FROM fair
      ORDER BY retention_until, created_at, backup_id
      LIMIT ${params.limit}
    `,
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    backupId: row.backup_id,
    operationId: row.operation_id,
  }));
}

/**
 * Return only deletion operations whose provider receipts and object states
 * already prove that final tombstoning is safe.
 * Finalization rechecks everything under row locks.
 */
export async function listFinalizableAgentBackupDeletions(params: {
  limit: number;
}): Promise<AgentBackupDeletionCandidate[]> {
  requireGcCandidateLimit(params.limit);
  const rows = await sqlRows<{
    organization_id: string;
    backup_id: string;
    operation_id: string;
  }>(
    dbWrite,
    sql`
      WITH fair AS MATERIALIZED (
        SELECT DISTINCT ON (backup.catalog_organization_id)
          backup.catalog_organization_id AS organization_id,
          backup.id AS backup_id,
          backup.backup_operation_id AS operation_id,
          backup.created_at
        FROM ${agentSandboxBackups} AS backup
        WHERE backup.catalog_version = 2
          AND backup.catalog_state = 'deleting'
          AND backup.catalog_organization_id IS NOT NULL
          AND backup.backup_operation_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${agentBackupObjects} AS backup_object
            WHERE backup_object.backup_id = backup.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${agentBackupObjects} AS backup_object
            WHERE backup_object.backup_id = backup.id
              AND backup_object.state <> 'deleted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${agentBackupObjects} AS backup_object
            WHERE backup_object.backup_id = backup.id
              AND NOT EXISTS (
                SELECT 1 FROM ${agentBackupGcOutbox} AS deletion_intent
                WHERE deletion_intent.object_id = backup_object.id
                  AND deletion_intent.action = 'delete_object'
                  AND deletion_intent.state = 'completed'
                  AND deletion_intent.receipt_digest IS NOT NULL
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentBackupGcOutbox} AS pending_intent
            JOIN ${agentBackupObjects} AS pending_object
              ON pending_object.id = pending_intent.object_id
            WHERE pending_object.backup_id = backup.id
              AND (pending_intent.state <> 'completed' OR pending_intent.receipt_digest IS NULL)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentBackupRestoreLeases} AS restore_lease
            WHERE restore_lease.backup_id = backup.id
              AND restore_lease.organization_id = backup.catalog_organization_id
              AND restore_lease.released_at IS NULL
              AND restore_lease.expires_at > clock_timestamp()
          )
        ORDER BY backup.catalog_organization_id, backup.created_at, backup.id
      )
      SELECT organization_id, backup_id, operation_id
      FROM fair
      ORDER BY created_at, backup_id
      LIMIT ${params.limit}
    `,
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    backupId: row.backup_id,
    operationId: row.operation_id,
  }));
}
export async function enqueueAgentBackupDeletion(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
}): Promise<{ backup: StoredAgentSandboxBackup; enqueued: number }> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");

  return dbWrite.transaction(async (tx) => {
    const [loadedBackup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!loadedBackup?.catalog_state) {
      throw new AgentBackupCatalogConflictError("Backup operation missing");
    }
    let backup = loadedBackup;
    if (backup.catalog_state === "deleted") return { backup, enqueued: 0 };
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const organizationId = backup.catalog_organization_id;
    const agentId = backup.catalog_agent_id;
    const authority = await lockAgentBackupCatalogAuthority(tx, organizationId, agentId);
    const successfulState = ["protected", "retained", "restore_verified"].includes(
      backup.catalog_state as string,
    );
    if (backup.catalog_state === "failed_retryable" || backup.catalog_state === "failed_terminal") {
      const [{ count: objectCount } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agentBackupObjects)
        .where(eq(agentBackupObjects.backup_id, backup.id));
      if (objectCount === 0) {
        // A pre-upload terminal row retains its bounded diagnostic evidence,
        // but has no provider quota to compensate.
        return { backup, enqueued: 0 };
      }
      if (backup.retention_reason === "legal-hold") {
        throw new AgentBackupCatalogConflictError(
          "A failed legal-hold operation requires explicit hold-release authority",
        );
      }
      if (
        backup.catalog_state === "failed_retryable" &&
        backup.catalog_attempts < MAX_GC_ATTEMPTS
      ) {
        throw new AgentBackupCatalogConflictError(
          "Retryable backup compensation is unavailable before the retry budget is exhausted",
        );
      }
    }
    if (
      !successfulState &&
      backup.catalog_state !== "failed_retryable" &&
      backup.catalog_state !== "failed_terminal" &&
      backup.catalog_state !== "expiration_pending" &&
      backup.catalog_state !== "deleting"
    ) {
      throw new AgentBackupCatalogConflictError(
        `Backup deletion cannot start while operation is ${backup.catalog_state}`,
      );
    }
    const databaseNow = await readPostLockDatabaseNow(tx);
    const [retentionEligible] = await tx
      .select({ id: agentSandboxBackups.id })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, backup.id),
          lte(agentSandboxBackups.retention_until, databaseNow),
          sql`${agentSandboxBackups.retention_reason} <> 'legal-hold'`,
        ),
      )
      .limit(1);
    if (!retentionEligible) {
      throw new AgentBackupCatalogConflictError(
        backup.retention_reason === "legal-hold"
          ? "A legal-hold backup cannot enter object GC"
          : "Backup retention has not expired according to the primary database clock",
      );
    }
    const [dependent] = await tx
      .select({ id: agentSandboxBackups.id })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.catalog_version, 2),
          eq(agentSandboxBackups.catalog_organization_id, backup.catalog_organization_id as string),
          eq(agentSandboxBackups.catalog_agent_id, backup.catalog_agent_id as string),
          sql`(
            ${agentSandboxBackups.parent_backup_id} = ${backup.id}
            OR ${agentSandboxBackups.base_backup_id} = ${backup.id}
          )`,
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
        "Backup object GC is blocked by a dependent incremental",
      );
    }

    const [activeLease] = await tx
      .select({ id: agentBackupRestoreLeases.id })
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.backup_id, backup.id),
          eq(agentBackupRestoreLeases.organization_id, backup.catalog_organization_id),
          isNull(agentBackupRestoreLeases.released_at),
          gt(agentBackupRestoreLeases.expires_at, databaseNow),
        ),
      )
      .limit(1);
    if (activeLease) {
      throw new AgentBackupCatalogConflictError("Backup has an active restore lease");
    }

    let semanticMutation = false;
    if (
      successfulState ||
      backup.catalog_state === "failed_retryable" ||
      backup.catalog_state === "failed_terminal"
    ) {
      const expiringFromState = backup.catalog_state;
      if (!expiringFromState) {
        throw new AgentBackupCatalogConflictError("Backup catalogue state is missing");
      }
      const [expiring] = await tx
        .update(agentSandboxBackups)
        .set({
          catalog_state: "expiration_pending",
          catalog_resume_state: null,
          catalog_lease_owner: null,
          catalog_lease_generation: null,
          catalog_lease_expires_at: null,
          catalog_next_attempt_at: null,
          catalog_updated_at: databaseNow,
        })
        .where(
          and(
            eq(agentSandboxBackups.id, backup.id),
            eq(agentSandboxBackups.catalog_state, expiringFromState),
          ),
        )
        .returning();
      if (!expiring) {
        throw new AgentBackupCatalogConflictError("Backup automatic expiration CAS lost");
      }
      backup = expiring;
      semanticMutation = true;
    }

    let current = backup;
    if (backup.catalog_state === "expiration_pending") {
      const [moved] = await tx
        .update(agentSandboxBackups)
        .set({ catalog_state: "deleting", catalog_updated_at: databaseNow })
        .where(
          and(
            eq(agentSandboxBackups.id, backup.id),
            eq(agentSandboxBackups.catalog_state, "expiration_pending"),
          ),
        )
        .returning();
      if (!moved) throw new AgentBackupCatalogConflictError("Backup deletion CAS lost");
      current = moved;
      semanticMutation = true;
    }

    const objects = await tx
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.backup_id, backup.id))
      .for("update");
    if (objects.length === 0) {
      throw new AgentBackupCatalogConflictError("Catalogued backup has no object authority");
    }
    let enqueued = 0;
    for (const object of objects) {
      if (object.state === "quarantined") {
        throw new AgentBackupCatalogConflictError("Backup has a quarantined object");
      }
      if (
        object.state !== "delete_pending" &&
        object.state !== "deleting" &&
        object.state !== "deleted"
      ) {
        const [pending] = await tx
          .update(agentBackupObjects)
          .set({ state: "delete_pending", updated_at: databaseNow })
          .where(
            and(eq(agentBackupObjects.id, object.id), eq(agentBackupObjects.state, object.state)),
          )
          .returning({ id: agentBackupObjects.id });
        if (!pending) throw new AgentBackupCatalogConflictError("Backup object GC CAS lost");
        semanticMutation = true;
      }
      const expectedLocatorDigest = await agentBackupGcLocatorDigest(object);
      const [intent] = await tx
        .insert(agentBackupGcOutbox)
        .values({
          organization_id: object.organization_id,
          object_id: object.id,
          action: "delete_object",
          expected_locator_digest: expectedLocatorDigest,
          expected_key_fingerprint: object.key_fingerprint,
          expected_provider_version_id: object.provider_version_id,
          expected_provider_etag: object.provider_etag,
          expected_provider_checksum: object.provider_checksum,
          expected_provider_write_started: object.provider_write_started,
          context: { backupId: backup.id, copyRole: object.copy_role },
        })
        .onConflictDoNothing()
        .returning({ id: agentBackupGcOutbox.id });
      if (intent) enqueued += 1;
      if (intent) semanticMutation = true;
    }
    if (semanticMutation) {
      await stampAgentBackupCatalogRevision(tx, {
        backupId: backup.id,
        organizationId,
        agentId,
        expectedRevision: authority.catalog_revision,
      });
      const [revisionStamped] = await tx
        .select()
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, backup.id))
        .limit(1);
      if (!revisionStamped) {
        throw new AgentBackupCatalogConflictError("Backup deletion revision stamp disappeared");
      }
      current = revisionStamped;
    }
    return { backup: current, enqueued };
  });
}

export async function claimAgentBackupGc(params: {
  ownerId: string;
  limit: number;
  leaseMs: number;
}): Promise<AgentBackupGcClaim[]> {
  requireBoundedIdentity(params.ownerId, "ownerId");
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_GC_BATCH) {
    throw new Error(`limit must be between 1 and ${MAX_GC_BATCH}`);
  }
  if (
    !Number.isSafeInteger(params.leaseMs) ||
    params.leaseMs < 1 ||
    params.leaseMs > MAX_GC_LEASE_MS
  ) {
    throw new Error(`leaseMs must be between 1 and ${MAX_GC_LEASE_MS}`);
  }
  const generation = randomUUID();
  // Discovery does not authorize a claim. Every candidate gets its own short
  // transaction so an early row cannot consume the lease lifetime of later rows.
  const due = await dbWrite
    .select({ id: agentBackupGcOutbox.id })
    .from(agentBackupGcOutbox)
    .where(
      and(
        lte(agentBackupGcOutbox.next_attempt_at, sql`clock_timestamp()`),
        or(
          eq(agentBackupGcOutbox.state, "pending"),
          and(
            eq(agentBackupGcOutbox.state, "leased"),
            lte(agentBackupGcOutbox.lease_expires_at, sql`clock_timestamp()`),
          ),
        ),
      ),
    )
    .orderBy(asc(agentBackupGcOutbox.next_attempt_at), asc(agentBackupGcOutbox.created_at))
    .limit(Math.min(MAX_GC_BATCH, params.limit * 4));
  const result: AgentBackupGcClaim[] = [];
  for (const candidate of due) {
    if (result.length >= params.limit) break;
    const claim = await dbWrite.transaction(async (tx) => {
      const context = await lockAgentBackupGcMutation(tx, candidate.id, {
        skipLockedBackup: true,
      });
      if (!context) return null;
      const { authority, backup, object, intent } = context;
      const locatorMatches =
        object.key_fingerprint === intent.expected_key_fingerprint &&
        object.provider_version_id === intent.expected_provider_version_id &&
        object.provider_etag === intent.expected_provider_etag &&
        object.provider_checksum === intent.expected_provider_checksum &&
        object.provider_write_started === intent.expected_provider_write_started &&
        (await agentBackupGcLocatorDigest(object)) === intent.expected_locator_digest;
      const databaseNow = await readPostLockDatabaseNow(tx);
      const dueAt = intent.next_attempt_at.getTime() <= databaseNow.getTime();
      const expiredLease =
        intent.state === "leased" &&
        intent.lease_expires_at !== null &&
        intent.lease_expires_at.getTime() <= databaseNow.getTime();
      if (!dueAt || (intent.state !== "pending" && !expiredLease)) return null;
      const claimableFence = and(
        eq(agentBackupGcOutbox.id, intent.id),
        lte(agentBackupGcOutbox.next_attempt_at, sql`clock_timestamp()`),
        or(
          eq(agentBackupGcOutbox.state, "pending"),
          and(
            eq(agentBackupGcOutbox.state, "leased"),
            lte(agentBackupGcOutbox.lease_expires_at, sql`clock_timestamp()`),
          ),
        ),
      );
      if (!locatorMatches) {
        const [quarantined] = await tx
          .update(agentBackupGcOutbox)
          .set({
            state: "quarantined",
            claim_owner: null,
            claim_generation: null,
            lease_expires_at: null,
            attempts: sql`${agentBackupGcOutbox.attempts} + 1`,
            last_error_code: "GC_LOCATOR_CHANGED",
            last_error: "Object locator authority changed while claiming",
            updated_at: databaseNow,
          })
          .where(claimableFence)
          .returning({ id: agentBackupGcOutbox.id });
        if (!quarantined) {
          throw new AgentBackupCatalogConflictError("GC quarantine CAS lost");
        }
        await tx
          .update(agentBackupObjects)
          .set({ state: "quarantined", updated_at: databaseNow })
          .where(eq(agentBackupObjects.id, object.id));
        await stampAgentBackupCatalogRevision(tx, {
          backupId: backup.id,
          organizationId: backup.catalog_organization_id as string,
          agentId: backup.catalog_agent_id as string,
          expectedRevision: authority.catalog_revision,
        });
        return null;
      }
      const expiresAt = new Date(databaseNow.getTime() + params.leaseMs);
      const [claimed] = await tx
        .update(agentBackupGcOutbox)
        .set({
          state: "leased",
          claim_owner: params.ownerId,
          claim_generation: generation,
          lease_expires_at: expiresAt,
          attempts: sql`${agentBackupGcOutbox.attempts} + 1`,
          updated_at: databaseNow,
        })
        .where(claimableFence)
        .returning();
      if (!claimed) throw new AgentBackupCatalogConflictError("GC claim CAS lost");
      const postClaimDatabaseNow = await readPostLockDatabaseNow(tx);
      if (
        !claimed.lease_expires_at ||
        claimed.lease_expires_at.getTime() <= postClaimDatabaseNow.getTime()
      ) {
        throw new AgentBackupCatalogConflictError("GC claim expired before it could be returned");
      }
      return { outbox: claimed, object };
    });
    if (claim) result.push(claim);
  }
  return result;
}

/**
 * Persist an exact provider generation discovered after an ambiguous upload.
 * The object and its outbox fence advance in one transaction before DELETE.
 */
export async function adoptAgentBackupGcObservedLocator(params: {
  outboxId: string;
  ownerId: string;
  generation: string;
  providerVersionId?: string | null;
  providerEtag?: string | null;
  providerChecksum?: string | null;
  uploadReceiptDigest: string;
}): Promise<AgentBackupGcClaim> {
  requireUuid(params.outboxId, "outboxId");
  requireUuid(params.generation, "generation");
  requireBoundedIdentity(params.ownerId, "ownerId");
  requireSha256Hex(params.uploadReceiptDigest, "uploadReceiptDigest");
  const providerVersionId = params.providerVersionId ?? null;
  const providerEtag = params.providerEtag ?? null;
  const providerChecksum = params.providerChecksum ?? null;
  if (providerVersionId) requireBoundedIdentity(providerVersionId, "providerVersionId");
  if (providerEtag) requireBoundedIdentity(providerEtag, "providerEtag");
  if (providerChecksum) requireBoundedIdentity(providerChecksum, "providerChecksum");
  if (!providerVersionId && !providerEtag && !providerChecksum) {
    throw new Error("GC locator adoption requires a provider version, ETag, or checksum");
  }

  return dbWrite.transaction(async (tx) => {
    const context = await lockAgentBackupGcMutation(tx, params.outboxId);
    if (!context) throw new AgentBackupCatalogConflictError("GC mutation lock unavailable");
    const { authority, backup, intent, object } = context;
    if (
      intent.state !== "leased" ||
      intent.claim_owner !== params.ownerId ||
      intent.claim_generation !== params.generation
    ) {
      throw new AgentBackupCatalogConflictError("GC locator adoption lease is not owned");
    }
    if (!object.provider_write_started || !intent.expected_provider_write_started) {
      throw new AgentBackupCatalogConflictError(
        "GC cannot adopt a provider locator without a persisted write-start authority",
      );
    }
    if (
      object.key_fingerprint !== intent.expected_key_fingerprint ||
      object.provider_version_id !== intent.expected_provider_version_id ||
      object.provider_etag !== intent.expected_provider_etag ||
      object.provider_checksum !== intent.expected_provider_checksum ||
      (await agentBackupGcLocatorDigest(object)) !== intent.expected_locator_digest
    ) {
      throw new AgentBackupCatalogConflictError(
        "GC pre-adoption object authority no longer matches its outbox fence",
      );
    }

    if (object.state !== "delete_pending" && object.state !== "deleting") {
      throw new AgentBackupCatalogConflictError(
        `Cannot adopt a GC locator while object is ${object.state}`,
      );
    }
    const exactReplay =
      object.provider_version_id === providerVersionId &&
      object.provider_etag === providerEtag &&
      object.provider_checksum === providerChecksum &&
      object.upload_receipt_digest === params.uploadReceiptDigest &&
      intent.expected_provider_version_id === providerVersionId &&
      intent.expected_provider_etag === providerEtag &&
      intent.expected_provider_checksum === providerChecksum;
    if (exactReplay) {
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (!intent.lease_expires_at || intent.lease_expires_at.getTime() <= databaseNow.getTime()) {
        throw new AgentBackupCatalogConflictError("GC execution lease expired");
      }
      return { outbox: intent, object };
    }
    if (
      object.provider_version_id !== null ||
      object.provider_etag !== null ||
      object.provider_checksum !== null ||
      object.upload_receipt_digest !== null ||
      intent.expected_provider_version_id !== null ||
      intent.expected_provider_etag !== null ||
      intent.expected_provider_checksum !== null
    ) {
      throw new AgentBackupCatalogConflictError("GC provider locator authority diverged");
    }

    const [updatedObject] = await tx
      .update(agentBackupObjects)
      .set({
        provider_version_id: providerVersionId,
        provider_etag: providerEtag,
        provider_checksum: providerChecksum,
        upload_receipt_digest: params.uploadReceiptDigest,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentBackupObjects.id, object.id),
          eq(agentBackupObjects.organization_id, intent.organization_id),
          eq(agentBackupObjects.provider_write_started, true),
          sql`${agentBackupObjects.state} IN ('delete_pending', 'deleting')`,
          sql`${agentBackupObjects.provider_version_id} IS NULL`,
          sql`${agentBackupObjects.provider_etag} IS NULL`,
          sql`${agentBackupObjects.provider_checksum} IS NULL`,
          sql`${agentBackupObjects.upload_receipt_digest} IS NULL`,
        ),
      )
      .returning();
    if (!updatedObject) throw new AgentBackupCatalogConflictError("GC locator adoption CAS lost");
    const expectedLocatorDigest = await agentBackupGcLocatorDigest(updatedObject);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (!intent.lease_expires_at || intent.lease_expires_at.getTime() <= databaseNow.getTime()) {
      throw new AgentBackupCatalogConflictError("GC execution lease expired");
    }
    const [updatedIntent] = await tx
      .update(agentBackupGcOutbox)
      .set({
        expected_locator_digest: expectedLocatorDigest,
        expected_provider_version_id: providerVersionId,
        expected_provider_etag: providerEtag,
        expected_provider_checksum: providerChecksum,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupGcOutbox.id, intent.id),
          eq(agentBackupGcOutbox.state, "leased"),
          eq(agentBackupGcOutbox.claim_owner, params.ownerId),
          eq(agentBackupGcOutbox.claim_generation, params.generation),
          gt(agentBackupGcOutbox.lease_expires_at, sql`clock_timestamp()`),
          sql`${agentBackupGcOutbox.expected_provider_version_id} IS NULL`,
          sql`${agentBackupGcOutbox.expected_provider_etag} IS NULL`,
          sql`${agentBackupGcOutbox.expected_provider_checksum} IS NULL`,
          eq(agentBackupGcOutbox.expected_provider_write_started, true),
        ),
      )
      .returning();
    if (!updatedIntent) {
      throw new AgentBackupCatalogConflictError("GC locator outbox adoption CAS lost");
    }
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id as string,
      agentId: backup.catalog_agent_id as string,
      expectedRevision: authority.catalog_revision,
    });
    return { outbox: updatedIntent, object: updatedObject };
  });
}

export async function settleAgentBackupGc(params: {
  outboxId: string;
  ownerId: string;
  generation: string;
  receiptDigest: string;
}): Promise<AgentBackupGcOutboxRow> {
  requireUuid(params.outboxId, "outboxId");
  requireUuid(params.generation, "generation");
  requireBoundedIdentity(params.ownerId, "ownerId");
  requireSha256Hex(params.receiptDigest, "receiptDigest");

  return dbWrite.transaction(async (tx) => {
    const context = await lockAgentBackupGcMutation(tx, params.outboxId);
    if (!context) throw new AgentBackupCatalogConflictError("GC mutation lock unavailable");
    const { authority, backup, intent, object: ownedObject } = context;
    if (intent.state === "completed") {
      if (intent.receipt_digest !== params.receiptDigest) {
        throw new AgentBackupCatalogConflictError("GC receipt replay mismatch");
      }
      return intent;
    }
    if (
      intent.state !== "leased" ||
      intent.claim_owner !== params.ownerId ||
      intent.claim_generation !== params.generation
    ) {
      throw new AgentBackupCatalogConflictError("GC execution lease is not owned by this worker");
    }
    if (
      ownedObject.key_fingerprint !== intent.expected_key_fingerprint ||
      ownedObject.provider_version_id !== intent.expected_provider_version_id ||
      ownedObject.provider_etag !== intent.expected_provider_etag ||
      ownedObject.provider_checksum !== intent.expected_provider_checksum ||
      ownedObject.provider_write_started !== intent.expected_provider_write_started ||
      (await agentBackupGcLocatorDigest(ownedObject)) !== intent.expected_locator_digest
    ) {
      throw new AgentBackupCatalogConflictError("GC object locator changed before settlement");
    }

    if (
      ownedObject.state === "deleted" &&
      ownedObject.delete_receipt_digest !== params.receiptDigest
    ) {
      throw new AgentBackupCatalogConflictError("Object delete receipt replay mismatch");
    }
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (!intent.lease_expires_at || intent.lease_expires_at.getTime() <= databaseNow.getTime()) {
      throw new AgentBackupCatalogConflictError("GC execution lease expired");
    }
    const [object] = await tx
      .update(agentBackupObjects)
      .set({
        state: "deleted",
        delete_receipt_digest: params.receiptDigest,
        deleted_at: ownedObject.deleted_at ?? databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupObjects.id, intent.object_id),
          eq(agentBackupObjects.organization_id, intent.organization_id),
          eq(agentBackupObjects.key_fingerprint, intent.expected_key_fingerprint),
          sql`${agentBackupObjects.state} IN ('delete_pending', 'deleting', 'deleted')`,
        ),
      )
      .returning({ id: agentBackupObjects.id });
    if (!object) throw new AgentBackupCatalogConflictError("GC object locator fence failed");

    const [completed] = await tx
      .update(agentBackupGcOutbox)
      .set({
        state: "completed",
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        receipt_digest: params.receiptDigest,
        completed_at: databaseNow,
        last_error_code: null,
        last_error: null,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupGcOutbox.id, intent.id),
          eq(agentBackupGcOutbox.state, "leased"),
          eq(agentBackupGcOutbox.claim_owner, params.ownerId),
          eq(agentBackupGcOutbox.claim_generation, params.generation),
          gt(agentBackupGcOutbox.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!completed) throw new AgentBackupCatalogConflictError("GC settlement CAS lost");
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id as string,
      agentId: backup.catalog_agent_id as string,
      expectedRevision: authority.catalog_revision,
    });
    return completed;
  });
}

export async function failAgentBackupGc(params: {
  outboxId: string;
  ownerId: string;
  generation: string;
  error: { code: string; message: string };
  retryDelayMs: number;
  terminal?: boolean;
}): Promise<AgentBackupGcOutboxRow> {
  requireUuid(params.outboxId, "outboxId");
  requireUuid(params.generation, "generation");
  requireBoundedIdentity(params.ownerId, "ownerId");
  const error = boundedBackupCatalogError(params.error);
  if (
    !Number.isSafeInteger(params.retryDelayMs) ||
    params.retryDelayMs < 1 ||
    params.retryDelayMs > MAX_GC_BACKOFF_MS
  ) {
    throw new Error(`retryDelayMs must be between 1 and ${MAX_GC_BACKOFF_MS}`);
  }
  const failureDigest = await sha256Hex(
    JSON.stringify({
      version: 1,
      outboxId: params.outboxId.toLowerCase(),
      ownerId: params.ownerId,
      generation: params.generation.toLowerCase(),
      error,
      retryDelayMs: params.retryDelayMs,
      terminal: params.terminal === true,
    }),
  );

  return dbWrite.transaction(async (tx) => {
    const context = await lockAgentBackupGcMutation(tx, params.outboxId);
    if (!context) throw new AgentBackupCatalogConflictError("GC mutation lock unavailable");
    const { authority, backup, intent } = context;
    // A provider/DB response can be lost after settlement commits. Treat a
    // later failure callback as an exact completed replay instead of poisoning
    // the rest of the worker batch.
    if (intent.state === "completed") return intent;
    if (
      (intent.state === "pending" || intent.state === "quarantined") &&
      intent.last_failure_generation === params.generation.toLowerCase() &&
      intent.last_failure_digest === failureDigest
    ) {
      return intent;
    }
    if (
      intent.state !== "leased" ||
      intent.claim_owner !== params.ownerId ||
      intent.claim_generation !== params.generation
    ) {
      throw new AgentBackupCatalogConflictError("GC failure writeback lost its execution lease");
    }
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (!intent.lease_expires_at || intent.lease_expires_at.getTime() <= databaseNow.getTime()) {
      throw new AgentBackupCatalogConflictError("GC execution lease expired");
    }
    const quarantine = params.terminal === true || intent.attempts >= MAX_GC_ATTEMPTS;
    const [updated] = await tx
      .update(agentBackupGcOutbox)
      .set({
        state: quarantine ? "quarantined" : "pending",
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        next_attempt_at: quarantine
          ? intent.next_attempt_at
          : new Date(databaseNow.getTime() + params.retryDelayMs),
        last_error_code: error.code,
        last_error: error.message,
        last_failure_generation: params.generation.toLowerCase(),
        last_failure_digest: failureDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupGcOutbox.id, intent.id),
          eq(agentBackupGcOutbox.state, "leased"),
          eq(agentBackupGcOutbox.claim_owner, params.ownerId),
          eq(agentBackupGcOutbox.claim_generation, params.generation),
          gt(agentBackupGcOutbox.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("GC failure writeback CAS lost");
    if (quarantine) {
      await tx
        .update(agentBackupObjects)
        .set({ state: "quarantined", updated_at: databaseNow })
        .where(eq(agentBackupObjects.id, intent.object_id));
    }
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id as string,
      agentId: backup.catalog_agent_id as string,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}

export async function finalizeAgentBackupDeletion(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup?.catalog_state) throw new AgentBackupCatalogConflictError("Backup missing");
    if (backup.catalog_state === "deleted") {
      if (!backup.catalog_delete_receipt_digest || !backup.catalog_deleted_at) {
        throw new AgentBackupCatalogConflictError("Deleted backup is missing its receipt");
      }
      return backup;
    }
    if (backup.catalog_state !== "deleting") {
      throw new AgentBackupCatalogConflictError("Backup is not deleting");
    }
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const databaseNow = await readPostLockDatabaseNow(tx);
    const [activeLease] = await tx
      .select({ id: agentBackupRestoreLeases.id })
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.backup_id, backup.id),
          eq(agentBackupRestoreLeases.organization_id, backup.catalog_organization_id),
          isNull(agentBackupRestoreLeases.released_at),
          gt(agentBackupRestoreLeases.expires_at, databaseNow),
        ),
      )
      .limit(1);
    if (activeLease) {
      throw new AgentBackupCatalogConflictError("Restore lease blocks GC finalization");
    }
    const objects = await tx
      .select({ id: agentBackupObjects.id, state: agentBackupObjects.state })
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.backup_id, backup.id));
    if (objects.length === 0) {
      throw new AgentBackupCatalogConflictError("Catalogued backup has no object authority");
    }
    if (objects.some((object) => object.state !== "deleted")) {
      throw new AgentBackupCatalogConflictError("Not every backup object is proven deleted");
    }
    const intents = await tx
      .select()
      .from(agentBackupGcOutbox)
      .where(
        and(
          eq(agentBackupGcOutbox.organization_id, params.organizationId),
          inArray(
            agentBackupGcOutbox.object_id,
            objects.map((object) => object.id),
          ),
        ),
      )
      .orderBy(asc(agentBackupGcOutbox.id));
    const deleteIntentObjectIds = new Set(
      intents
        .filter((intent) => intent.action === "delete_object")
        .map((intent) => intent.object_id),
    );
    if (
      deleteIntentObjectIds.size !== objects.length ||
      objects.some((object) => !deleteIntentObjectIds.has(object.id))
    ) {
      throw new AgentBackupCatalogConflictError(
        "Every backup object requires an exact delete outbox receipt",
      );
    }
    if (intents.some((intent) => intent.state !== "completed" || !intent.receipt_digest)) {
      throw new AgentBackupCatalogConflictError("Backup GC outbox is not fully receipted");
    }
    const receiptDigest = await sha256Hex(
      JSON.stringify({
        version: 1,
        organizationId: params.organizationId.toLowerCase(),
        backupId: backup.id,
        operationId: params.operationId.toLowerCase(),
        manifestDigest: backup.manifest_digest,
        receipts: intents.map((intent) => ({
          id: intent.id,
          objectId: intent.object_id,
          action: intent.action,
          locatorDigest: intent.expected_locator_digest,
          keyFingerprint: intent.expected_key_fingerprint,
          providerVersionId: intent.expected_provider_version_id,
          providerEtag: intent.expected_provider_etag,
          providerChecksum: intent.expected_provider_checksum,
          providerWriteStarted: intent.expected_provider_write_started,
          receiptDigest: intent.receipt_digest,
        })),
      }),
    );
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    const [deleted] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: "deleted",
        catalog_revision: catalogRevision,
        catalog_delete_receipt_digest: receiptDigest,
        catalog_deleted_at: databaseNow,
        catalog_updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, backup.id),
          eq(agentSandboxBackups.catalog_state, "deleting"),
        ),
      )
      .returning();
    if (!deleted) throw new AgentBackupCatalogConflictError("Backup GC final CAS lost");
    return deleted;
  });
}
