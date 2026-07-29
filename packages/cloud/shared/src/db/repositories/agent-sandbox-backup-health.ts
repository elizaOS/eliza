/**
 * Transactional scheduling and health persistence for managed agent backups.
 *
 * The cron selector reserves due agents under row locks before it enqueues any
 * work, while the daemon records image-fenced attempt outcomes. This keeps a
 * capped fleet sweep fair across overlapping crons and worker crashes without
 * ever advancing the success-only `agent_sandboxes.last_backup_at` clock.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite, writeTransaction } from "../helpers";
import { agentBackupFleetHealthState } from "../schemas/agent-backup-fleet-health-state";
import {
  type AgentSandboxBackupCapability,
  type AgentSandboxBackupOutcome,
  agentSandboxBackupHealth,
} from "../schemas/agent-sandbox-backup-health";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { jobs } from "../schemas/jobs";

export const BACKUP_UNREACHABLE_BRIDGE_SENTINEL = "http://127.0.0.1:65535";
export const BACKUP_HEALTH_ERROR_MAX_CHARS = 1024;
export const DEFAULT_BACKUP_SWEEP_LEASE_MS = 5 * 60_000;
export const DEFAULT_BACKUP_ATTEMPT_LEASE_MS = 10 * 60_000;
export const DEFAULT_BACKUP_RETRY_BASE_MS = 5 * 60_000;
export const DEFAULT_BACKUP_RETRY_MAX_MS = 6 * 60 * 60_000;
export const DEFAULT_BACKUP_UNAVAILABLE_RETRY_MS = 15 * 60_000;

const MAX_FAILURE_BACKOFF_EXPONENT = 6;

type DatabaseDate = Date | string;
type DatabaseNumber = number | string;

interface BackupSweepMetricRow {
  due_total: DatabaseNumber;
  oldest_due_at: DatabaseDate | null;
  active_total: DatabaseNumber;
  unsupported_total: DatabaseNumber;
  active_unsupported_total: DatabaseNumber;
}

interface DatabaseClockRow {
  now: DatabaseDate;
}

interface ReservedBackupRow {
  id: string;
  organization_id: string;
  user_id: string;
  image_identity: string | null;
}

interface FleetAggregateRow {
  total: DatabaseNumber;
  absent: DatabaseNumber;
  stale: DatabaseNumber;
  unsupported: DatabaseNumber;
  unreachable: DatabaseNumber;
  repeated_failures: DatabaseNumber;
  image_refresh_required: DatabaseNumber;
  backlog: DatabaseNumber;
  oldest_backup_at: DatabaseDate | null;
}

interface FleetProblemRow {
  id: string;
  organization_id: string;
  agent_name: string | null;
  last_backup_at: DatabaseDate | null;
  created_at: DatabaseDate;
  bridge_url: string | null;
  image_identity: string | null;
  image_digest: string | null;
  capability: AgentSandboxBackupCapability;
  backup_required: boolean;
  consecutive_failures: number;
  last_error: string | null;
  alert_fingerprint: string | null;
}

export interface BackupSweepCandidate {
  id: string;
  organizationId: string;
  userId: string;
  imageIdentity: string | null;
  leaseToken: string;
}

export interface BackupSweepReservation {
  asOf: Date;
  dueTotal: number;
  oldestDueAt: Date | null;
  activeTotal: number;
  unsupportedTotal: number;
  /** Intersection used to keep the public scheduler categories truthful. */
  activeUnsupportedTotal: number;
  candidates: BackupSweepCandidate[];
}

export interface BackupAttemptContext {
  sandboxRecordId: string;
  attemptToken: string;
  jobId: string;
  jobStartedAt: Date;
  imageIdentity: string | null;
}

export type CompletedBackupAttemptOutcome =
  | "success"
  | "unsupported"
  | "unavailable"
  | "failed"
  | "generation_changed";

export interface BackupAttemptWriteResult {
  recorded: boolean;
  imageChanged: boolean;
}

export interface BackupFleetProblem {
  id: string;
  organizationId: string;
  agentName: string | null;
  lastBackupAt: Date | null;
  createdAt: Date;
  bridgeUrl: string | null;
  imageIdentity: string | null;
  imageDigest: string | null;
  capability: AgentSandboxBackupCapability;
  backupRequired: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  alertFingerprint: string | null;
}

export interface BackupFleetSnapshot {
  asOf: Date;
  total: number;
  absent: number;
  stale: number;
  unsupported: number;
  unreachable: number;
  repeatedFailures: number;
  imageRefreshRequired: number;
  backlog: number;
  oldestBackupAt: Date | null;
  problems: BackupFleetProblem[];
}

function requirePositiveInteger(value: number, field: string, max: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ElizaError(`${field} must be a positive integer no greater than ${max}`, {
      code: "AGENT_BACKUP_HEALTH_INVALID_ARGUMENT",
      context: { field, value, max },
    });
  }
}

function databaseNumber(value: DatabaseNumber, field: string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ElizaError(`Invalid ${field} returned by the backup-health query`, {
      code: "AGENT_BACKUP_HEALTH_INVALID_DB_RESULT",
      context: { field, value },
    });
  }
  return parsed;
}

function databaseDate(value: DatabaseDate | null, field: string): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ElizaError(`Invalid ${field} returned by the backup-health query`, {
      code: "AGENT_BACKUP_HEALTH_INVALID_DB_RESULT",
      context: { field, value: String(value) },
    });
  }
  return parsed;
}

