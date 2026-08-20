/**
 * Primary-DB authority for periodic manifest-v3 backup admission.
 *
 * The scheduler performs no provider mutation. It enrolls exact active
 * dedicated sandboxes, leases a fair DB-clock due set, atomically reserves a
 * catalogue operation, and advances the RPO deadline only after the exact
 * operation has durable primary and secondary protection evidence.
 */

import { randomUUID } from "node:crypto";
import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";
import {
  lockAgentBackupReservationReplayInTransaction,
  reserveAgentBackupOperationInTransaction,
} from "./agent-backup-catalog";

export const DEFAULT_AGENT_BACKUP_SCHEDULE_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_AGENT_BACKUP_RPO_MS = 15 * 60_000;
export const DEFAULT_AGENT_BACKUP_SCHEDULE_LEASE_MS = 2 * 60_000;
export const DEFAULT_AGENT_BACKUP_SCHEDULE_RETRY_MS = 30_000;
export const DEFAULT_AGENT_BACKUP_SCHEDULE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_AGENT_BACKUP_SCHEDULE_BATCH = 100;
export const MAX_AGENT_BACKUP_SCHEDULE_LEASE_MS = 5 * 60_000;
export const MAX_AGENT_BACKUP_SCHEDULE_RETRY_MS = 5 * 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE_OPERATION_STATES = [
  "scheduled",
  "capturing",
  "captured",
  "uploading",
  "primary_uploaded",
  "primary_verified",
  "secondary_pending",
  "failed_retryable",
] as const;
const PROTECTED_OPERATION_STATES = ["protected", "retained", "restore_verified"] as const;
const RECYCLABLE_OPERATION_STATES = [
  "failed_terminal",
  "expiration_pending",
  "deleting",
  "deleted",
] as const;

export interface AgentBackupScheduleClaim {
  organizationId: string;
  agentId: string;
  operationId: string;
  ownerId: string;
  generation: string;
  expiresAt: Date;
  /** Original protected-backup deadline; it never moves for an attempt. */
  dueAt: Date;
  attempts: number;
}

export interface AgentBackupScheduleReservation {
  organizationId: string;
  agentId: string;
  operationId: string;
  backupId: string;
  /** Original protected-backup deadline, retained until catalogue proof. */
  dueAt: Date;
}

export interface AgentBackupScheduleReconcileSummary {
  protected: number;
  recycled: number;
}

export class AgentBackupScheduleFenceError extends Error {
  override readonly name = "AgentBackupScheduleFenceError";
}

function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${field} must be a canonical lowercase UUID`);
  return value;
}

function requireBoundedInteger(params: {
  value: number;
  field: string;
  min: number;
  max: number;
}): number {
  if (
    !Number.isSafeInteger(params.value) ||
    params.value < params.min ||
    params.value > params.max
  ) {
    throw new Error(`${params.field} must be between ${params.min} and ${params.max}`);
  }
  return params.value;
}

function requireScheduleErrorCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(value)) {
    throw new Error("errorCode must be a bounded canonical error code");
  }
  return value;
}

function requireDatabaseDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be a valid primary-database timestamp`);
  }
  return date;
}

function validateClaimIdentity(claim: AgentBackupScheduleClaim): void {
  requireUuid(claim.organizationId, "claim.organizationId");
  requireUuid(claim.agentId, "claim.agentId");
  requireUuid(claim.operationId, "claim.operationId");
  requireUuid(claim.generation, "claim.generation");
  requireBoundedIdentity(claim.ownerId, "claim.ownerId");
}

