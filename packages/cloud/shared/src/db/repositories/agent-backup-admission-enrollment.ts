/**
 * Enrolls bounded periodic-backup cohorts into the durable admission queue.
 *
 * A shard retains its primary-database cutoff, MVCC snapshot, RPO policy, and
 * keyset cursor until the complete frozen source set has been visited. This
 * module only mutates database admission state; provider capacity and sandbox
 * provisioning are intentionally outside its dependency graph.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "../schemas/agent-backup-admission";
import { agentNodeIncarnationHistories } from "../schemas/agent-node-incarnation-histories";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";

export const MAX_AGENT_BACKUP_ADMISSION_ENROLLMENT_BATCH = 100;
export const MAX_AGENT_BACKUP_ADMISSION_ENROLLMENT_LEASE_MS = 5 * 60_000;
export const MIN_AGENT_BACKUP_ADMISSION_RPO_MS = 60_000;
export const MAX_AGENT_BACKUP_ADMISSION_RPO_MS = 15 * 60_000;
export const MAX_AGENT_BACKUP_ADMISSION_LEASE_OWNER_BYTES = 128;

const MAX_COHORT_ORDINAL = 2_147_483_647;

interface ScheduleEnrollmentCandidateRow {
  id: string;
  organization_id: string;
  node_history_id: string;
  activation_generation: string;
  activation_lifecycle_revision: string;
  lifecycle_revision: string;
  activation_node_id: string;
  activation_container_id: string;
  source_provider_handle: string;
  source_image_digest: string;
  source_rpo_ms: number;
  source_due_at: string;
  rpo_deadline_at: string;
  priority_class: "active_rpo" | "periodic_capture";
  base_priority: 1 | 3;
}

interface ScheduleEnrollmentCandidate extends ScheduleEnrollmentCandidateRow {
  cohort_ordinal: number;
}

export interface AgentBackupScheduleAdmissionEnrollmentSummary {
  shardId: number;
  cohortId: string;
  enrolled: number;
  queued: number;
  cohortComplete: boolean;
}

type AgentBackupAdmissionEnrollmentFailureCode =
  | "BACKUP_ADMISSION_ENROLLMENT_SHARD_CONTENDED"
  | "BACKUP_ADMISSION_ENROLLMENT_LEASE_EXPIRED"
  | "BACKUP_ADMISSION_ENROLLMENT_COHORT_EXHAUSTED";

/** A fail-closed transaction fence or bounded-cohort invariant failure. */
export class AgentBackupAdmissionEnrollmentError extends ElizaError {
  override readonly name = "AgentBackupAdmissionEnrollmentError";