function requiredDatabaseDate(value: DatabaseDate, field: string): Date {
  const parsed = databaseDate(value, field);
  if (parsed === null) {
    throw new ElizaError(`Null ${field} returned by the backup-health query`, {
      code: "AGENT_BACKUP_HEALTH_INVALID_DB_RESULT",
      context: { field },
    });
  }
  return parsed;
}

async function readDatabaseClock(tx: DbTransaction): Promise<Date> {
  const [clock] = await sqlRows<DatabaseClockRow>(tx, sql`SELECT clock_timestamp() AS now`);
  if (!clock) {
    throw new ElizaError("Backup-health database clock query returned no row", {
      code: "AGENT_BACKUP_HEALTH_MISSING_DB_CLOCK",
    });
  }
  return requiredDatabaseDate(clock.now, "database_clock");
}

function boundedError(error: string): string {
  const normalized = error.trim();
  if (normalized.length === 0) {
    throw new ElizaError("Backup-health failures require a non-empty error", {
      code: "AGENT_BACKUP_HEALTH_EMPTY_ERROR",
    });
  }
  return normalized.slice(0, BACKUP_HEALTH_ERROR_MAX_CHARS);
}

function retryAt(now: Date, consecutiveFailures: number): Date {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), MAX_FAILURE_BACKOFF_EXPONENT);
  const delayMs = Math.min(
    DEFAULT_BACKUP_RETRY_BASE_MS * 2 ** exponent,
    DEFAULT_BACKUP_RETRY_MAX_MS,
  );
  return new Date(now.getTime() + delayMs);
}

function isImageChange(previous: string | null, current: string | null): boolean {
  return previous !== current;
}

function localStateFleetPredicate() {
  return sql`
    ${agentSandboxes.status} = 'running'
    AND ${agentSandboxes.pool_status} IS NULL
    AND ${agentSandboxes.execution_tier} <> 'shared'
    AND COALESCE(
      ${agentSandboxes.environment_vars}->>'ELIZA_AGENT_LOCAL_STATE',
      '1'
    ) <> '0'
  `;
}