function stableScheduleJitterMs(agentId: string, maxJitterMs: number): number {
  if (maxJitterMs <= 0) return 0;
  let hash = 2_166_136_261;
  for (const char of agentId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % Math.max(1, maxJitterMs);
}

function validateBatch(value: number): number {
  return requireBoundedInteger({
    value,
    field: "limit",
    min: 1,
    max: MAX_AGENT_BACKUP_SCHEDULE_BATCH,
  });
}

function validateCadence(params: { intervalMs?: number; rpoMs?: number }): {
  intervalMs: number;
  rpoMs: number;
} {
  const intervalMs = requireBoundedInteger({
    value: params.intervalMs ?? DEFAULT_AGENT_BACKUP_SCHEDULE_INTERVAL_MS,
    field: "intervalMs",
    min: 60_000,
    max: DEFAULT_AGENT_BACKUP_RPO_MS,
  });
  const rpoMs = requireBoundedInteger({
    value: params.rpoMs ?? DEFAULT_AGENT_BACKUP_RPO_MS,
    field: "rpoMs",
    min: intervalMs,
    max: DEFAULT_AGENT_BACKUP_RPO_MS,
  });
  return { intervalMs, rpoMs };
}

/** Every active catalogue lane, including work superseded by a later activation. */
function activeBackupLanes(activeStates: SQL): SQL {
  return sql`
    SELECT backup.catalog_organization_id AS organization_id,
      backup.source_node_id AS node_id
    FROM ${agentSandboxBackups} AS backup
    WHERE backup.catalog_state IN (${activeStates})
  `;
}

/**
 * Count every active dedicated sandbox whose last exact protection is beyond
 * the 15-minute RPO, including rows not yet reached by bounded enrollment. A
 * running row without a complete immutable activation authority is counted
 * immediately: it is not eligible for capture and must remain observable until
 * the activation slice repairs it. The primary database clock is the only time
 * authority. Before the first scheduled proof, activation completion starts
 * the exposure clock. A protected-but-not-yet-reconciled operation is excluded
 * only when the same strict manifest-v3 evidence used by reconciliation exists.
 */
export async function countOverdueAgentBackupSchedules(): Promise<number> {
  const protectedStates = sql.join(
    PROTECTED_OPERATION_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const [result] = await sqlRows<{ overdue: number | string }>(
    dbWrite,
    sql`
      SELECT COUNT(*)::int AS overdue
      FROM ${agentSandboxes} AS sandbox
      WHERE sandbox.status = 'running'
        AND sandbox.pool_status IS NULL
        AND sandbox.execution_tier <> 'shared'
        AND (
          (
            sandbox.activation_phase = 'active'
            AND sandbox.activation_generation IS NOT NULL
            AND sandbox.activation_lifecycle_revision IS NOT NULL
            AND sandbox.activation_receipt_hash ~ '^[0-9a-f]{64}$'
            AND sandbox.activation_container_id ~ '^[0-9a-f]{64}$'
            AND sandbox.activation_node_id IS NOT NULL
            AND sandbox.activation_image_digest ~ '^sha256:[0-9a-f]{64}$'
            AND sandbox.activation_boot_id IS NOT NULL
            AND sandbox.activation_authority_published_at IS NOT NULL
            AND sandbox.activation_dispatched_at IS NOT NULL
            AND sandbox.activation_completed_at IS NOT NULL
          ) IS NOT TRUE
          OR (
            GREATEST(
              sandbox.activation_completed_at,
              COALESCE(
                sandbox.backup_schedule_last_protected_at,
                sandbox.activation_completed_at
              )
            ) + (${DEFAULT_AGENT_BACKUP_RPO_MS} * INTERVAL '1 millisecond') <= NOW()
            AND NOT EXISTS (
              SELECT 1
              FROM ${agentSandboxBackups} AS backup
              WHERE backup.catalog_organization_id = sandbox.organization_id
                AND backup.catalog_agent_id = sandbox.id
                AND backup.sandbox_record_id = sandbox.id
                AND backup.backup_operation_id = sandbox.backup_schedule_operation_id
                AND backup.lifecycle_generation = sandbox.activation_generation
                AND backup.lifecycle_revision = sandbox.activation_lifecycle_revision
                AND sandbox.lifecycle_revision = sandbox.activation_lifecycle_revision
                AND backup.source_node_id = sandbox.activation_node_id
                AND backup.source_container_id = sandbox.activation_container_id
                AND backup.backup_image_digest = sandbox.activation_image_digest
                AND backup.catalog_version = 2
                AND backup.snapshot_type = 'auto'
                AND backup.backup_kind = 'full'
                AND backup.retention_reason = 'schedule'
                AND backup.catalog_state IN (${protectedStates})
                AND backup.manifest_format = 'elizaos.agent-backup'
                AND backup.manifest_version = 3
                AND backup.manifest_digest ~ '^[0-9a-f]{64}$'
                AND backup.primary_verified_at IS NOT NULL
                AND backup.secondary_verified_at IS NOT NULL
                AND backup.secondary_verified_at >= backup.primary_verified_at
                AND backup.secondary_verified_at <= NOW()
                AND backup.secondary_verified_at
                  + (${DEFAULT_AGENT_BACKUP_RPO_MS} * INTERVAL '1 millisecond') > NOW()
            )
          )
        )
    `,
  );
  const overdue = Number(result?.overdue ?? 0);
  if (!Number.isSafeInteger(overdue) || overdue < 0) {
    throw new Error("Primary database returned an invalid overdue RPO count");
  }
  return overdue;
}

/** Enroll a bounded, organization-fair slice; every newly enrolled row is due now. */
export async function enrollEligibleAgentBackupSchedules(params: {
  limit: number;
}): Promise<number> {
  const limit = validateBatch(params.limit);
  const enrolled = await sqlRows<{ id: string }>(
    dbWrite,
    sql`
      WITH organization_watermarks AS MATERIALIZED (
        SELECT organization_id, MAX(next_backup_at) AS last_enrolled_at
        FROM ${agentSandboxes}
        WHERE next_backup_at IS NOT NULL
        GROUP BY organization_id
      ), ranked AS MATERIALIZED (
        SELECT
          sandbox.id,
          sandbox.organization_id,
          organization_watermarks.last_enrolled_at,
          ROW_NUMBER() OVER (
            PARTITION BY sandbox.organization_id
            ORDER BY sandbox.created_at, sandbox.id
          ) AS organization_rank
        FROM ${agentSandboxes} AS sandbox
        LEFT JOIN organization_watermarks
          ON organization_watermarks.organization_id = sandbox.organization_id
        WHERE sandbox.next_backup_at IS NULL
          AND sandbox.status = 'running'
          AND sandbox.pool_status IS NULL
          AND sandbox.execution_tier <> 'shared'
          AND sandbox.activation_phase = 'active'
          AND sandbox.activation_generation IS NOT NULL
          AND sandbox.activation_lifecycle_revision IS NOT NULL
          AND sandbox.lifecycle_revision = sandbox.activation_lifecycle_revision
          AND sandbox.activation_receipt_hash IS NOT NULL
          AND sandbox.activation_container_id ~ '^[0-9a-f]{64}$'
          AND sandbox.activation_node_id IS NOT NULL
          AND sandbox.activation_image_digest IS NOT NULL
          AND sandbox.activation_authority_published_at IS NOT NULL
          AND sandbox.activation_dispatched_at IS NOT NULL
          AND sandbox.activation_completed_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM ${dockerNodes} AS source_node
            WHERE source_node.node_id = sandbox.activation_node_id
              AND source_node.node_incarnation IS NOT NULL
              AND (
                (source_node.fleet_kind = 'robot'
                  AND source_node.provider_server_id IS NULL)
                OR (source_node.fleet_kind = 'cloud'
                  AND source_node.provider_server_id IS NOT NULL)
              )
          )
      ), candidates AS MATERIALIZED (
        SELECT id
        FROM ranked
        ORDER BY organization_rank, last_enrolled_at NULLS FIRST, organization_id, id
        LIMIT ${limit}
      )
      UPDATE ${agentSandboxes} AS sandbox
      SET next_backup_at = NOW(),
          backup_schedule_operation_id = NULL,
          backup_schedule_retry_at = NULL,
          backup_schedule_attempts = 0,
          backup_schedule_last_error_code = NULL,
          updated_at = NOW()
      FROM candidates
      WHERE sandbox.id = candidates.id
        AND sandbox.next_backup_at IS NULL
      RETURNING sandbox.id
    `,
  );
  return enrolled.length;
}

/**
 * Settle exact protected operations and recycle terminal operations without
 * ever treating reservation, capture, retry, or deferral as RPO success.
 */
export async function reconcileAgentBackupSchedules(params: {
  limit: number;
  intervalMs?: number;
  rpoMs?: number;
  terminalRetryDelayMs?: number;
}): Promise<AgentBackupScheduleReconcileSummary> {
  const limit = validateBatch(params.limit);
  const { intervalMs, rpoMs } = validateCadence(params);
  const terminalRetryDelayMs = requireBoundedInteger({
    value: params.terminalRetryDelayMs ?? DEFAULT_AGENT_BACKUP_SCHEDULE_RETRY_MS,
    field: "terminalRetryDelayMs",
    min: 1,
    max: MAX_AGENT_BACKUP_SCHEDULE_RETRY_MS,
  });
  const successStates = sql.join(
    PROTECTED_OPERATION_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const recyclableStates = sql.join(
    RECYCLABLE_OPERATION_STATES.map((state) => sql`${state}`),
    sql`, `,
  );

  return dbWrite.transaction(async (tx) => {
    // Active operations remain attached even when a lifecycle change made
    // their source stale. This scheduler has no catalogue cancellation lease;
    // retaining the pointer keeps the organization/node lane fail-closed until
    // durable protection or terminal settlement makes recycling safe.
    const candidates = await sqlRows<{
      id: string;
      organization_id: string;
      operation_id: string;
      activation_generation: string | null;
      activation_lifecycle_revision: string | null;
      lifecycle_revision: string;
      activation_node_id: string | null;
      activation_container_id: string | null;
      activation_image_digest: string | null;
    }>(
      tx,
      sql`
        SELECT sandbox.id, sandbox.organization_id,
          sandbox.backup_schedule_operation_id AS operation_id,
          sandbox.activation_generation,
          sandbox.activation_lifecycle_revision::text AS activation_lifecycle_revision,
          sandbox.lifecycle_revision::text AS lifecycle_revision,
          sandbox.activation_node_id,
          sandbox.activation_container_id,
          sandbox.activation_image_digest
        FROM ${agentSandboxes} AS sandbox
        WHERE sandbox.backup_schedule_operation_id IS NOT NULL
          AND sandbox.backup_schedule_claim_owner IS NULL
          AND EXISTS (
            SELECT 1
            FROM ${agentSandboxBackups} AS backup
            WHERE backup.catalog_organization_id = sandbox.organization_id
              AND backup.catalog_agent_id = sandbox.id
              AND backup.sandbox_record_id = sandbox.id
              AND backup.backup_operation_id = sandbox.backup_schedule_operation_id
              AND (
                backup.catalog_state IN (${successStates}, ${recyclableStates})
                OR backup.catalog_state IS NULL
              )
          )
        ORDER BY sandbox.next_backup_at, sandbox.organization_id, sandbox.id
        FOR UPDATE OF sandbox SKIP LOCKED
        LIMIT ${limit}
      `,
    );
    if (candidates.length === 0) return { protected: 0, recycled: 0 };

    let protectedCount = 0;
    let recycled = 0;
    const [clock] = await sqlRows<{ now: Date | string }>(tx, sql`SELECT NOW() AS now`);
    if (!clock?.now) throw new Error("Primary database clock is unavailable");
    const databaseNow = requireDatabaseDate(clock.now, "databaseNow");
    for (const candidate of candidates) {
      const [backup] = await tx
        .select({
          state: agentSandboxBackups.catalog_state,
          manifestFormat: agentSandboxBackups.manifest_format,
          manifestVersion: agentSandboxBackups.manifest_version,
          manifestDigest: agentSandboxBackups.manifest_digest,
          primaryVerifiedAt: agentSandboxBackups.primary_verified_at,
          secondaryVerifiedAt: agentSandboxBackups.secondary_verified_at,
          lastErrorCode: agentSandboxBackups.catalog_last_error_code,
          lifecycleGeneration: agentSandboxBackups.lifecycle_generation,
          lifecycleRevision: agentSandboxBackups.lifecycle_revision,
          sourceNodeId: agentSandboxBackups.source_node_id,
          sourceContainerId: agentSandboxBackups.source_container_id,
          catalogVersion: agentSandboxBackups.catalog_version,
          snapshotType: agentSandboxBackups.snapshot_type,
          backupKind: agentSandboxBackups.backup_kind,
          retentionReason: agentSandboxBackups.retention_reason,
          imageDigest: agentSandboxBackups.image_digest,
        })
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.catalog_organization_id, candidate.organization_id),
            eq(agentSandboxBackups.catalog_agent_id, candidate.id),
            eq(agentSandboxBackups.sandbox_record_id, candidate.id),
            eq(agentSandboxBackups.backup_operation_id, candidate.operation_id),
          ),
        )
        .for("key share")
        .limit(1);
      if (!backup) continue;

      const reservationMatchesCurrentActivation =
        backup.state !== null &&
        backup.catalogVersion === 2 &&
        backup.snapshotType === "auto" &&
        backup.backupKind === "full" &&
        backup.retentionReason === "schedule" &&
        candidate.activation_generation !== null &&
        backup.lifecycleGeneration === candidate.activation_generation &&
        candidate.activation_lifecycle_revision !== null &&
        backup.lifecycleRevision !== null &&
        String(backup.lifecycleRevision) === candidate.activation_lifecycle_revision &&
        candidate.lifecycle_revision === candidate.activation_lifecycle_revision &&
        candidate.activation_node_id !== null &&
        backup.sourceNodeId === candidate.activation_node_id &&
        candidate.activation_container_id !== null &&
        backup.sourceContainerId === candidate.activation_container_id;

      if (
        reservationMatchesCurrentActivation &&
        PROTECTED_OPERATION_STATES.includes(
          backup.state as (typeof PROTECTED_OPERATION_STATES)[number],
        ) &&
        backup.manifestFormat === "elizaos.agent-backup" &&
        backup.manifestVersion === 3 &&
        typeof backup.manifestDigest === "string" &&
        /^[0-9a-f]{64}$/.test(backup.manifestDigest) &&
        backup.primaryVerifiedAt instanceof Date &&
        backup.secondaryVerifiedAt instanceof Date &&
        candidate.activation_image_digest !== null &&
        backup.imageDigest === candidate.activation_image_digest &&
        backup.secondaryVerifiedAt.getTime() >= backup.primaryVerifiedAt.getTime() &&
        backup.secondaryVerifiedAt.getTime() <= databaseNow.getTime()
      ) {
        const jitterMs = stableScheduleJitterMs(
          candidate.id,
          Math.min(Math.floor(intervalMs / 10), rpoMs - intervalMs),
        );
        const nextDelayMs = intervalMs + jitterMs;
        if (nextDelayMs > rpoMs) {
          throw new Error("Periodic backup jitter exceeds the configured RPO target");
        }
        const [updated] = await tx
          .update(agentSandboxes)
          .set({
            // `secondary_verified_at` is stamped by PostgreSQL when the exact
            // operation becomes protected. Basing the next deadline on that
            // clock prevents a delayed reconciler from silently extending RPO.
            next_backup_at: new Date(backup.secondaryVerifiedAt.getTime() + nextDelayMs),
            backup_schedule_operation_id: null,
            backup_schedule_retry_at: null,
            backup_schedule_claim_owner: null,
            backup_schedule_claim_generation: null,
            backup_schedule_claim_expires_at: null,
            backup_schedule_attempts: 0,
            backup_schedule_last_error_code: null,
            backup_schedule_last_protected_at: backup.secondaryVerifiedAt,
            updated_at: sql`NOW()`,
          })
          .where(
            and(
              eq(agentSandboxes.id, candidate.id),
              eq(agentSandboxes.organization_id, candidate.organization_id),
              eq(agentSandboxes.backup_schedule_operation_id, candidate.operation_id),
            ),
          )
          .returning({ id: agentSandboxes.id });
        if (updated) protectedCount += 1;
        continue;
      }

      const invalidProtectedProof = PROTECTED_OPERATION_STATES.includes(
        backup.state as (typeof PROTECTED_OPERATION_STATES)[number],
      );
      if (
        invalidProtectedProof ||
        !reservationMatchesCurrentActivation ||
        RECYCLABLE_OPERATION_STATES.includes(
          backup.state as (typeof RECYCLABLE_OPERATION_STATES)[number],
        )
      ) {
        const errorCode = invalidProtectedProof
          ? "BACKUP_SCHEDULE_PROTECTION_PROOF_INVALID"
          : !reservationMatchesCurrentActivation
            ? "BACKUP_SCHEDULE_RESERVATION_SUPERSEDED"
            : backup.lastErrorCode && /^[A-Z][A-Z0-9_]{0,95}$/.test(backup.lastErrorCode)
              ? backup.lastErrorCode
              : "BACKUP_OPERATION_NOT_PROTECTED";
        const [updated] = await tx
          .update(agentSandboxes)
          .set({
            backup_schedule_operation_id: null,
            backup_schedule_retry_at: sql`NOW()
              + (${terminalRetryDelayMs} * INTERVAL '1 millisecond')`,
            backup_schedule_claim_owner: null,
            backup_schedule_claim_generation: null,
            backup_schedule_claim_expires_at: null,
            backup_schedule_last_error_code: errorCode,
            updated_at: sql`NOW()`,
          })
          .where(
            and(
              eq(agentSandboxes.id, candidate.id),
              eq(agentSandboxes.organization_id, candidate.organization_id),
              eq(agentSandboxes.backup_schedule_operation_id, candidate.operation_id),
            ),
          )
          .returning({ id: agentSandboxes.id });
        if (updated) recycled += 1;
      }
    }
    return { protected: protectedCount, recycled };
  });
}