  constructor(message: string, code: AgentBackupAdmissionEnrollmentFailureCode) {
    super(message, {
      code,
      context: { operation: "schedule-capture-enrollment" },
      severity: "ephemeral",
    });
  }
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

export function requireAgentBackupAdmissionEnrollmentLeaseOwner(value: string): string {
  if (/[\u0080-\u009f]/.test(value)) {
    throw new Error("ownerId must be canonical and contain no control characters");
  }
  const owner = requireBoundedIdentity(value, "ownerId");
  if (new TextEncoder().encode(owner).byteLength > MAX_AGENT_BACKUP_ADMISSION_LEASE_OWNER_BYTES) {
    throw new Error(
      `ownerId must contain at most ${MAX_AGENT_BACKUP_ADMISSION_LEASE_OWNER_BYTES} UTF-8 bytes`,
    );
  }
  return owner;
}

function requireCohortOrdinalCapacity(cursorOrdinal: number | null, batchSize: number): number {
  if (cursorOrdinal === null) return -1;
  if (
    !Number.isInteger(cursorOrdinal) ||
    cursorOrdinal < 0 ||
    cursorOrdinal > MAX_COHORT_ORDINAL - batchSize
  ) {
    throw new AgentBackupAdmissionEnrollmentError(
      "Backup admission cohort ordinal space is exhausted",
      "BACKUP_ADMISSION_ENROLLMENT_COHORT_EXHAUSTED",
    );
  }
  return cursorOrdinal;
}

async function lockAdmissibleOrganizations(
  tx: DbTransaction,
  candidates: readonly ScheduleEnrollmentCandidate[],
): Promise<Set<string>> {
  const organizationIds = [
    ...new Set(candidates.map(({ organization_id }) => organization_id)),
  ].sort();
  if (organizationIds.length === 0) return new Set();
  const rows = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT account_org.id
      FROM ${organizations} AS account_org
      WHERE account_org.id IN (${sql.join(
        organizationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND account_org.account_lifecycle_state = 'active'
        AND account_org.is_active
        AND account_org.account_deletion_request_id IS NULL
      ORDER BY account_org.id
      FOR SHARE OF account_org`,
  );
  return new Set(rows.map(({ id }) => id));
}

/**
 * Enroll one restartable slice from one available `schedule_capture` shard.
 *
 * `null` means all 64 shard authorities are either transaction-locked or hold
 * a non-expired lease. A non-null incomplete result is resumed before idle
 * shards, even when another worker owns the next transaction.
 */
export async function enrollDueAgentBackupScheduleAdmissionCohort(params: {
  ownerId: string;
  limit: number;
  leaseMs: number;
  rpoMs: number;
}): Promise<AgentBackupScheduleAdmissionEnrollmentSummary | null> {
  const ownerId = requireAgentBackupAdmissionEnrollmentLeaseOwner(params.ownerId);
  const limit = requireBoundedInteger({
    value: params.limit,
    field: "limit",
    min: 1,
    max: MAX_AGENT_BACKUP_ADMISSION_ENROLLMENT_BATCH,
  });
  const leaseMs = requireBoundedInteger({
    value: params.leaseMs,
    field: "leaseMs",
    min: 1,
    max: MAX_AGENT_BACKUP_ADMISSION_ENROLLMENT_LEASE_MS,
  });
  const requestedRpoMs = requireBoundedInteger({
    value: params.rpoMs,
    field: "rpoMs",
    min: MIN_AGENT_BACKUP_ADMISSION_RPO_MS,
    max: MAX_AGENT_BACKUP_ADMISSION_RPO_MS,
  });
  const leaseGeneration = randomUUID();

  return dbWrite.transaction(async (tx) => {
    const [availableShard] = await tx
      .select({
        shardId: agentBackupAdmissionEnrollmentShards.shard_id,
        scheduleRpoMs: agentBackupAdmissionEnrollmentShards.scan_schedule_rpo_ms,
      })
      .from(agentBackupAdmissionEnrollmentShards)
      .where(
        and(
          eq(agentBackupAdmissionEnrollmentShards.work_kind, "schedule_capture"),
          sql`(${agentBackupAdmissionEnrollmentShards.lease_expires_at} IS NULL
            OR ${agentBackupAdmissionEnrollmentShards.lease_expires_at} <= clock_timestamp())`,
        ),
      )
      // PostgreSQL sorts FALSE before TRUE. An incomplete cohort therefore
      // resumes before a shard that has not frozen its next snapshot yet.
      .orderBy(
        sql`${agentBackupAdmissionEnrollmentShards.active_cohort} IS NULL`,
        agentBackupAdmissionEnrollmentShards.updated_at,
        agentBackupAdmissionEnrollmentShards.shard_id,
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!availableShard) return null;

    // A policy change cannot rewrite the deadline of a partially visited
    // cohort. The caller's value takes effect only when the next snapshot is
    // frozen on this shard.
    const cohortRpoMs = availableShard.scheduleRpoMs ?? requestedRpoMs;
    const [shard] = await sqlRows<{
      shard_id: number;
      cohort_id: string;
      cutoff_at: string;
      cursor_due_at: string | null;
      cursor_id: string | null;
      cursor_ordinal: number | null;
      snapshot: string;
      observed_at: string;
    }>(
      tx,
      sql`
        WITH observed AS MATERIALIZED (
          SELECT clock_timestamp() AS at, pg_current_snapshot() AS snapshot
        )
        UPDATE ${agentBackupAdmissionEnrollmentShards} AS shard
        SET scan_cutoff_at = COALESCE(shard.scan_cutoff_at, observed.at),
            scan_snapshot = COALESCE(shard.scan_snapshot, observed.snapshot),
            scan_schedule_rpo_ms = COALESCE(shard.scan_schedule_rpo_ms, ${cohortRpoMs}),
            active_cohort = COALESCE(
              shard.active_cohort,
              nextval('agent_backup_admission_cohort_seq')
            ),
            lease_owner = ${ownerId},
            lease_generation = ${leaseGeneration},
            lease_expires_at = observed.at + (${leaseMs} * INTERVAL '1 millisecond'),
            updated_at = observed.at
        FROM observed
        WHERE shard.work_kind = 'schedule_capture'
          AND shard.shard_id = ${availableShard.shardId}
          AND (shard.lease_expires_at IS NULL OR shard.lease_expires_at <= observed.at)
        RETURNING shard.shard_id,
          shard.active_cohort::text AS cohort_id,
          shard.scan_cutoff_at::text AS cutoff_at,
          shard.scan_cursor_due_at::text AS cursor_due_at,
          shard.scan_cursor_id::text AS cursor_id,
          shard.scan_cursor_ordinal AS cursor_ordinal,
          shard.scan_snapshot::text AS snapshot,
          observed.at::text AS observed_at
      `,
    );
    if (!shard) {
      throw new AgentBackupAdmissionEnrollmentError(
        "Backup admission enrollment shard lease was contended",
        "BACKUP_ADMISSION_ENROLLMENT_SHARD_CONTENDED",
      );
    }

    // Reuse any unsettled authority for the same sandbox activation when a
    // later cohort changes the RPO. Once it settles, the exact old due remains
    // a replay fence while a genuinely new due may be enrolled.
    const candidateRows = await sqlRows<ScheduleEnrollmentCandidateRow>(
      tx,
      sql`
        WITH eligible AS NOT MATERIALIZED (
          SELECT sandbox.id,
            sandbox.organization_id,
            source_occurrence.id AS node_history_id,
            sandbox.activation_generation,
            sandbox.activation_lifecycle_revision,
            sandbox.lifecycle_revision,
            sandbox.activation_node_id,
            sandbox.activation_container_id,
            sandbox.sandbox_id AS source_provider_handle,
            sandbox.activation_image_digest AS source_image_digest,
            sandbox.next_backup_at,
            sandbox.activation_completed_at,
            GREATEST(
              sandbox.activation_completed_at,
              COALESCE(
                sandbox.backup_schedule_last_protected_at,
                sandbox.activation_completed_at
              )
            ) AS rpo_anchor_at
          FROM ${agentSandboxes} AS sandbox
          JOIN ${organizations} AS account_org
            ON account_org.id = sandbox.organization_id
            AND account_org.account_lifecycle_state = 'active'
            AND account_org.is_active
            AND account_org.account_deletion_request_id IS NULL
          JOIN ${dockerNodes} AS source_node
            ON source_node.node_id = sandbox.activation_node_id
            AND source_node.node_incarnation = sandbox.activation_boot_id
            AND source_node.node_incarnation IS NOT NULL
            AND source_node.current_node_history_id IS NOT NULL
            AND source_node.infrastructure_provider = 'hetzner'
            AND btrim(source_node.host_key_fingerprint) <> ''
            AND (
              (source_node.fleet_kind = 'robot' AND source_node.provider_server_id IS NULL)
              OR (source_node.fleet_kind = 'cloud' AND source_node.provider_server_id IS NOT NULL)
            )
          JOIN ${agentNodeIncarnationHistories} AS source_occurrence
            ON source_occurrence.id = source_node.current_node_history_id
            AND source_occurrence.docker_node_record_id = source_node.id
            AND source_occurrence.node_id = source_node.node_id
            AND source_occurrence.node_incarnation = source_node.node_incarnation
            AND source_occurrence.fleet_kind = source_node.fleet_kind
            AND source_occurrence.infrastructure_provider = source_node.infrastructure_provider
            AND source_occurrence.provider_server_id
              IS NOT DISTINCT FROM source_node.provider_server_id
            AND source_occurrence.host_key_fingerprint = source_node.host_key_fingerprint
          WHERE agent_backup_admission_expected_shard(sandbox.id) = ${shard.shard_id}
            AND agent_backup_admission_source_visible(
              source_node.backup_admission_xid,
              ${shard.snapshot}::pg_snapshot
            )
            AND agent_backup_admission_source_visible(
              sandbox.backup_admission_xid,
              ${shard.snapshot}::pg_snapshot
            )
            AND sandbox.status = 'running'
            AND sandbox.pool_status IS NULL
            AND sandbox.execution_tier <> 'shared'
            AND sandbox.activation_phase = 'active'
            AND sandbox.activation_generation IS NOT NULL
            AND sandbox.activation_lifecycle_revision IS NOT NULL
            AND sandbox.lifecycle_revision = sandbox.activation_lifecycle_revision
            AND sandbox.activation_receipt_hash ~ '^[0-9a-f]{64}$'
            AND sandbox.activation_container_id ~ '^[0-9a-f]{64}$'
            AND sandbox.sandbox_id IS NOT NULL
            AND btrim(sandbox.sandbox_id) <> ''
            AND sandbox.sandbox_id = btrim(sandbox.sandbox_id)
            AND sandbox.sandbox_id !~ '[[:cntrl:]]'
            AND octet_length(sandbox.sandbox_id) <= 512
            AND sandbox.sandbox_id <> sandbox.activation_container_id
            AND sandbox.activation_node_id IS NOT NULL
            AND sandbox.activation_image_digest ~ '^sha256:[0-9a-f]{64}$'
            AND sandbox.activation_authority_published_at IS NOT NULL
            AND sandbox.activation_dispatched_at IS NOT NULL
            AND sandbox.activation_completed_at IS NOT NULL
        ), frontier AS (
          (
            SELECT eligible.*, eligible.activation_completed_at AS source_due_at
            FROM eligible
            WHERE eligible.next_backup_at IS NULL
              AND eligible.activation_completed_at <= ${shard.cutoff_at}::timestamptz
              AND (
                ${shard.cursor_due_at}::timestamptz IS NULL
                OR (eligible.activation_completed_at, eligible.id)
                  > (${shard.cursor_due_at}::timestamptz, ${shard.cursor_id}::uuid)
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${agentBackupAdmissionWork} AS existing
                WHERE existing.work_kind = 'schedule_capture'
                  AND existing.sandbox_id = eligible.id
                  AND existing.source_activation_generation = eligible.activation_generation
                  AND existing.source_lifecycle_revision = eligible.activation_lifecycle_revision
                  AND (
                    existing.state <> 'settled'
                    OR (
                      existing.node_history_id = eligible.node_history_id
                      AND existing.source_due_at = eligible.activation_completed_at
                    )
                  )
              )
            ORDER BY eligible.activation_completed_at, eligible.id
            LIMIT ${limit + 1}
          )
          UNION ALL
          (
            SELECT eligible.*, eligible.next_backup_at AS source_due_at
            FROM eligible
            WHERE eligible.next_backup_at IS NOT NULL
              AND eligible.next_backup_at <= eligible.rpo_anchor_at
                + (${cohortRpoMs} * INTERVAL '1 millisecond')
              AND eligible.next_backup_at <= ${shard.cutoff_at}::timestamptz
              AND (
                ${shard.cursor_due_at}::timestamptz IS NULL
                OR (eligible.next_backup_at, eligible.id)
                  > (${shard.cursor_due_at}::timestamptz, ${shard.cursor_id}::uuid)
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${agentBackupAdmissionWork} AS existing
                WHERE existing.work_kind = 'schedule_capture'
                  AND existing.sandbox_id = eligible.id
                  AND existing.source_activation_generation = eligible.activation_generation
                  AND existing.source_lifecycle_revision = eligible.activation_lifecycle_revision
                  AND (
                    existing.state <> 'settled'
                    OR (
                      existing.node_history_id = eligible.node_history_id
                      AND existing.source_due_at = eligible.next_backup_at
                    )
                  )
              )
            ORDER BY eligible.next_backup_at, eligible.id
            LIMIT ${limit + 1}
          )
          UNION ALL
          (
            SELECT eligible.*,
              eligible.rpo_anchor_at
                + (${cohortRpoMs} * INTERVAL '1 millisecond') AS source_due_at
            FROM eligible
            WHERE eligible.next_backup_at IS NOT NULL
              AND eligible.next_backup_at > eligible.rpo_anchor_at
                + (${cohortRpoMs} * INTERVAL '1 millisecond')
              AND eligible.rpo_anchor_at
                + (${cohortRpoMs} * INTERVAL '1 millisecond')
                <= ${shard.cutoff_at}::timestamptz
              AND (
                ${shard.cursor_due_at}::timestamptz IS NULL
                OR (
                  eligible.rpo_anchor_at
                    + (${cohortRpoMs} * INTERVAL '1 millisecond'),
                  eligible.id
                ) > (${shard.cursor_due_at}::timestamptz, ${shard.cursor_id}::uuid)
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${agentBackupAdmissionWork} AS existing
                WHERE existing.work_kind = 'schedule_capture'
                  AND existing.sandbox_id = eligible.id
                  AND existing.source_activation_generation = eligible.activation_generation
                  AND existing.source_lifecycle_revision = eligible.activation_lifecycle_revision
                  AND (
                    existing.state <> 'settled'
                    OR (
                      existing.node_history_id = eligible.node_history_id
                      AND existing.source_due_at = eligible.rpo_anchor_at
                        + (${cohortRpoMs} * INTERVAL '1 millisecond')
                    )
                  )
              )
            ORDER BY eligible.rpo_anchor_at, eligible.id
            LIMIT ${limit + 1}
          )
        )
        SELECT frontier.id,
          frontier.organization_id,
          frontier.node_history_id,
          frontier.activation_generation,
          frontier.activation_lifecycle_revision::text AS activation_lifecycle_revision,
          frontier.lifecycle_revision::text AS lifecycle_revision,
          frontier.activation_node_id,
          frontier.activation_container_id,
          frontier.source_provider_handle,
          frontier.source_image_digest,
          ${cohortRpoMs}::integer AS source_rpo_ms,
          frontier.source_due_at::text AS source_due_at,
          (
            frontier.rpo_anchor_at
              + (${cohortRpoMs} * INTERVAL '1 millisecond')
          )::text AS rpo_deadline_at,
          CASE WHEN frontier.rpo_anchor_at
            + (${cohortRpoMs} * INTERVAL '1 millisecond')
              <= ${shard.cutoff_at}::timestamptz
            THEN 'active_rpo'
            ELSE 'periodic_capture'
          END AS priority_class,
          CASE WHEN frontier.rpo_anchor_at
            + (${cohortRpoMs} * INTERVAL '1 millisecond')
              <= ${shard.cutoff_at}::timestamptz
            THEN 1
            ELSE 3
          END AS base_priority
        FROM frontier
        ORDER BY frontier.source_due_at, frontier.id
        LIMIT ${limit + 1}
      `,
    );
    const hasMore = candidateRows.length > limit;
    const batchRows = candidateRows.slice(0, limit);
    const cursorBase = requireCohortOrdinalCapacity(shard.cursor_ordinal, batchRows.length);
    const cursorBatch: ScheduleEnrollmentCandidate[] = batchRows.map((candidate, index) => ({
      ...candidate,
      cohort_ordinal: cursorBase + index + 1,
    }));
    const admissibleOrganizations = await lockAdmissibleOrganizations(tx, cursorBatch);
    const batch = cursorBatch.filter(({ organization_id }) =>
      admissibleOrganizations.has(organization_id),
    );
    let enrolled = 0;
    let queued = 0;

    if (batch.length > 0) {
      const candidateValues = sql.join(
        batch.map(
          (candidate) => sql`(
            ${candidate.id}::uuid,
            ${candidate.organization_id}::uuid,
            ${candidate.node_history_id}::uuid,
            ${candidate.activation_generation}::uuid,
            ${candidate.activation_lifecycle_revision}::bigint,
            ${candidate.lifecycle_revision}::bigint,
            ${candidate.activation_node_id}::text,
            ${candidate.activation_container_id}::text,
            ${candidate.source_provider_handle}::text,
            ${candidate.source_image_digest}::text,
            ${candidate.source_rpo_ms}::integer,
            ${candidate.source_due_at}::timestamptz,
            ${candidate.rpo_deadline_at}::timestamptz,
            ${candidate.priority_class}::text,
            ${candidate.base_priority}::smallint,
            ${candidate.cohort_ordinal}::integer
          )`,
        ),
        sql`, `,
      );
      const updated = await sqlRows<{
        id: string;
        organization_id: string;
        node_history_id: string;
        activation_generation: string;
        activation_lifecycle_revision: string;
        source_provider_handle: string;
        activation_container_id: string;
        source_image_digest: string;
        source_rpo_ms: number;
        source_due_at: string;
        rpo_deadline_at: string;
        cohort_ordinal: number;
        priority_class: "active_rpo" | "periodic_capture";
        base_priority: 1 | 3;
      }>(
        tx,
        sql`
          WITH candidate (
            id, organization_id, node_history_id, activation_generation,
            activation_lifecycle_revision, lifecycle_revision,
            activation_node_id, activation_container_id,
            source_provider_handle, source_image_digest, source_rpo_ms,
            source_due_at, rpo_deadline_at,
            priority_class, base_priority, cohort_ordinal
          ) AS (VALUES ${candidateValues})
          UPDATE ${agentSandboxes} AS sandbox
          SET next_backup_at = candidate.source_due_at,
              updated_at = GREATEST(sandbox.updated_at, clock_timestamp())
          FROM candidate
          WHERE sandbox.id = candidate.id
            AND sandbox.organization_id = candidate.organization_id
            AND agent_backup_admission_source_visible(
              sandbox.backup_admission_xid,
              ${shard.snapshot}::pg_snapshot
            )
            AND sandbox.activation_generation = candidate.activation_generation
            AND sandbox.activation_lifecycle_revision = candidate.activation_lifecycle_revision
            AND sandbox.lifecycle_revision = candidate.lifecycle_revision
            AND sandbox.activation_node_id = candidate.activation_node_id
            AND sandbox.activation_container_id = candidate.activation_container_id
            AND sandbox.sandbox_id = candidate.source_provider_handle
            AND sandbox.activation_image_digest = candidate.source_image_digest
            AND GREATEST(
              sandbox.activation_completed_at,
              COALESCE(
                sandbox.backup_schedule_last_protected_at,
                sandbox.activation_completed_at
              )
            ) + (candidate.source_rpo_ms * INTERVAL '1 millisecond')
              = candidate.rpo_deadline_at
            AND LEAST(
              COALESCE(sandbox.next_backup_at, sandbox.activation_completed_at),
              GREATEST(
                sandbox.activation_completed_at,
                COALESCE(
                  sandbox.backup_schedule_last_protected_at,
                  sandbox.activation_completed_at
                )
              ) + (candidate.source_rpo_ms * INTERVAL '1 millisecond')
            ) = candidate.source_due_at
            AND EXISTS (
              SELECT 1
              FROM ${dockerNodes} AS source_node
              JOIN ${agentNodeIncarnationHistories} AS source_occurrence
                ON source_occurrence.id = candidate.node_history_id
                AND source_occurrence.id = source_node.current_node_history_id
                AND source_occurrence.docker_node_record_id = source_node.id
                AND source_occurrence.node_id = source_node.node_id
                AND source_occurrence.node_incarnation = source_node.node_incarnation
                AND source_occurrence.fleet_kind = source_node.fleet_kind
                AND source_occurrence.infrastructure_provider = source_node.infrastructure_provider
                AND source_occurrence.provider_server_id
                  IS NOT DISTINCT FROM source_node.provider_server_id
                AND source_occurrence.host_key_fingerprint = source_node.host_key_fingerprint
              WHERE source_node.node_id = candidate.activation_node_id
                AND agent_backup_admission_source_visible(
                  source_node.backup_admission_xid,
                  ${shard.snapshot}::pg_snapshot
                )
                AND source_node.node_incarnation = sandbox.activation_boot_id
                AND source_node.infrastructure_provider = 'hetzner'
                AND btrim(source_node.host_key_fingerprint) <> ''
            )
          RETURNING sandbox.id,
            candidate.organization_id,
            candidate.node_history_id,
            candidate.activation_generation,
            candidate.activation_lifecycle_revision,
            candidate.source_provider_handle,
            candidate.activation_container_id,
            candidate.source_image_digest,
            candidate.source_rpo_ms,
            candidate.source_due_at::text AS source_due_at,
            candidate.rpo_deadline_at::text AS rpo_deadline_at,
            candidate.priority_class,
            candidate.base_priority,
            candidate.cohort_ordinal
        `,
      );
      enrolled = updated.length;

      if (updated.length > 0) {
        const organizationCursorValues = sql.join(
          [...new Set(updated.map(({ organization_id }) => organization_id))]
            .sort()
            .map((organizationId) => sql`(${organizationId}::uuid)`),
          sql`, `,
        );
        await tx.execute(sql`
          INSERT INTO ${agentBackupOrganizationAdmissionCursors} (organization_id)
          SELECT pending.organization_id
          FROM (VALUES ${organizationCursorValues}) AS pending (organization_id)
          ORDER BY pending.organization_id
          ON CONFLICT DO NOTHING
        `);
        const nodeCursorValues = sql.join(
          [...new Set(updated.map(({ node_history_id }) => node_history_id))]
            .sort()
            .map((nodeHistoryId) => sql`(${nodeHistoryId}::uuid)`),
          sql`, `,
        );
        await tx.execute(sql`
          INSERT INTO ${agentBackupNodeAdmissionCursors} (node_history_id)
          SELECT pending.node_history_id
          FROM (VALUES ${nodeCursorValues}) AS pending (node_history_id)
          ORDER BY pending.node_history_id
          ON CONFLICT DO NOTHING
        `);

        const queueValues = sql.join(
          updated.map(
            (candidate) => sql`(
              ${candidate.organization_id}::uuid,
              ${candidate.id}::uuid,
              ${candidate.node_history_id}::uuid,
              ${candidate.activation_generation}::uuid,
              ${candidate.activation_lifecycle_revision}::bigint,
              ${candidate.source_provider_handle}::text,
              ${candidate.activation_container_id}::text,
              ${candidate.source_image_digest}::text,
              ${candidate.source_rpo_ms}::integer,
              ${candidate.source_due_at}::timestamptz,
              ${candidate.rpo_deadline_at}::timestamptz,
              ${candidate.priority_class}::text,
              ${candidate.base_priority}::smallint,
              ${candidate.cohort_ordinal}::integer
            )`,
          ),
          sql`, `,
        );
        const inserted = await sqlRows<{ id: string }>(
          tx,
          sql`
            INSERT INTO ${agentBackupAdmissionWork} (
              work_kind, work_stage, organization_id, sandbox_id, node_history_id,
              source_activation_generation, source_lifecycle_revision,
              source_provider_handle, source_container_id, source_image_digest,
              source_rpo_ms, requires_node_lane, priority_class, base_priority,
              source_due_at, rpo_deadline_at, state, not_before,
              ready_cohort, cohort_ordinal, shard_id, updated_at
            )
            SELECT 'schedule_capture', 'reserve_capture', queued.organization_id, queued.sandbox_id,
              queued.node_history_id, queued.source_activation_generation,
              queued.source_lifecycle_revision, queued.source_provider_handle,
              queued.source_container_id, queued.source_image_digest,
              queued.source_rpo_ms, TRUE, queued.priority_class, queued.base_priority,
              queued.source_due_at, queued.rpo_deadline_at,
              'queued', queued.source_due_at,
              ${shard.cohort_id}::bigint,
              queued.cohort_ordinal, ${shard.shard_id},
              clock_timestamp()
            FROM (VALUES ${queueValues}) AS queued (
              organization_id, sandbox_id, node_history_id,
              source_activation_generation, source_lifecycle_revision,
              source_provider_handle, source_container_id, source_image_digest,
              source_rpo_ms, source_due_at, rpo_deadline_at,
              priority_class, base_priority, cohort_ordinal
            )
            ON CONFLICT (
              sandbox_id, node_history_id, source_activation_generation,
              source_lifecycle_revision, source_due_at
            )
              WHERE work_kind = 'schedule_capture'
              DO NOTHING
            RETURNING id
          `,
        );
        queued = inserted.length;
      }
    }

    const last = cursorBatch.at(-1);
    const cursorUpdate =
      hasMore && last
        ? sql`
          scan_cursor_due_at = ${last.source_due_at}::timestamptz,
          scan_cursor_id = ${last.id}::uuid,
          scan_cursor_ordinal = ${last.cohort_ordinal}::integer,
        `
        : sql`
          scan_cutoff_at = NULL,
          scan_cursor_due_at = NULL,
          scan_cursor_id = NULL,
          scan_cursor_ordinal = NULL,
          scan_snapshot = NULL,
          scan_schedule_rpo_ms = NULL,
          active_cohort = NULL,
        `;
    const [released] = await sqlRows<{ shard_id: number }>(
      tx,
      sql`
        UPDATE ${agentBackupAdmissionEnrollmentShards}
        SET ${cursorUpdate}
            lease_owner = NULL,
            lease_generation = NULL,
            lease_expires_at = NULL,
            updated_at = ${shard.observed_at}::timestamptz
        WHERE work_kind = 'schedule_capture'
          AND shard_id = ${shard.shard_id}
          AND lease_owner = ${ownerId}
          AND lease_generation = ${leaseGeneration}
          AND lease_expires_at > clock_timestamp()
        RETURNING shard_id
      `,
    );
    if (!released) {
      throw new AgentBackupAdmissionEnrollmentError(
        "Backup admission enrollment shard lease expired before commit",
        "BACKUP_ADMISSION_ENROLLMENT_LEASE_EXPIRED",
      );
    }

    return {
      shardId: shard.shard_id,
      cohortId: shard.cohort_id,
      enrolled,
      queued,
      cohortComplete: !hasMore,
    };
  });
}