async function syncFleetRows(tx: DbTransaction, now: Date): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ${agentSandboxBackupHealth} (
      sandbox_record_id,
      image_identity,
      capability,
      last_success_at,
      created_at,
      updated_at
    )
    SELECT
      ${agentSandboxes.id},
      ${agentSandboxes.image_digest},
      'unknown',
      ${agentSandboxes.last_backup_at},
      ${now},
      ${now}
    FROM ${agentSandboxes}
    WHERE ${localStateFleetPredicate()}
    ON CONFLICT (sandbox_record_id) DO UPDATE
    SET
      image_identity = EXCLUDED.image_identity,
      capability = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN 'unknown'
        WHEN EXCLUDED.last_success_at IS NOT NULL
          AND (
            ${agentSandboxBackupHealth.last_success_at} IS NULL
            OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
          )
        THEN CASE WHEN EXCLUDED.image_identity IS NULL THEN 'unknown' ELSE 'supported' END
        ELSE ${agentSandboxBackupHealth.capability}
      END,
      last_attempt_started_at = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.last_attempt_started_at}
      END,
      last_attempt_completed_at = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.last_attempt_completed_at}
      END,
      last_success_at = CASE
        WHEN EXCLUDED.last_success_at IS NULL
        THEN ${agentSandboxBackupHealth.last_success_at}
        WHEN ${agentSandboxBackupHealth.last_success_at} IS NULL
          OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
        THEN EXCLUDED.last_success_at
        ELSE ${agentSandboxBackupHealth.last_success_at}
      END,
      last_outcome = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN 'image_changed'
        WHEN EXCLUDED.last_success_at IS NOT NULL
          AND (
            ${agentSandboxBackupHealth.last_success_at} IS NULL
            OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
          )
        THEN 'success'
        ELSE ${agentSandboxBackupHealth.last_outcome}
      END,
      attempt_token = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.attempt_token}
      END,
      attempt_job_id = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.attempt_job_id}
      END,
      attempt_job_started_at = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.attempt_job_started_at}
      END,
      lease_token = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.lease_token}
      END,
      lease_expires_at = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN NULL
        ELSE ${agentSandboxBackupHealth.lease_expires_at}
      END,
      backup_required = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
        THEN TRUE
        WHEN EXCLUDED.last_success_at IS NOT NULL
          AND (
            ${agentSandboxBackupHealth.last_success_at} IS NULL
            OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
          )
        THEN FALSE
        ELSE ${agentSandboxBackupHealth.backup_required}
      END,
      next_attempt_at = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
          OR (
            EXCLUDED.last_success_at IS NOT NULL
            AND (
              ${agentSandboxBackupHealth.last_success_at} IS NULL
              OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
            )
          )
        THEN NULL
        ELSE ${agentSandboxBackupHealth.next_attempt_at}
      END,
      consecutive_failures = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
          OR (
            EXCLUDED.last_success_at IS NOT NULL
            AND (
              ${agentSandboxBackupHealth.last_success_at} IS NULL
              OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
            )
          )
        THEN 0
        ELSE ${agentSandboxBackupHealth.consecutive_failures}
      END,
      last_error = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
          OR (
            EXCLUDED.last_success_at IS NOT NULL
            AND (
              ${agentSandboxBackupHealth.last_success_at} IS NULL
              OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
            )
          )
        THEN NULL
        ELSE ${agentSandboxBackupHealth.last_error}
      END,
      alert_fingerprint = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
          OR (
            EXCLUDED.last_success_at IS NOT NULL
            AND (
              ${agentSandboxBackupHealth.last_success_at} IS NULL
              OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
            )
          )
        THEN NULL
        ELSE ${agentSandboxBackupHealth.alert_fingerprint}
      END,
      last_alerted_at = CASE
        WHEN ${agentSandboxBackupHealth.image_identity}
          IS DISTINCT FROM EXCLUDED.image_identity
          OR (
            EXCLUDED.last_success_at IS NOT NULL
            AND (
              ${agentSandboxBackupHealth.last_success_at} IS NULL
              OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
            )
          )
        THEN NULL
        ELSE ${agentSandboxBackupHealth.last_alerted_at}
      END,
      updated_at = EXCLUDED.updated_at
    WHERE
      ${agentSandboxBackupHealth.image_identity}
        IS DISTINCT FROM EXCLUDED.image_identity
      OR (
        EXCLUDED.last_success_at IS NOT NULL
        AND (
          ${agentSandboxBackupHealth.last_success_at} IS NULL
          OR EXCLUDED.last_success_at > ${agentSandboxBackupHealth.last_success_at}
        )
      )
  `);
}

export class AgentSandboxBackupHealthRepository {
  /**
   * Synchronize image identities, measure the complete due population, and
   * reserve a bounded fair slice in one transaction. Enqueueing stays outside
   * the DB transaction because payload offload and logging may perform network
   * I/O; the expiring lease makes a crash between reserve and enqueue recoverable.
   */
  async reserveDueBackups(params: {
    minIntervalMs: number;
    maxAgents: number;
    leaseDurationMs?: number;
  }): Promise<BackupSweepReservation> {
    requirePositiveInteger(params.minIntervalMs, "minIntervalMs", 30 * 24 * 60 * 60_000);
    requirePositiveInteger(params.maxAgents, "maxAgents", 1_000);
    const leaseDurationMs = params.leaseDurationMs ?? DEFAULT_BACKUP_SWEEP_LEASE_MS;
    requirePositiveInteger(leaseDurationMs, "leaseDurationMs", 60 * 60_000);

    const leaseToken = randomUUID();

    return writeTransaction(async (tx) => {
      const now = await readDatabaseClock(tx);
      const cutoff = new Date(now.getTime() - params.minIntervalMs);
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
      await syncFleetRows(tx, now);

      const [metric] = await sqlRows<BackupSweepMetricRow>(
        tx,
        sql`
          WITH due AS (
            SELECT
              ${agentSandboxes.id},
              ${agentSandboxes.last_backup_at},
              ${agentSandboxes.created_at},
              ${agentSandboxes.image_digest},
              ${agentSandboxBackupHealth.image_identity},
              ${agentSandboxBackupHealth.capability},
              CASE
                WHEN ${agentSandboxBackupHealth.backup_required}
                THEN ${agentSandboxBackupHealth.updated_at}
                ELSE COALESCE(
                  ${agentSandboxes.last_backup_at},
                  ${agentSandboxes.created_at}
                )
              END AS due_reference_at
            FROM ${agentSandboxes}
            JOIN ${agentSandboxBackupHealth}
              ON ${agentSandboxBackupHealth.sandbox_record_id} = ${agentSandboxes.id}
            WHERE ${localStateFleetPredicate()}
              AND (
                ${agentSandboxBackupHealth.backup_required}
                OR ${agentSandboxes.last_backup_at} IS NULL
                OR ${agentSandboxes.last_backup_at} < ${cutoff}
              )
          )
          SELECT
            COUNT(*)::int AS due_total,
            MIN(due.due_reference_at) AS oldest_due_at,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM ${jobs}
                WHERE ${jobs.agent_id} = due.id::text
                  AND ${jobs.type} = 'agent_snapshot'
                  AND ${jobs.status} IN ('pending', 'in_progress')
                  AND ${jobs.data}->>'snapshotType' = 'auto'
              )
            )::int AS active_total,
            COUNT(*) FILTER (
              WHERE due.capability = 'unsupported'
                AND due.image_digest IS NOT NULL
                AND due.image_identity = due.image_digest
            )::int AS unsupported_total,
            COUNT(*) FILTER (
              WHERE due.capability = 'unsupported'
                AND due.image_digest IS NOT NULL
                AND due.image_identity = due.image_digest
                AND EXISTS (
                  SELECT 1
                  FROM ${jobs}
                  WHERE ${jobs.agent_id} = due.id::text
                    AND ${jobs.type} = 'agent_snapshot'
                    AND ${jobs.status} IN ('pending', 'in_progress')
                    AND ${jobs.data}->>'snapshotType' = 'auto'
                )
            )::int AS active_unsupported_total
          FROM due
        `,
      );
      if (!metric) {
        throw new ElizaError("Backup sweep metrics query returned no row", {
          code: "AGENT_BACKUP_HEALTH_MISSING_METRICS",
        });
      }

      const reserved = await sqlRows<ReservedBackupRow>(
        tx,
        sql`
          WITH candidates AS (
            SELECT ${agentSandboxBackupHealth.sandbox_record_id}
            FROM ${agentSandboxBackupHealth}
            JOIN ${agentSandboxes}
              ON ${agentSandboxes.id} = ${agentSandboxBackupHealth.sandbox_record_id}
            WHERE ${localStateFleetPredicate()}
              AND (
                ${agentSandboxBackupHealth.backup_required}
                OR ${agentSandboxes.last_backup_at} IS NULL
                OR ${agentSandboxes.last_backup_at} < ${cutoff}
              )
              AND ${agentSandboxes.bridge_url} IS NOT NULL
              AND ${agentSandboxes.bridge_url} <> ${BACKUP_UNREACHABLE_BRIDGE_SENTINEL}
              AND (
                ${agentSandboxBackupHealth.next_attempt_at} IS NULL
                OR ${agentSandboxBackupHealth.next_attempt_at} <= ${now}
              )
              AND (
                ${agentSandboxBackupHealth.lease_expires_at} IS NULL
                OR ${agentSandboxBackupHealth.lease_expires_at} <= ${now}
              )
              AND NOT (
                ${agentSandboxBackupHealth.capability} = 'unsupported'
                AND ${agentSandboxes.image_digest} IS NOT NULL
                AND ${agentSandboxBackupHealth.image_identity} = ${agentSandboxes.image_digest}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM ${jobs}
                WHERE ${jobs.agent_id} = ${agentSandboxes.id}::text
                  AND ${jobs.type} = 'agent_snapshot'
                  AND ${jobs.status} IN ('pending', 'in_progress')
                  AND ${jobs.data}->>'snapshotType' = 'auto'
              )
            ORDER BY
              CASE
                WHEN ${agentSandboxBackupHealth.backup_required}
                THEN ${agentSandboxBackupHealth.updated_at}
                ELSE COALESCE(
                  ${agentSandboxes.last_backup_at},
                  ${agentSandboxes.created_at}
                )
              END ASC,
              ${agentSandboxBackupHealth.last_attempt_started_at} ASC NULLS FIRST,
              ${agentSandboxes.id} ASC
            FOR UPDATE OF ${agentSandboxBackupHealth} SKIP LOCKED
            LIMIT ${params.maxAgents}
          ),
          reserved AS (
            UPDATE ${agentSandboxBackupHealth}
            SET
              lease_token = ${leaseToken},
              lease_expires_at = ${leaseExpiresAt},
              updated_at = ${now}
            FROM candidates
            WHERE ${agentSandboxBackupHealth.sandbox_record_id}
              = candidates.sandbox_record_id
            RETURNING ${agentSandboxBackupHealth.sandbox_record_id}
          )
          SELECT
            ${agentSandboxes.id},
            ${agentSandboxes.organization_id},
            ${agentSandboxes.user_id},
            ${agentSandboxBackupHealth.image_identity}
          FROM reserved
          JOIN ${agentSandboxes}
            ON ${agentSandboxes.id} = reserved.sandbox_record_id
          JOIN ${agentSandboxBackupHealth}
            ON ${agentSandboxBackupHealth.sandbox_record_id} = reserved.sandbox_record_id
          ORDER BY
            CASE
              WHEN ${agentSandboxBackupHealth.backup_required}
              THEN ${agentSandboxBackupHealth.updated_at}
              ELSE COALESCE(
                ${agentSandboxes.last_backup_at},
                ${agentSandboxes.created_at}
              )
            END ASC,
            ${agentSandboxBackupHealth.last_attempt_started_at} ASC NULLS FIRST,
            ${agentSandboxes.id} ASC
        `,
      );

      return {
        asOf: now,
        dueTotal: databaseNumber(metric.due_total, "due_total"),
        oldestDueAt: databaseDate(metric.oldest_due_at, "oldest_due_at"),
        activeTotal: databaseNumber(metric.active_total, "active_total"),
        unsupportedTotal: databaseNumber(metric.unsupported_total, "unsupported_total"),
        activeUnsupportedTotal: databaseNumber(
          metric.active_unsupported_total,
          "active_unsupported_total",
        ),
        candidates: reserved.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          userId: row.user_id,
          imageIdentity: row.image_identity,
          leaseToken,
        })),
      };
    });
  }

  async releaseReservation(sandboxRecordId: string, leaseToken: string): Promise<boolean> {
    const released = await dbWrite
      .update(agentSandboxBackupHealth)
      .set({
        lease_token: null,
        lease_expires_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentSandboxBackupHealth.sandbox_record_id, sandboxRecordId),
          eq(agentSandboxBackupHealth.lease_token, leaseToken),
        ),
      )
      .returning({ id: agentSandboxBackupHealth.sandbox_record_id });
    return released.length === 1;
  }

  async recordEnqueueFailure(params: {
    sandboxRecordId: string;
    leaseToken: string;
    error: string;
  }): Promise<boolean> {
    const error = boundedError(params.error);
    return writeTransaction(async (tx) => {
      const now = await readDatabaseClock(tx);
      const [health] = await tx
        .select()
        .from(agentSandboxBackupHealth)
        .where(
          and(
            eq(agentSandboxBackupHealth.sandbox_record_id, params.sandboxRecordId),
            eq(agentSandboxBackupHealth.lease_token, params.leaseToken),
          ),
        )
        .for("update")
        .limit(1);
      if (!health) return false;
      const consecutiveFailures = health.consecutive_failures + 1;
      await tx
        .update(agentSandboxBackupHealth)
        .set({
          last_attempt_started_at: now,
          last_attempt_completed_at: now,
          last_outcome: "enqueue_failed",
          lease_token: null,
          lease_expires_at: null,
          next_attempt_at: retryAt(now, consecutiveFailures),
          consecutive_failures: consecutiveFailures,
          last_error: error,
          updated_at: now,
        })
        .where(eq(agentSandboxBackupHealth.sandbox_record_id, params.sandboxRecordId));
      return true;
    });
  }

  async startAttempt(
    sandboxRecordId: string,
    execution: { jobId: string; jobStartedAt: Date },
  ): Promise<BackupAttemptContext> {
    if (Number.isNaN(execution.jobStartedAt.getTime())) {
      throw new ElizaError("Backup attempt jobStartedAt must be a valid date", {
        code: "AGENT_BACKUP_HEALTH_INVALID_JOB_START",
        context: { sandboxRecordId, jobId: execution.jobId },
      });
    }
    return writeTransaction(async (tx) => {
      const now = await readDatabaseClock(tx);
      const [claimedJob] = await tx
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          agentId: jobs.agent_id,
          startedAt: jobs.started_at,
        })
        .from(jobs)
        .where(eq(jobs.id, execution.jobId))
        .for("update")
        .limit(1);
      if (
        !claimedJob ||
        claimedJob.type !== "agent_snapshot" ||
        claimedJob.status !== "in_progress" ||
        claimedJob.agentId !== sandboxRecordId ||
        claimedJob.startedAt === null ||
        claimedJob.startedAt.getTime() !== execution.jobStartedAt.getTime()
      ) {
        throw new ElizaError("Cannot start a backup attempt from a stale job execution", {
          code: "AGENT_BACKUP_HEALTH_STALE_JOB_EXECUTION",
          context: {
            sandboxRecordId,
            jobId: execution.jobId,
            jobStartedAt: execution.jobStartedAt.toISOString(),
            currentStatus: claimedJob?.status,
            currentStartedAt: claimedJob?.startedAt?.toISOString(),
          },
        });
      }

      const [sandbox] = await tx
        .select({
          id: agentSandboxes.id,
          imageIdentity: agentSandboxes.image_digest,
          lastBackupAt: agentSandboxes.last_backup_at,
        })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandboxRecordId))
        .for("update")
        .limit(1);
      if (!sandbox) {
        throw new ElizaError("Cannot start a backup attempt for a missing agent", {
          code: "AGENT_BACKUP_HEALTH_AGENT_NOT_FOUND",
          context: { sandboxRecordId },
        });
      }

      const [existing] = await tx
        .select()
        .from(agentSandboxBackupHealth)
        .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandboxRecordId))
        .for("update")
        .limit(1);
      const imageChanged =
        existing !== undefined && isImageChange(existing.image_identity, sandbox.imageIdentity);
      if (
        !imageChanged &&
        existing?.attempt_token !== null &&
        existing?.attempt_token !== undefined &&
        existing.last_attempt_started_at !== null &&
        existing.last_attempt_started_at.getTime() + DEFAULT_BACKUP_ATTEMPT_LEASE_MS > now.getTime()
      ) {
        throw new ElizaError("A live backup attempt already owns this agent", {
          code: "AGENT_BACKUP_HEALTH_ATTEMPT_ACTIVE",
          context: {
            sandboxRecordId,
            jobId: execution.jobId,
            activeJobId: existing.attempt_job_id,
            activeStartedAt: existing.last_attempt_started_at.toISOString(),
          },
        });
      }
      const attemptToken = randomUUID();

      await tx
        .insert(agentSandboxBackupHealth)
        .values({
          sandbox_record_id: sandboxRecordId,
          image_identity: sandbox.imageIdentity,
          capability: "unknown",
          last_attempt_started_at: now,
          last_success_at: sandbox.lastBackupAt,
          last_outcome: "in_progress",
          attempt_token: attemptToken,
          attempt_job_id: execution.jobId,
          attempt_job_started_at: execution.jobStartedAt,
          lease_token: null,
          lease_expires_at: null,
          next_attempt_at: null,
          consecutive_failures: 0,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: agentSandboxBackupHealth.sandbox_record_id,
          set: {
            image_identity: sandbox.imageIdentity,
            capability: imageChanged ? "unknown" : sql`${agentSandboxBackupHealth.capability}`,
            last_attempt_started_at: now,
            last_attempt_completed_at: null,
            last_outcome: "in_progress",
            attempt_token: attemptToken,
            attempt_job_id: execution.jobId,
            attempt_job_started_at: execution.jobStartedAt,
            lease_token: null,
            lease_expires_at: null,
            backup_required: imageChanged ? true : sql`${agentSandboxBackupHealth.backup_required}`,
            next_attempt_at: imageChanged ? null : sql`${agentSandboxBackupHealth.next_attempt_at}`,
            consecutive_failures: imageChanged
              ? 0
              : sql`${agentSandboxBackupHealth.consecutive_failures}`,
            last_error: imageChanged ? null : sql`${agentSandboxBackupHealth.last_error}`,
            alert_fingerprint: imageChanged
              ? null
              : sql`${agentSandboxBackupHealth.alert_fingerprint}`,
            last_alerted_at: imageChanged ? null : sql`${agentSandboxBackupHealth.last_alerted_at}`,
            updated_at: now,
          },
        });

      return {
        sandboxRecordId,
        attemptToken,
        jobId: execution.jobId,
        jobStartedAt: execution.jobStartedAt,
        imageIdentity: sandbox.imageIdentity,
      };
    });
  }

  async recordAttemptOutcome(params: {
    attempt: BackupAttemptContext;
    outcome: CompletedBackupAttemptOutcome;
    error?: string;
  }): Promise<BackupAttemptWriteResult> {
    let error: string | null = null;
    if (params.outcome !== "success") {
      if (params.error === undefined) {
        throw new ElizaError("A failed backup outcome requires an error description", {
          code: "AGENT_BACKUP_OUTCOME_ERROR_REQUIRED",
          context: {
            sandboxRecordId: params.attempt.sandboxRecordId,
            outcome: params.outcome,
          },
        });
      }
      error = boundedError(params.error);
    }

    return writeTransaction(async (tx) => {
      const now = await readDatabaseClock(tx);
      const [claimedJob] = await tx
        .select({
          type: jobs.type,
          status: jobs.status,
          agentId: jobs.agent_id,
          startedAt: jobs.started_at,
        })
        .from(jobs)
        .where(eq(jobs.id, params.attempt.jobId))
        .for("update")
        .limit(1);
      if (
        !claimedJob ||
        claimedJob.type !== "agent_snapshot" ||
        claimedJob.status !== "in_progress" ||
        claimedJob.agentId !== params.attempt.sandboxRecordId ||
        claimedJob.startedAt === null ||
        claimedJob.startedAt.getTime() !== params.attempt.jobStartedAt.getTime()
      ) {
        return { recorded: false, imageChanged: false };
      }

      const [sandbox] = await tx
        .select({ imageIdentity: agentSandboxes.image_digest })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, params.attempt.sandboxRecordId))
        .for("update")
        .limit(1);
      const [health] = await tx
        .select()
        .from(agentSandboxBackupHealth)
        .where(eq(agentSandboxBackupHealth.sandbox_record_id, params.attempt.sandboxRecordId))
        .for("update")
        .limit(1);
      if (
        !sandbox ||
        !health ||
        health.attempt_token !== params.attempt.attemptToken ||
        health.attempt_job_id !== params.attempt.jobId ||
        health.attempt_job_started_at?.getTime() !== params.attempt.jobStartedAt.getTime()
      ) {
        return { recorded: false, imageChanged: false };
      }

      const imageChanged = isImageChange(params.attempt.imageIdentity, sandbox.imageIdentity);
      if (imageChanged) {
        await tx
          .update(agentSandboxBackupHealth)
          .set({
            image_identity: sandbox.imageIdentity,
            capability: "unknown",
            last_attempt_completed_at: now,
            last_success_at: sql`${agentSandboxBackupHealth.last_success_at}`,
            last_outcome: "image_changed",
            attempt_token: null,
            attempt_job_id: null,
            attempt_job_started_at: null,
            lease_token: null,
            lease_expires_at: null,
            backup_required: true,
            next_attempt_at: null,
            consecutive_failures: 0,
            last_error: null,
            alert_fingerprint: null,
            last_alerted_at: null,
            updated_at: now,
          })
          .where(eq(agentSandboxBackupHealth.sandbox_record_id, params.attempt.sandboxRecordId));
        return { recorded: true, imageChanged: true };
      }

      let capability: AgentSandboxBackupCapability = health.capability;
      let consecutiveFailures = health.consecutive_failures;
      let nextAttemptAt: Date | null = null;
      let lastOutcome: AgentSandboxBackupOutcome = params.outcome;

      if (params.outcome === "success") {
        capability = params.attempt.imageIdentity === null ? "unknown" : "supported";
        consecutiveFailures = 0;
      } else if (params.outcome === "generation_changed") {
        consecutiveFailures = 0;
        lastOutcome = "generation_changed";
      } else if (params.outcome === "unsupported") {
        if (params.attempt.imageIdentity === null) {
          capability = "unknown";
          consecutiveFailures += 1;
          nextAttemptAt = new Date(now.getTime() + DEFAULT_BACKUP_RETRY_MAX_MS);
        } else {
          capability = "unsupported";
          consecutiveFailures = 0;
        }
      } else if (params.outcome === "unavailable") {
        consecutiveFailures += 1;
        nextAttemptAt = new Date(now.getTime() + DEFAULT_BACKUP_UNAVAILABLE_RETRY_MS);
      } else {
        consecutiveFailures += 1;
        nextAttemptAt = retryAt(now, consecutiveFailures);
        lastOutcome = "failed";
      }

      await tx
        .update(agentSandboxBackupHealth)
        .set({
          capability,
          last_attempt_completed_at: now,
          last_success_at:
            params.outcome === "success" ? now : sql`${agentSandboxBackupHealth.last_success_at}`,
          last_outcome: lastOutcome,
          attempt_token: null,
          attempt_job_id: null,
          attempt_job_started_at: null,
          lease_token: null,
          lease_expires_at: null,
          backup_required:
            params.outcome === "success"
              ? false
              : params.outcome === "generation_changed"
                ? true
                : sql`${agentSandboxBackupHealth.backup_required}`,
          next_attempt_at: nextAttemptAt,
          consecutive_failures: consecutiveFailures,
          last_error: error,
          alert_fingerprint:
            params.outcome === "success"
              ? null
              : sql`${agentSandboxBackupHealth.alert_fingerprint}`,
          last_alerted_at:
            params.outcome === "success" ? null : sql`${agentSandboxBackupHealth.last_alerted_at}`,
          updated_at: now,
        })
        .where(eq(agentSandboxBackupHealth.sandbox_record_id, params.attempt.sandboxRecordId));

      return { recorded: true, imageChanged: false };
    });
  }

  async readFleetSnapshot(params: {
    targetIntervalMs: number;
    repeatedFailureThreshold: number;
    problemLimit: number;
  }): Promise<BackupFleetSnapshot> {
    requirePositiveInteger(params.targetIntervalMs, "targetIntervalMs", 30 * 24 * 60 * 60_000);
    requirePositiveInteger(params.repeatedFailureThreshold, "repeatedFailureThreshold", 100);
    requirePositiveInteger(params.problemLimit, "problemLimit", 1_000);
    return writeTransaction(async (tx) => {
      const now = await readDatabaseClock(tx);
      const staleCutoff = new Date(now.getTime() - 2 * params.targetIntervalMs);
      const dueCutoff = new Date(now.getTime() - params.targetIntervalMs);
      await syncFleetRows(tx, now);

      const fleetProblem = sql`
        (
          ${agentSandboxes.bridge_url} IS NULL
          OR ${agentSandboxes.bridge_url} = ${BACKUP_UNREACHABLE_BRIDGE_SENTINEL}
          OR (
            ${agentSandboxes.last_backup_at} IS NULL
            AND ${agentSandboxes.created_at} < ${dueCutoff}
          )
          OR ${agentSandboxes.last_backup_at} < ${staleCutoff}
          OR ${agentSandboxBackupHealth.backup_required}
          OR (
            ${agentSandboxBackupHealth.capability} = 'unsupported'
            AND ${agentSandboxes.image_digest} IS NOT NULL
            AND ${agentSandboxBackupHealth.image_identity} = ${agentSandboxes.image_digest}
          )
          OR ${agentSandboxBackupHealth.consecutive_failures}
            >= ${params.repeatedFailureThreshold}
        )
      `;

      await tx.execute(sql`
        UPDATE ${agentSandboxBackupHealth}
        SET
          alert_fingerprint = NULL,
          updated_at = ${now}
        WHERE ${agentSandboxBackupHealth.alert_fingerprint} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentSandboxes}
            WHERE ${agentSandboxes.id} = ${agentSandboxBackupHealth.sandbox_record_id}
              AND ${localStateFleetPredicate()}
              AND ${fleetProblem}
          )
      `);

      const [aggregate] = await sqlRows<FleetAggregateRow>(
        tx,
        sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE ${agentSandboxes.last_backup_at} IS NULL
                AND ${agentSandboxes.created_at} < ${dueCutoff}
            )::int AS absent,
            COUNT(*) FILTER (
              WHERE ${agentSandboxes.last_backup_at} IS NOT NULL
                AND ${agentSandboxes.last_backup_at} < ${staleCutoff}
            )::int AS stale,
            COUNT(*) FILTER (
              WHERE ${agentSandboxBackupHealth.capability} = 'unsupported'
                AND ${agentSandboxes.image_digest} IS NOT NULL
                AND ${agentSandboxBackupHealth.image_identity} = ${agentSandboxes.image_digest}
            )::int AS unsupported,
            COUNT(*) FILTER (
              WHERE ${agentSandboxes.bridge_url} IS NULL
                OR ${agentSandboxes.bridge_url} = ${BACKUP_UNREACHABLE_BRIDGE_SENTINEL}
            )::int AS unreachable,
            COUNT(*) FILTER (
              WHERE ${agentSandboxBackupHealth.consecutive_failures}
                >= ${params.repeatedFailureThreshold}
            )::int AS repeated_failures,
            COUNT(*) FILTER (
              WHERE ${agentSandboxBackupHealth.backup_required}
            )::int AS image_refresh_required,
            COUNT(*) FILTER (
              WHERE ${agentSandboxBackupHealth.backup_required}
                OR (
                ${agentSandboxes.last_backup_at} IS NULL
                AND ${agentSandboxes.created_at} < ${dueCutoff}
              )
                OR ${agentSandboxes.last_backup_at} < ${dueCutoff}
            )::int AS backlog,
            MIN(
              COALESCE(
                ${agentSandboxes.last_backup_at},
                ${agentSandboxes.created_at}
              )
            ) AS oldest_backup_at
          FROM ${agentSandboxes}
          JOIN ${agentSandboxBackupHealth}
            ON ${agentSandboxBackupHealth.sandbox_record_id} = ${agentSandboxes.id}
          WHERE ${localStateFleetPredicate()}
        `,
      );
      if (!aggregate) {
        throw new ElizaError("Backup fleet-health query returned no aggregate row", {
          code: "AGENT_BACKUP_HEALTH_MISSING_FLEET_AGGREGATE",
        });
      }

      const problemRows = await sqlRows<FleetProblemRow>(
        tx,
        sql`
          SELECT
            ${agentSandboxes.id},
            ${agentSandboxes.organization_id},
            ${agentSandboxes.agent_name},
            ${agentSandboxes.last_backup_at},
            ${agentSandboxes.created_at},
            ${agentSandboxes.bridge_url},
            ${agentSandboxBackupHealth.image_identity},
            ${agentSandboxes.image_digest},
            ${agentSandboxBackupHealth.capability},
            ${agentSandboxBackupHealth.backup_required},
            ${agentSandboxBackupHealth.consecutive_failures},
            ${agentSandboxBackupHealth.last_error},
            ${agentSandboxBackupHealth.alert_fingerprint}
          FROM ${agentSandboxes}
          JOIN ${agentSandboxBackupHealth}
            ON ${agentSandboxBackupHealth.sandbox_record_id} = ${agentSandboxes.id}
          WHERE ${localStateFleetPredicate()}
            AND ${fleetProblem}
          ORDER BY
            (${agentSandboxBackupHealth.alert_fingerprint} IS NULL) DESC,
            ${agentSandboxBackupHealth.last_alerted_at} ASC NULLS FIRST,
            ${agentSandboxes.last_backup_at} ASC NULLS FIRST,
            ${agentSandboxBackupHealth.last_attempt_started_at} ASC NULLS FIRST,
            ${agentSandboxes.id} ASC
          LIMIT ${params.problemLimit}
        `,
      );

      return {
        asOf: now,
        total: databaseNumber(aggregate.total, "total"),
        absent: databaseNumber(aggregate.absent, "absent"),
        stale: databaseNumber(aggregate.stale, "stale"),
        unsupported: databaseNumber(aggregate.unsupported, "unsupported"),
        unreachable: databaseNumber(aggregate.unreachable, "unreachable"),
        repeatedFailures: databaseNumber(aggregate.repeated_failures, "repeated_failures"),
        imageRefreshRequired: databaseNumber(
          aggregate.image_refresh_required,
          "image_refresh_required",
        ),
        backlog: databaseNumber(aggregate.backlog, "backlog"),
        oldestBackupAt: databaseDate(aggregate.oldest_backup_at, "oldest_backup_at"),
        problems: problemRows.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          agentName: row.agent_name,
          lastBackupAt: databaseDate(row.last_backup_at, "last_backup_at"),
          createdAt: requiredDatabaseDate(row.created_at, "created_at"),
          bridgeUrl: row.bridge_url,
          imageIdentity: row.image_identity,
          imageDigest: row.image_digest,
          capability: row.capability,
          backupRequired: row.backup_required,
          consecutiveFailures: row.consecutive_failures,
          lastError: row.last_error,
          alertFingerprint: row.alert_fingerprint,
        })),
      };
    });
  }

  async claimAlertFingerprint(params: {
    sandboxRecordId: string;
    fingerprint: string;
  }): Promise<boolean> {
    if (params.fingerprint.trim().length === 0) {
      throw new ElizaError("Backup-health alert fingerprints cannot be empty", {
        code: "AGENT_BACKUP_HEALTH_EMPTY_ALERT_FINGERPRINT",
        context: { sandboxRecordId: params.sandboxRecordId },
      });
    }
    const claimed = await dbWrite
      .update(agentSandboxBackupHealth)
      .set({
        alert_fingerprint: params.fingerprint,
        last_alerted_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentSandboxBackupHealth.sandbox_record_id, params.sandboxRecordId),
          sql`${agentSandboxBackupHealth.alert_fingerprint}
            IS DISTINCT FROM ${params.fingerprint}`,
        ),
      )
      .returning({ id: agentSandboxBackupHealth.sandbox_record_id });
    return claimed.length === 1;
  }

  async clearAlertFingerprint(sandboxRecordId: string): Promise<void> {
    await dbWrite
      .update(agentSandboxBackupHealth)
      .set({
        alert_fingerprint: null,
        last_alerted_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandboxRecordId));
  }

  async releaseAlertFingerprint(sandboxRecordId: string, fingerprint: string): Promise<void> {
    await dbWrite
      .update(agentSandboxBackupHealth)
      .set({
        alert_fingerprint: null,
        last_alerted_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentSandboxBackupHealth.sandbox_record_id, sandboxRecordId),
          eq(agentSandboxBackupHealth.alert_fingerprint, fingerprint),
        ),
      );
  }

  async claimFleetAlertFingerprint(params: {
    scope: string;
    fingerprint: string;
  }): Promise<boolean> {
    if (params.scope.trim().length === 0 || params.fingerprint.trim().length === 0) {
      throw new ElizaError("Fleet-health alert scope and fingerprint cannot be empty", {
        code: "AGENT_BACKUP_FLEET_EMPTY_ALERT_FINGERPRINT",
        context: { scope: params.scope },
      });
    }
    const claimed = await dbWrite
      .insert(agentBackupFleetHealthState)
      .values({
        scope: params.scope,
        alert_fingerprint: params.fingerprint,
        last_alerted_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: agentBackupFleetHealthState.scope,
        set: {
          alert_fingerprint: params.fingerprint,
          last_alerted_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        },
        setWhere: sql`${agentBackupFleetHealthState.alert_fingerprint}
          IS DISTINCT FROM ${params.fingerprint}`,
      })
      .returning({ scope: agentBackupFleetHealthState.scope });
    return claimed.length === 1;
  }

  async clearFleetAlertFingerprint(scope: string): Promise<void> {
    await dbWrite
      .insert(agentBackupFleetHealthState)
      .values({
        scope,
        alert_fingerprint: null,
        updated_at: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: agentBackupFleetHealthState.scope,
        set: {
          alert_fingerprint: null,
          last_alerted_at: null,
          updated_at: sql`clock_timestamp()`,
        },
        setWhere: sql`${agentBackupFleetHealthState.alert_fingerprint} IS NOT NULL`,
      });
  }

  async releaseFleetAlertFingerprint(scope: string, fingerprint: string): Promise<void> {
    await dbWrite
      .update(agentBackupFleetHealthState)
      .set({
        alert_fingerprint: null,
        last_alerted_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentBackupFleetHealthState.scope, scope),
          eq(agentBackupFleetHealthState.alert_fingerprint, fingerprint),
        ),
      );
  }
}

export const agentSandboxBackupHealthRepository = new AgentSandboxBackupHealthRepository();