/**
 * Claim at most one due sandbox per organization and source node. Organization
 * and node authority rows are locked with SKIP LOCKED, so concurrent workers
 * cannot reserve two fair-lane entries from the same tenant or source node.
 */
export async function claimDueAgentBackupSchedules(params: {
  ownerId: string;
  limit: number;
  leaseMs?: number;
}): Promise<AgentBackupScheduleClaim[]> {
  requireBoundedIdentity(params.ownerId, "ownerId");
  const limit = validateBatch(params.limit);
  const leaseMs = requireBoundedInteger({
    value: params.leaseMs ?? DEFAULT_AGENT_BACKUP_SCHEDULE_LEASE_MS,
    field: "leaseMs",
    min: 1,
    max: MAX_AGENT_BACKUP_SCHEDULE_LEASE_MS,
  });
  const generation = randomUUID();
  const activeStates = sql.join(
    ACTIVE_OPERATION_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const activeLanes = activeBackupLanes(activeStates);
  return dbWrite.transaction(async (tx) => {
    const candidates = await sqlRows<{
      id: string;
      organization_id: string;
      activation_node_id: string;
      activation_generation: string;
      activation_lifecycle_revision: string;
      lifecycle_revision: string;
      activation_container_id: string;
    }>(
      tx,
      sql`
        WITH active_operation_lanes AS MATERIALIZED (${activeLanes}),
        eligible AS MATERIALIZED (
          SELECT
            sandbox.id,
            sandbox.organization_id,
            sandbox.activation_node_id,
            sandbox.activation_generation,
            sandbox.activation_lifecycle_revision,
            sandbox.lifecycle_revision,
            sandbox.activation_container_id,
            sandbox.next_backup_at,
            ROW_NUMBER() OVER (
              PARTITION BY sandbox.organization_id
              ORDER BY sandbox.next_backup_at, sandbox.id
            ) AS organization_rank,
            ROW_NUMBER() OVER (
              PARTITION BY sandbox.activation_node_id
              ORDER BY sandbox.next_backup_at, sandbox.organization_id, sandbox.id
            ) AS node_rank
          FROM ${agentSandboxes} AS sandbox
          WHERE sandbox.next_backup_at IS NOT NULL
            AND sandbox.next_backup_at <= clock_timestamp()
            AND (sandbox.backup_schedule_retry_at IS NULL
              OR sandbox.backup_schedule_retry_at <= clock_timestamp())
            AND sandbox.status = 'running'
            AND sandbox.pool_status IS NULL
            AND sandbox.execution_tier <> 'shared'
            AND sandbox.activation_phase = 'active'
            AND sandbox.activation_generation IS NOT NULL
            AND sandbox.activation_lifecycle_revision IS NOT NULL
            AND sandbox.lifecycle_revision = sandbox.activation_lifecycle_revision
            AND sandbox.activation_receipt_hash IS NOT NULL
            AND sandbox.activation_container_id ~ '^[0-9a-f]{64}$'
            AND sandbox.activation_node_id IS NOT NULL
            AND sandbox.activation_image_digest IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM ${dockerNodes} AS source_node
              WHERE source_node.node_id = sandbox.activation_node_id
                AND source_node.node_incarnation IS NOT NULL
                AND (
                  (source_node.fleet_kind = 'robot'
                    AND source_node.provider_server_id IS NULL)
                  OR (source_node.fleet_kind = 'cloud'
                    AND source_node.provider_server_id IS NOT NULL)
                )
            )
            AND (sandbox.backup_schedule_claim_expires_at IS NULL
              OR sandbox.backup_schedule_claim_expires_at <= clock_timestamp())
            AND (
              sandbox.backup_schedule_operation_id IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM ${agentSandboxBackups} AS reserved_backup
                WHERE reserved_backup.catalog_organization_id = sandbox.organization_id
                  AND reserved_backup.catalog_agent_id = sandbox.id
                  AND reserved_backup.backup_operation_id = sandbox.backup_schedule_operation_id
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM ${agentSandboxes} AS organization_claim
              WHERE organization_claim.id <> sandbox.id
                AND organization_claim.organization_id = sandbox.organization_id
                AND organization_claim.backup_schedule_claim_expires_at > clock_timestamp()
            )
            AND NOT EXISTS (
              SELECT 1
              FROM active_operation_lanes AS organization_backup
              WHERE organization_backup.organization_id = sandbox.organization_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM active_operation_lanes AS node_backup
              WHERE node_backup.node_id = sandbox.activation_node_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM ${agentSandboxes} AS node_claim
              WHERE node_claim.id <> sandbox.id
                AND node_claim.activation_node_id = sandbox.activation_node_id
                AND node_claim.backup_schedule_claim_expires_at > clock_timestamp()
            )
        ), ranked_candidates AS MATERIALIZED (
          SELECT id, organization_id, activation_node_id, activation_generation,
            activation_lifecycle_revision, lifecycle_revision,
            activation_container_id, next_backup_at
          FROM eligible
          WHERE organization_rank = 1
            AND node_rank = 1
        )
        SELECT sandbox.id, candidate.organization_id,
          candidate.activation_node_id, candidate.activation_generation,
          candidate.activation_lifecycle_revision::text AS activation_lifecycle_revision,
          candidate.lifecycle_revision::text AS lifecycle_revision,
          candidate.activation_container_id
        FROM ranked_candidates AS candidate
        JOIN ${agentSandboxes} AS sandbox
          ON sandbox.id = candidate.id
          AND sandbox.organization_id = candidate.organization_id
          AND sandbox.activation_node_id = candidate.activation_node_id
          AND sandbox.activation_generation = candidate.activation_generation
          AND sandbox.activation_lifecycle_revision = candidate.activation_lifecycle_revision
          AND sandbox.lifecycle_revision = candidate.lifecycle_revision
          AND sandbox.activation_container_id = candidate.activation_container_id
        JOIN ${organizations} AS organization_row
          ON organization_row.id = candidate.organization_id
        JOIN ${dockerNodes} AS node_row
          ON node_row.node_id = candidate.activation_node_id
        ORDER BY candidate.next_backup_at, candidate.organization_id, sandbox.id
        FOR UPDATE OF sandbox, organization_row, node_row SKIP LOCKED
        LIMIT ${limit}
      `,
    );
    if (candidates.length === 0) return [];

    // The locking statement and mutation are deliberately separate. Under
    // READ COMMITTED this second statement receives a fresh snapshot after all
    // organization/node locks were acquired. A concurrent claimer that
    // committed while this transaction was selecting can therefore never slip
    // through on the selection statement's stale snapshot.
    const lockedCandidates = sql.join(
      candidates.map(
        (candidate) => sql`(
          ${candidate.id}::uuid,
          ${candidate.organization_id}::uuid,
          ${candidate.activation_node_id}::text,
          ${candidate.activation_generation}::uuid,
          ${candidate.activation_lifecycle_revision}::bigint,
          ${candidate.lifecycle_revision}::bigint,
          ${candidate.activation_container_id}::text
        )`,
      ),
      sql`, `,
    );
    const claimed = await sqlRows<{
      organization_id: string;
      id: string;
      operation_id: string;
      expires_at: Date | string;
      next_backup_at: Date | string;
      attempts: number;
    }>(
      tx,
      sql`
        WITH active_operation_lanes AS MATERIALIZED (${activeLanes}),
        locked_candidates (
          id,
          organization_id,
          activation_node_id,
          activation_generation,
          activation_lifecycle_revision,
          lifecycle_revision,
          activation_container_id
        ) AS (VALUES ${lockedCandidates})
        UPDATE ${agentSandboxes} AS sandbox
        SET backup_schedule_operation_id = COALESCE(
              sandbox.backup_schedule_operation_id,
              gen_random_uuid()
            ),
            backup_schedule_retry_at = NULL,
            backup_schedule_claim_owner = ${params.ownerId},
            backup_schedule_claim_generation = ${generation},
            backup_schedule_claim_expires_at = clock_timestamp()
              + (${leaseMs} * INTERVAL '1 millisecond'),
            backup_schedule_attempts = sandbox.backup_schedule_attempts + 1,
            backup_schedule_last_error_code = NULL,
            updated_at = NOW()
        FROM locked_candidates AS candidate
        WHERE sandbox.id = candidate.id
          AND sandbox.organization_id = candidate.organization_id
          AND sandbox.activation_node_id = candidate.activation_node_id
          AND sandbox.activation_generation = candidate.activation_generation
          AND sandbox.activation_lifecycle_revision = candidate.activation_lifecycle_revision
          AND sandbox.lifecycle_revision = candidate.lifecycle_revision
          AND sandbox.activation_container_id = candidate.activation_container_id
          AND sandbox.next_backup_at IS NOT NULL
          AND sandbox.next_backup_at <= clock_timestamp()
          AND (sandbox.backup_schedule_retry_at IS NULL
            OR sandbox.backup_schedule_retry_at <= clock_timestamp())
          AND sandbox.status = 'running'
          AND sandbox.pool_status IS NULL
          AND sandbox.execution_tier <> 'shared'
          AND sandbox.activation_phase = 'active'
          AND sandbox.activation_generation IS NOT NULL
          AND sandbox.activation_lifecycle_revision IS NOT NULL
          AND sandbox.lifecycle_revision = sandbox.activation_lifecycle_revision
          AND sandbox.activation_receipt_hash IS NOT NULL
          AND sandbox.activation_container_id ~ '^[0-9a-f]{64}$'
          AND sandbox.activation_node_id IS NOT NULL
          AND sandbox.activation_image_digest IS NOT NULL
          AND sandbox.activation_authority_published_at IS NOT NULL
          AND sandbox.activation_dispatched_at IS NOT NULL
          AND sandbox.activation_completed_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM ${dockerNodes} AS source_node
            WHERE source_node.node_id = sandbox.activation_node_id
              AND source_node.node_incarnation IS NOT NULL
              AND (
                (source_node.fleet_kind = 'robot'
                  AND source_node.provider_server_id IS NULL)
                OR (source_node.fleet_kind = 'cloud'
                  AND source_node.provider_server_id IS NOT NULL)
              )
          )
          AND (sandbox.backup_schedule_claim_expires_at IS NULL
            OR sandbox.backup_schedule_claim_expires_at <= clock_timestamp())
          AND (
            sandbox.backup_schedule_operation_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM ${agentSandboxBackups} AS reserved_backup
              WHERE reserved_backup.catalog_organization_id = sandbox.organization_id
                AND reserved_backup.catalog_agent_id = sandbox.id
                AND reserved_backup.backup_operation_id = sandbox.backup_schedule_operation_id
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentSandboxes} AS organization_claim
            WHERE organization_claim.id <> sandbox.id
              AND organization_claim.organization_id = sandbox.organization_id
              AND organization_claim.backup_schedule_claim_expires_at > clock_timestamp()
          )
          AND NOT EXISTS (
            SELECT 1
            FROM active_operation_lanes AS organization_backup
            WHERE organization_backup.organization_id = sandbox.organization_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM active_operation_lanes AS node_backup
            WHERE node_backup.node_id = sandbox.activation_node_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentSandboxes} AS node_claim
            WHERE node_claim.id <> sandbox.id
              AND node_claim.activation_node_id = sandbox.activation_node_id
              AND node_claim.backup_schedule_claim_expires_at > clock_timestamp()
          )
        RETURNING sandbox.organization_id, sandbox.id,
          sandbox.backup_schedule_operation_id AS operation_id,
          sandbox.backup_schedule_claim_expires_at AS expires_at,
          sandbox.next_backup_at,
          sandbox.backup_schedule_attempts AS attempts
      `,
    );
    return claimed
      .map((row) => ({
        organizationId: row.organization_id,
        agentId: row.id,
        operationId: row.operation_id,
        ownerId: params.ownerId,
        generation,
        expiresAt: requireDatabaseDate(row.expires_at, "claim.expiresAt"),
        dueAt: requireDatabaseDate(row.next_backup_at, "claim.dueAt"),
        attempts: row.attempts,
      }))
      .sort(
        (left, right) =>
          left.dueAt.getTime() - right.dueAt.getTime() ||
          left.organizationId.localeCompare(right.organizationId) ||
          left.agentId.localeCompare(right.agentId),
      );
  });
}

async function lockClaimedSandbox(
  tx: DbTransaction,
  claim: AgentBackupScheduleClaim,
): Promise<{
  organizationId: string;
  agentId: string;
  dueAt: Date;
  activationGeneration: string;
  lifecycleRevision: string;
  nodeId: string;
  providerHandle: string;
  containerId: string;
}> {
  const [sandbox] = await tx
    .select({
      organizationId: agentSandboxes.organization_id,
      agentId: agentSandboxes.id,
      dueAt: agentSandboxes.next_backup_at,
      status: agentSandboxes.status,
      poolStatus: agentSandboxes.pool_status,
      executionTier: agentSandboxes.execution_tier,
      activationPhase: agentSandboxes.activation_phase,
      activationGeneration: agentSandboxes.activation_generation,
      lifecycleRevision: sql<string>`${agentSandboxes.lifecycle_revision}::text`,
      activationLifecycleRevision: sql<
        string | null
      >`${agentSandboxes.activation_lifecycle_revision}::text`,
      nodeId: agentSandboxes.activation_node_id,
      providerHandle: agentSandboxes.sandbox_id,
      containerId: agentSandboxes.activation_container_id,
      claimOwner: agentSandboxes.backup_schedule_claim_owner,
      claimGeneration: agentSandboxes.backup_schedule_claim_generation,
      claimExpiresAt: agentSandboxes.backup_schedule_claim_expires_at,
      operationId: agentSandboxes.backup_schedule_operation_id,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, claim.agentId),
        eq(agentSandboxes.organization_id, claim.organizationId),
        eq(agentSandboxes.backup_schedule_claim_owner, claim.ownerId),
        eq(agentSandboxes.backup_schedule_claim_generation, claim.generation),
        eq(agentSandboxes.backup_schedule_operation_id, claim.operationId),
        gt(agentSandboxes.backup_schedule_claim_expires_at, sql`clock_timestamp()`),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !sandbox ||
    sandbox.claimOwner !== claim.ownerId ||
    sandbox.claimGeneration !== claim.generation ||
    sandbox.operationId !== claim.operationId ||
    !(sandbox.claimExpiresAt instanceof Date) ||
    !(sandbox.dueAt instanceof Date)
  ) {
    throw new AgentBackupScheduleFenceError("Periodic backup scheduler lease is stale");
  }
  if (
    sandbox.status !== "running" ||
    sandbox.poolStatus !== null ||
    sandbox.executionTier === "shared" ||
    sandbox.activationPhase !== "active" ||
    !sandbox.activationGeneration ||
    sandbox.lifecycleRevision === null ||
    sandbox.lifecycleRevision !== sandbox.activationLifecycleRevision ||
    !sandbox.nodeId ||
    !sandbox.providerHandle ||
    !sandbox.containerId
  ) {
    throw new AgentBackupScheduleFenceError(
      "Periodic backup source is no longer one exact active dedicated sandbox",
    );
  }
  return {
    organizationId: sandbox.organizationId,
    agentId: sandbox.agentId,
    dueAt: sandbox.dueAt,
    activationGeneration: sandbox.activationGeneration,
    lifecycleRevision: sandbox.activationLifecycleRevision,
    nodeId: sandbox.nodeId,
    providerHandle: sandbox.providerHandle,
    containerId: sandbox.containerId,
  };
}

/**
 * Convert one scheduler lease into one catalogue-v3 full-backup operation.
 * The deadline and operation id stay attached until protection reconciliation.
 */
export async function reserveClaimedAgentBackupSchedule(params: {
  claim: AgentBackupScheduleClaim;
  retentionMs?: number;
}): Promise<AgentBackupScheduleReservation> {
  const claim = params.claim;
  validateClaimIdentity(claim);
  const retentionMs = requireBoundedInteger({
    value: params.retentionMs ?? DEFAULT_AGENT_BACKUP_SCHEDULE_RETENTION_MS,
    field: "retentionMs",
    min: 24 * 60 * 60_000,
    max: 365 * 24 * 60 * 60_000,
  });
  return dbWrite.transaction(async (tx) => {
    await lockAgentBackupReservationReplayInTransaction(tx, claim);
    const source = await lockClaimedSandbox(tx, claim);
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, source.organizationId))
      .for("update")
      .limit(1);
    if (!organization) {
      throw new AgentBackupScheduleFenceError("Periodic backup organization authority disappeared");
    }
    const [node] = await tx
      .select({
        recordId: dockerNodes.id,
        nodeId: dockerNodes.node_id,
        fleetKind: dockerNodes.fleet_kind,
        providerServerId: dockerNodes.provider_server_id,
        incarnation: dockerNodes.node_incarnation,
      })
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, source.nodeId))
      .for("update")
      .limit(1);
    if (
      !node ||
      !node.incarnation ||
      (node.fleetKind !== "robot" && node.fleetKind !== "cloud") ||
      (node.fleetKind === "robot" && node.providerServerId !== null) ||
      (node.fleetKind === "cloud" && node.providerServerId === null)
    ) {
      throw new AgentBackupScheduleFenceError(
        "Periodic backup source node lacks exact Robot/Cloud incarnation authority",
      );
    }
    const activeStates = sql.join(
      ACTIVE_OPERATION_STATES.map((state) => sql`${state}`),
      sql`, `,
    );
    const activeLanes = activeBackupLanes(activeStates);
    const [conflicts] = await sqlRows<{
      organization_claim: boolean;
      organization_backup: boolean;
      node_claim: boolean;
      node_backup: boolean;
    }>(
      tx,
      sql`
        WITH active_operation_lanes AS MATERIALIZED (${activeLanes})
        SELECT
          EXISTS (
            SELECT 1 FROM ${agentSandboxes} AS other_claim
            WHERE other_claim.id <> ${source.agentId}
              AND other_claim.organization_id = ${source.organizationId}
              AND other_claim.backup_schedule_claim_expires_at > clock_timestamp()
          ) AS organization_claim,
          EXISTS (
            SELECT 1 FROM active_operation_lanes AS other_backup
            WHERE other_backup.organization_id = ${source.organizationId}
          ) AS organization_backup,
          EXISTS (
            SELECT 1 FROM ${agentSandboxes} AS other_claim
            WHERE other_claim.id <> ${source.agentId}
              AND other_claim.activation_node_id = ${source.nodeId}
              AND other_claim.backup_schedule_claim_expires_at > clock_timestamp()
          ) AS node_claim,
          EXISTS (
            SELECT 1 FROM active_operation_lanes AS other_backup
            WHERE other_backup.node_id = ${source.nodeId}
          ) AS node_backup
      `,
    );
    if (
      !conflicts ||
      conflicts.organization_claim ||
      conflicts.organization_backup ||
      conflicts.node_claim ||
      conflicts.node_backup
    ) {
      throw new AgentBackupScheduleFenceError("Periodic backup fair-lane authority was superseded");
    }
    const [clock] = await sqlRows<{ now: Date | string }>(tx, sql`SELECT NOW() AS now`);
    if (!clock?.now) throw new Error("Primary database clock is unavailable");
    const databaseNow = clock.now instanceof Date ? clock.now : new Date(clock.now);
    if (!Number.isFinite(databaseNow.getTime())) {
      throw new Error("Primary database clock returned an invalid timestamp");
    }
    const backup = await reserveAgentBackupOperationInTransaction(tx, {
      organizationId: source.organizationId,
      agentId: source.agentId,
      sandboxRecordId: source.agentId,
      operationId: claim.operationId,
      activationGeneration: source.activationGeneration,
      lifecycleRevision: source.lifecycleRevision,
      snapshotType: "auto",
      backupKind: "full",
      sourceProvider: node.fleetKind === "robot" ? "operator-onboarded" : "hetzner-cloud",
      sourceNodeRecordId: node.recordId,
      sourceNodeId: node.nodeId,
      sourceNodeIncarnation: node.incarnation,
      sourceProviderServerId: node.providerServerId,
      sourceProviderHandle: source.providerHandle,
      sourceContainerId: source.containerId,
      retentionReason: "schedule",
      retentionUntil: new Date(databaseNow.getTime() + retentionMs),
    });
    const [updated] = await tx
      .update(agentSandboxes)
      .set({
        backup_schedule_retry_at: null,
        backup_schedule_claim_owner: null,
        backup_schedule_claim_generation: null,
        backup_schedule_claim_expires_at: null,
        backup_schedule_last_error_code: null,
        updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentSandboxes.id, claim.agentId),
          eq(agentSandboxes.organization_id, claim.organizationId),
          eq(agentSandboxes.backup_schedule_claim_owner, claim.ownerId),
          eq(agentSandboxes.backup_schedule_claim_generation, claim.generation),
          eq(agentSandboxes.backup_schedule_operation_id, claim.operationId),
          gt(agentSandboxes.backup_schedule_claim_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({ dueAt: agentSandboxes.next_backup_at });
    if (!(updated?.dueAt instanceof Date)) {
      throw new AgentBackupScheduleFenceError(
        "Periodic backup reservation lost its scheduler lease CAS",
      );
    }
    return {
      organizationId: source.organizationId,
      agentId: source.agentId,
      operationId: claim.operationId,
      backupId: backup.id,
      dueAt: updated.dueAt,
    };
  });
}

/**
 * Release an unconverted claim with separate DB-clock backpressure. The RPO
 * deadline and retry-stable operation id remain unchanged.
 */
export async function deferClaimedAgentBackupSchedule(params: {
  claim: AgentBackupScheduleClaim;
  retryDelayMs: number;
  errorCode: string;
}): Promise<boolean> {
  validateClaimIdentity(params.claim);
  const retryDelayMs = requireBoundedInteger({
    value: params.retryDelayMs,
    field: "retryDelayMs",
    min: 1,
    max: MAX_AGENT_BACKUP_SCHEDULE_RETRY_MS,
  });
  const errorCode = requireScheduleErrorCode(params.errorCode);
  const [updated] = await dbWrite
    .update(agentSandboxes)
    .set({
      backup_schedule_retry_at: sql`clock_timestamp()
        + (${retryDelayMs} * INTERVAL '1 millisecond')`,
      backup_schedule_claim_owner: null,
      backup_schedule_claim_generation: null,
      backup_schedule_claim_expires_at: null,
      backup_schedule_last_error_code: errorCode,
      updated_at: sql`NOW()`,
    })
    .where(
      and(
        eq(agentSandboxes.id, params.claim.agentId),
        eq(agentSandboxes.organization_id, params.claim.organizationId),
        eq(agentSandboxes.backup_schedule_claim_owner, params.claim.ownerId),
        eq(agentSandboxes.backup_schedule_claim_generation, params.claim.generation),
        eq(agentSandboxes.backup_schedule_operation_id, params.claim.operationId),
        gt(agentSandboxes.backup_schedule_claim_expires_at, sql`clock_timestamp()`),
      ),
    )
    .returning({ id: agentSandboxes.id });
  return Boolean(updated);
}
