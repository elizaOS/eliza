/**
 * Claims bounded periodic-capture work from durable primary-database shards.
 *
 * Each transaction owns one least-served shard, freezes one database-clock
 * priority cycle, and advances a stable high-water cursor before touching
 * expensive source or lane authorities. The repository never provisions
 * capacity, starts a sandbox, or invokes a provider.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  agentBackupAdmissionClaimShards,
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
  MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
} from "../schemas/agent-backup-admission";
import { agentNodeIncarnationHistories } from "../schemas/agent-node-incarnation-histories";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";
import {
  type AgentBackupAdmissionPrioritizedLaneCandidate,
  selectStrictPriorityLaneBatch,
} from "./agent-backup-admission-claim-matching";
import { requireAgentBackupAdmissionEnrollmentLeaseOwner } from "./agent-backup-admission-enrollment";

export const MAX_AGENT_BACKUP_ADMISSION_CLAIM_BATCH = 100;
export const MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS = 1_000;
export const MAX_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS = 5 * 60_000;
export const MAX_AGENT_BACKUP_ADMISSION_DEFER_MS = 5 * 60_000;
export { MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS };
export const AGENT_BACKUP_ADMISSION_CLAIM_RAW_PAGE = 256;
export const MAX_AGENT_BACKUP_ADMISSION_CLAIM_SCAN_BUDGET =
  4 * AGENT_BACKUP_ADMISSION_CLAIM_RAW_PAGE;
export const DEFAULT_AGENT_BACKUP_ADMISSION_AGING_INTERVAL_MS = 15 * 60_000;

const MAX_AGENT_BACKUP_ADMISSION_NORMALIZATION_SCAN_BUDGET =
  4 * AGENT_BACKUP_ADMISSION_CLAIM_RAW_PAGE;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINAL_SCHEDULE_PRIORITY_PASS = 3;
const ACTIVE_CATALOG_STATES = sql`
  'scheduled', 'capturing', 'captured', 'uploading', 'primary_uploaded',
  'primary_verified', 'secondary_pending', 'failed_retryable'
`;

interface ClaimShardRow {
  shard_id: number | string;
  last_turn: bigint | number | string;
  recovery_start_turn: bigint | number | string | null;
  recovery_cutoff_at: Date | string | null;
  recovery_cursor_at: Date | string | null;
  recovery_cursor_state: number | string | null;
  recovery_cursor_id: string | null;
  last_recovery_claim_cycle_start_turn: bigint | number | string | null;
  cycle_start_turn: bigint | number | string | null;
  cycle_observed_at: Date | string | null;
  cycle_observed_at_rank: bigint | number | string | null;
  cycle_max_cohort: bigint | number | string | null;
  cycle_max_ordinal: number | string | null;
  cycle_max_id: string | null;
  cycle_aging_interval_ms: number | string | null;
  priority_pass: number | string | null;
  scan_cursor_cohort: bigint | number | string | null;
  scan_cursor_ordinal: number | string | null;
  scan_cursor_id: string | null;
  last_admitted_work_id: string | null;
  last_admission_proof_turn: bigint | number | string | null;
}

interface ScheduleRecoveryCycle {
  shardId: number;
  startTurn: string;
  cutoffAt: string;
  cursorAt: string | null;
  cursorState: 0 | 1 | null;
  cursorId: string | null;
}

interface ScheduleClaimCycle {
  shardId: number;
  lastTurn: string;
  cycleStartTurn: string;
  observedAt: string;
  observedAtRank: string;
  maxCohort: string;
  maxOrdinal: number;
  maxId: string;
  agingIntervalMs: number;
  priorityPass: number;
  cursorCohort: string | null;
  cursorOrdinal: number | null;
  cursorId: string | null;
  lastAdmittedWorkId: string | null;
  lastAdmissionProofTurn: string | null;
}

interface LockedScheduleClaimShard {
  shardId: number;
  lastTurn: string;
  recovery: ScheduleRecoveryCycle | null;
  lastRecoveryClaimCycleStartTurn: string | null;
  cycle: ScheduleClaimCycle | null;
}

interface RawScheduleKey {
  id: string;
  organization_id: string;
  ready_cohort: bigint | number | string;
  cohort_ordinal: number | string;
}

interface ScheduleRecoveryKey {
  id: string;
  organization_id: string;
  recovery_at: Date | string;
  recovery_state: number | string;
}

interface LockedScheduleCandidateRow extends RawScheduleKey {
  work_kind: "schedule_capture";
  shard_id: number | string;
  sandbox_id: string;
  node_history_id: string;
  source_activation_generation: string;
  source_lifecycle_revision: bigint | number | string;
  source_provider_handle: string;
  source_container_id: string;
  source_image_digest: string;
  source_rpo_ms: number | string;
  source_due_at: Date | string;
  rpo_deadline_at: Date | string;
  first_eligible_at: Date | string;
  first_eligible_rank: string;
  not_before: Date | string;
  not_before_rank: string;
  attempts: number | string;
  effective_priority: number | string;
  claim_cycle_start_turn: bigint | number | string | null;
  claim_proof_turn: bigint | number | string | null;
  claim_proof_xid: string | null;
  claim_proof_priority_pass: number | string | null;
  claim_proof_attempt: number | string | null;
}

interface LockedScheduleCandidate extends AgentBackupAdmissionPrioritizedLaneCandidate {
  sandboxId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: string;
  sourceProviderHandle: string;
  sourceContainerId: string;
  sourceImageDigest: string;
  sourceRpoMs: number;
  sourceDueAt: Date;
  rpoDeadlineAt: Date;
  firstEligibleAt: Date;
  notBefore: Date;
  notBeforeAuthority: string;
  notBeforeRank: string;
  firstEligibleRank: string;
  attempts: number;
  readyCohort: string;
  cohortOrdinal: number;
  effectivePriority: number;
  organizationCursorRank: string | null;
  nodeCursorRank: string | null;
  previousClaimCycleStartTurn: string | null;
  previousClaimProofTurn: string | null;
  previousClaimProofXid: string | null;
  previousClaimProofPriorityPass: number | null;
  previousClaimProofAttempt: number | null;
}

interface SourceCandidate extends LockedScheduleCandidate {
  nodeRecordId: string;
}

export interface AgentBackupAdmissionClaim {
  workId: string;
  organizationId: string;
  sandboxId: string;
  nodeHistoryId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: string;
  sourceProviderHandle: string;
  sourceContainerId: string;
  sourceImageDigest: string;
  sourceRpoMs: number;
  sourceDueAt: Date;
  rpoDeadlineAt: Date;
  firstEligibleAt: Date;
  effectivePriority: number;
  ownerId: string;
  generation: string;
  expiresAt: Date;
  /** One-based durable attempt component of the lease fence. */
  workAttempt: number;
  /** Trigger-owned identity of the frozen claim cycle that admitted this work. */
  claimCycleStartTurn: string;
  /** Trigger-owned monotonic proof for this exact queued-to-leased transition. */
  claimProofTurn: string;
  /** Primary-database transaction identity that minted the admission proof. */
  claimProofXid: string;
  /** Frozen effective-priority pass proven by the admission trigger. */
  claimProofPriorityPass: number;
}

/**
 * Authoritative outcome of one bounded claim transaction.
 *
 * An empty claim array alone cannot distinguish durable shard/cycle progress
 * from a truly empty queue or from every eligible shard being row-locked by a
 * concurrent claimant. Callers must use this outcome to decide whether another
 * turn can make progress without manufacturing a magic empty-turn threshold.
 */
export type AgentBackupAdmissionClaimTurnOutcome = "claimed" | "progressed" | "contended" | "idle";

export type AgentBackupAdmissionClaimTurn =
  | {
      outcome: "claimed";
      claims: [AgentBackupAdmissionClaim, ...AgentBackupAdmissionClaim[]];
    }
  | {
      outcome: Exclude<AgentBackupAdmissionClaimTurnOutcome, "claimed">;
      claims: [];
    };

export type AgentBackupAdmissionFence = Pick<
  AgentBackupAdmissionClaim,
  | "workId"
  | "ownerId"
  | "generation"
  | "workAttempt"
  | "claimCycleStartTurn"
  | "claimProofTurn"
  | "claimProofXid"
  | "claimProofPriorityPass"
>;

export type AgentBackupAdmissionDeferResult = "deferred" | "retry_exhausted" | null;

type AgentBackupAdmissionClaimFailureCode =
  | "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT"
  | "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID"
  | "BACKUP_ADMISSION_CLAIM_LEASE_FAILED"
  | "BACKUP_ADMISSION_CLAIM_PRIMARY_CLOCK_UNAVAILABLE";

/** A fail-closed durable claim invariant failure. */
export class AgentBackupAdmissionClaimError extends ElizaError {
  override readonly name = "AgentBackupAdmissionClaimError";

  constructor(message: string, code: AgentBackupAdmissionClaimFailureCode) {
    super(message, {
      code,
      context: { operation: "schedule-capture-claim" },
      severity: "ephemeral",
    });
  }
}

function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireLeaseOwner(value: string): string {
  return requireAgentBackupAdmissionEnrollmentLeaseOwner(value);
}

function requireReason(value: string, field: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(value)) {
    throw new Error(`${field} must be a bounded canonical reason`);
  }
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

function requireDatabaseDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AgentBackupAdmissionClaimError(
      `${field} is not a valid primary-database timestamp`,
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  return date;
}

function requireDatabaseTimestampText(value: Date | string, field: string): string {
  const date = requireDatabaseDate(value, field);
  return typeof value === "string" ? value : date.toISOString();
}

function requireSafeDatabaseInteger(value: number | string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AgentBackupAdmissionClaimError(
      `${field} is not a non-negative safe integer`,
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  return parsed;
}

function requireDatabaseBigint(value: bigint | number | string, field: string): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new AgentBackupAdmissionClaimError(
      `${field} is not a non-negative database bigint`,
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  return text;
}

function requirePositiveDatabaseBigint(value: bigint | number | string, field: string): string {
  const text = requireDatabaseBigint(value, field);
  if (text === "0") {
    throw new AgentBackupAdmissionClaimError(
      `${field} must be positive`,
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  return text;
}

function requireFence(fence: AgentBackupAdmissionFence): AgentBackupAdmissionFence {
  requireUuid(fence.workId, "fence.workId");
  requireLeaseOwner(fence.ownerId);
  requireUuid(fence.generation, "fence.generation");
  requireBoundedInteger({
    value: fence.workAttempt,
    field: "fence.workAttempt",
    min: 1,
    max: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
  });
  requirePositiveDatabaseBigint(fence.claimCycleStartTurn, "fence.claimCycleStartTurn");
  requirePositiveDatabaseBigint(fence.claimProofTurn, "fence.claimProofTurn");
  requirePositiveDatabaseBigint(fence.claimProofXid, "fence.claimProofXid");
  requireBoundedInteger({
    value: fence.claimProofPriorityPass,
    field: "fence.claimProofPriorityPass",
    min: 0,
    max: FINAL_SCHEDULE_PRIORITY_PASS,
  });
  return fence;
}

function requireScheduleRecoveryAuthority(
  row: ClaimShardRow,
  shardId: number,
  lastTurn: string,
): {
  recovery: ScheduleRecoveryCycle | null;
  lastRecoveryClaimCycleStartTurn: string | null;
} {
  const lastRecoveryClaimCycleStartTurn =
    row.last_recovery_claim_cycle_start_turn === null
      ? null
      : requirePositiveDatabaseBigint(
          row.last_recovery_claim_cycle_start_turn,
          "last recovery claim cycle start turn",
        );
  if (
    lastRecoveryClaimCycleStartTurn !== null &&
    BigInt(lastRecoveryClaimCycleStartTurn) > BigInt(lastTurn)
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery marker is ahead of its shard turn",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }

  if (row.recovery_cutoff_at === null) {
    if (
      row.recovery_start_turn !== null ||
      row.recovery_cursor_at !== null ||
      row.recovery_cursor_state !== null ||
      row.recovery_cursor_id !== null
    ) {
      throw new AgentBackupAdmissionClaimError(
        "Idle backup admission recovery authority retains active fields",
        "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
      );
    }
    return { recovery: null, lastRecoveryClaimCycleStartTurn };
  }
  if (row.recovery_start_turn === null) {
    throw new AgentBackupAdmissionClaimError(
      "Active backup admission recovery authority has no start turn",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const startTurn = requirePositiveDatabaseBigint(row.recovery_start_turn, "recovery start turn");
  if (BigInt(startTurn) > BigInt(lastTurn)) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery starts after its shard turn",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const cursorIsNull = row.recovery_cursor_at === null;
  if (
    cursorIsNull !== (row.recovery_cursor_state === null) ||
    cursorIsNull !== (row.recovery_cursor_id === null)
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery authority has a partial cursor",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const cutoffAt = requireDatabaseTimestampText(row.recovery_cutoff_at, "recovery cutoff");
  if (cursorIsNull) {
    return {
      recovery: {
        shardId,
        startTurn,
        cutoffAt,
        cursorAt: null,
        cursorState: null,
        cursorId: null,
      },
      lastRecoveryClaimCycleStartTurn,
    };
  }
  const rawCursorAt = row.recovery_cursor_at;
  const rawCursorId = row.recovery_cursor_id;
  if (rawCursorAt === null || rawCursorId === null) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery cursor lost its exact key",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const cursorAt = requireDatabaseTimestampText(rawCursorAt, "recovery cursor");
  if (
    requireDatabaseDate(cursorAt, "recovery cursor") >
    requireDatabaseDate(cutoffAt, "recovery cutoff")
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery cursor is beyond its frozen cutoff",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const cursorState = requireBoundedInteger({
    value: Number(row.recovery_cursor_state),
    field: "recovery cursor state",
    min: 0,
    max: 1,
  }) as 0 | 1;
  return {
    recovery: {
      shardId,
      startTurn,
      cutoffAt,
      cursorAt,
      cursorState,
      cursorId: requireUuid(rawCursorId, "recovery cursor id"),
    },
    lastRecoveryClaimCycleStartTurn,
  };
}

function requireClaimShard(row: ClaimShardRow): LockedScheduleClaimShard {
  const shardId = requireBoundedInteger({
    value: Number(row.shard_id),
    field: "claim shard id",
    min: 0,
    max: 63,
  });
  const lastTurn = requireDatabaseBigint(row.last_turn, "claim shard last turn");
  const recoveryAuthority = requireScheduleRecoveryAuthority(row, shardId, lastTurn);
  if (row.cycle_observed_at === null) {
    if (
      row.cycle_start_turn !== null ||
      row.cycle_observed_at_rank !== null ||
      row.cycle_max_cohort !== null ||
      row.cycle_max_ordinal !== null ||
      row.cycle_max_id !== null ||
      row.cycle_aging_interval_ms !== null ||
      row.priority_pass !== null ||
      row.scan_cursor_cohort !== null ||
      row.scan_cursor_ordinal !== null ||
      row.scan_cursor_id !== null ||
      row.last_admitted_work_id !== null ||
      row.last_admission_proof_turn !== null
    ) {
      throw new AgentBackupAdmissionClaimError(
        "Idle backup admission claim shard retains active cycle fields",
        "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
      );
    }
    return { shardId, lastTurn, ...recoveryAuthority, cycle: null };
  }
  if (
    row.cycle_start_turn === null ||
    row.cycle_observed_at_rank === null ||
    row.cycle_max_cohort === null ||
    row.cycle_max_ordinal === null ||
    row.cycle_max_id === null ||
    row.cycle_aging_interval_ms === null ||
    row.priority_pass === null
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Active backup admission claim shard is incomplete",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const cursorIsNull = row.scan_cursor_id === null;
  if (
    cursorIsNull !== (row.scan_cursor_cohort === null) ||
    cursorIsNull !== (row.scan_cursor_ordinal === null)
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim shard has a partial cursor",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const maxId = requireUuid(row.cycle_max_id, "claim cycle max id");
  const cursorId =
    row.scan_cursor_id === null ? null : requireUuid(row.scan_cursor_id, "claim cycle cursor id");
  const lastAdmittedWorkId =
    row.last_admitted_work_id === null
      ? null
      : requireUuid(row.last_admitted_work_id, "claim cycle last admitted work id");
  const lastAdmissionProofTurn =
    row.last_admission_proof_turn === null
      ? null
      : requirePositiveDatabaseBigint(
          row.last_admission_proof_turn,
          "claim cycle last admission proof turn",
        );
  if ((lastAdmittedWorkId === null) !== (lastAdmissionProofTurn === null)) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim shard has a partial restart proof",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const cycleStartTurn = requirePositiveDatabaseBigint(
    row.cycle_start_turn,
    "claim cycle start turn",
  );
  if (BigInt(cycleStartTurn) > BigInt(lastTurn)) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim cycle starts after its latest turn",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  if (
    lastAdmissionProofTurn !== null &&
    (BigInt(lastAdmissionProofTurn) <= BigInt(cycleStartTurn) ||
      BigInt(lastAdmissionProofTurn) >= BigInt(lastTurn))
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim restart proof is outside its cycle turn fence",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  return {
    shardId,
    lastTurn,
    ...recoveryAuthority,
    cycle: {
      shardId,
      lastTurn,
      cycleStartTurn,
      observedAt: requireDatabaseTimestampText(row.cycle_observed_at, "claim cycle observedAt"),
      observedAtRank: requireDatabaseBigint(
        row.cycle_observed_at_rank,
        "claim cycle observedAt rank",
      ),
      maxCohort: requireDatabaseBigint(row.cycle_max_cohort, "claim cycle max cohort"),
      maxOrdinal: requireSafeDatabaseInteger(row.cycle_max_ordinal, "claim cycle max ordinal"),
      maxId,
      agingIntervalMs: requireBoundedInteger({
        value: Number(row.cycle_aging_interval_ms),
        field: "claim cycle aging interval",
        min: 60_000,
        max: 24 * 60 * 60_000,
      }),
      priorityPass: requireBoundedInteger({
        value: Number(row.priority_pass),
        field: "claim cycle priority pass",
        min: 0,
        max: FINAL_SCHEDULE_PRIORITY_PASS,
      }),
      cursorCohort:
        row.scan_cursor_cohort === null
          ? null
          : requireDatabaseBigint(row.scan_cursor_cohort, "claim cycle cursor cohort"),
      cursorOrdinal:
        row.scan_cursor_ordinal === null
          ? null
          : requireSafeDatabaseInteger(row.scan_cursor_ordinal, "claim cycle cursor ordinal"),
      cursorId,
      lastAdmittedWorkId,
      lastAdmissionProofTurn,
    },
  };
}

/** Exact activation and append-only node occurrence frozen by enrollment. */
function exactScheduleSourceSql(): ReturnType<typeof sql> {
  return sql`EXISTS (
    SELECT 1
    FROM ${agentSandboxes} AS source_sandbox
    JOIN ${agentNodeIncarnationHistories} AS source_history
      ON source_history.id = work.node_history_id
    JOIN ${dockerNodes} AS source_node
      ON source_node.id = source_history.docker_node_record_id
      AND source_node.node_id = source_history.node_id
      AND source_node.node_incarnation = source_history.node_incarnation
      AND source_node.current_node_history_id = source_history.id
      AND source_node.fleet_kind = source_history.fleet_kind
      AND source_node.infrastructure_provider = source_history.infrastructure_provider
      AND source_node.provider_server_id IS NOT DISTINCT FROM source_history.provider_server_id
      AND source_node.host_key_fingerprint = source_history.host_key_fingerprint
    WHERE source_sandbox.id = work.sandbox_id
      AND source_sandbox.organization_id = work.organization_id
      AND source_sandbox.status = 'running'
      AND source_sandbox.pool_status IS NULL
      AND source_sandbox.execution_tier IN ('dedicated-lazy', 'dedicated-always', 'custom')
      AND source_sandbox.deleted_at IS NULL
      AND source_sandbox.deletion_attempt_id IS NULL
      AND source_sandbox.activation_phase = 'active'
      AND source_sandbox.activation_generation = work.source_activation_generation
      AND source_sandbox.activation_lifecycle_revision = work.source_lifecycle_revision
      AND source_sandbox.lifecycle_revision = work.source_lifecycle_revision
      AND source_sandbox.sandbox_id = work.source_provider_handle
      AND source_sandbox.activation_container_id = work.source_container_id
      AND source_sandbox.activation_image_digest = work.source_image_digest
      AND source_sandbox.image_digest = work.source_image_digest
      AND source_sandbox.activation_node_id = source_node.node_id
      AND source_sandbox.node_id = source_node.node_id
      AND source_sandbox.activation_boot_id = source_node.node_incarnation
      AND source_sandbox.next_backup_at = work.source_due_at
      AND source_sandbox.activation_authority_published_at IS NOT NULL
      AND source_sandbox.activation_dispatched_at IS NOT NULL
      AND source_sandbox.activation_completed_at IS NOT NULL
      AND source_node.infrastructure_provider = 'hetzner'
      AND btrim(source_node.host_key_fingerprint) <> ''
      AND (
        (source_node.fleet_kind = 'robot' AND source_node.provider_server_id IS NULL)
        OR (source_node.fleet_kind = 'cloud' AND source_node.provider_server_id IS NOT NULL)
      )
  )`;
}

/** Existing catalogue work owns the tenant lane and capturing owns the occurrence lane. */
function catalogueLanesAvailableSql(): ReturnType<typeof sql> {
  return sql`(
    NOT EXISTS (
      SELECT 1
      FROM ${agentSandboxBackups} AS active_backup
      WHERE active_backup.catalog_organization_id = work.organization_id
        AND active_backup.catalog_state IN (${ACTIVE_CATALOG_STATES})
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${agentSandboxBackups} AS active_backup
      JOIN ${agentNodeIncarnationHistories} AS work_history
        ON work_history.id = work.node_history_id
      WHERE (
          active_backup.source_node_history_id = work.node_history_id
          OR (
            active_backup.source_node_history_id IS NULL
            AND active_backup.source_node_record_id = work_history.docker_node_record_id
            AND active_backup.source_node_incarnation = work_history.node_incarnation
          )
        )
        AND (
          active_backup.catalog_state IN ('scheduled', 'capturing')
          OR (
            active_backup.catalog_state = 'failed_retryable'
            AND active_backup.catalog_resume_state IN ('scheduled', 'capturing')
          )
        )
    )
  )`;
}

function queueLanesAvailableSql(): ReturnType<typeof sql> {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${agentBackupAdmissionWork} AS active_work
    WHERE active_work.state = 'leased'
      AND active_work.id <> work.id
      AND (
        active_work.organization_id = work.organization_id
        OR active_work.node_history_id = work.node_history_id
      )
  )`;
}

function scheduleClaimShardReadySql(): ReturnType<typeof sql> {
  return sql`(
    claim_shard.recovery_cutoff_at IS NOT NULL
    OR claim_shard.cycle_observed_at IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM ${agentBackupAdmissionWork} AS pending
      WHERE pending.work_kind = 'schedule_capture'
        AND pending.shard_id = claim_shard.shard_id
        AND pending.state = 'queued'
    )
    OR EXISTS (
      SELECT 1
      FROM ${agentBackupAdmissionWork} AS pending_deferred
      WHERE pending_deferred.work_kind = 'schedule_capture'
        AND pending_deferred.shard_id = claim_shard.shard_id
        AND pending_deferred.state = 'deferred'
        AND pending_deferred.not_before <= clock_timestamp()
    )
    OR EXISTS (
      SELECT 1
      FROM ${agentBackupAdmissionWork} AS pending_expired
      WHERE pending_expired.work_kind = 'schedule_capture'
        AND pending_expired.shard_id = claim_shard.shard_id
        AND pending_expired.state = 'leased'
        AND pending_expired.lease_expires_at <= clock_timestamp()
    )
  )`;
}

async function readPrimaryClock(tx: DbTransaction): Promise<string> {
  const [clock] = await sqlRows<{ at: string }>(tx, sql`SELECT clock_timestamp()::text AS at`);
  if (!clock) {
    throw new AgentBackupAdmissionClaimError(
      "Primary database clock is unavailable",
      "BACKUP_ADMISSION_CLAIM_PRIMARY_CLOCK_UNAVAILABLE",
    );
  }
  return requireDatabaseTimestampText(clock.at, "claim transaction observedAt");
}

async function lockLeastServedScheduleClaimShard(
  tx: DbTransaction,
): Promise<LockedScheduleClaimShard | null> {
  const [row] = await sqlRows<ClaimShardRow>(
    tx,
    sql`SELECT claim_shard.shard_id, claim_shard.last_turn,
        claim_shard.recovery_start_turn,
        claim_shard.recovery_cutoff_at::text AS recovery_cutoff_at,
        claim_shard.recovery_cursor_at::text AS recovery_cursor_at,
        claim_shard.recovery_cursor_state, claim_shard.recovery_cursor_id,
        claim_shard.last_recovery_claim_cycle_start_turn,
        claim_shard.cycle_start_turn,
        claim_shard.cycle_observed_at::text AS cycle_observed_at,
        CASE WHEN claim_shard.cycle_observed_at IS NULL THEN NULL
          ELSE (EXTRACT(EPOCH FROM claim_shard.cycle_observed_at) * 1000000)::bigint::text
        END AS cycle_observed_at_rank,
        claim_shard.cycle_max_cohort,
        claim_shard.cycle_max_ordinal, claim_shard.cycle_max_id,
        claim_shard.cycle_aging_interval_ms, claim_shard.priority_pass,
        claim_shard.scan_cursor_cohort, claim_shard.scan_cursor_ordinal,
        claim_shard.scan_cursor_id,
        claim_shard.last_admitted_work_id,
        claim_shard.last_admission_proof_turn
      FROM ${agentBackupAdmissionClaimShards} AS claim_shard
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND ${scheduleClaimShardReadySql()}
      ORDER BY claim_shard.last_turn, claim_shard.shard_id
      FOR UPDATE OF claim_shard SKIP LOCKED
      LIMIT 1`,
  );
  return row ? requireClaimShard(row) : null;
}

async function scheduleClaimWorkRemains(tx: DbTransaction): Promise<boolean> {
  const [row] = await sqlRows<{ work_remains: boolean }>(
    tx,
    sql`SELECT EXISTS (
        SELECT 1
        FROM ${agentBackupAdmissionClaimShards} AS claim_shard
        WHERE claim_shard.work_kind = 'schedule_capture'
          AND ${scheduleClaimShardReadySql()}
      ) AS work_remains`,
  );
  if (!row || typeof row.work_remains !== "boolean") {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission could not prove whether claim work remains",
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  return row.work_remains;
}

async function startScheduleRecoveryCycle(
  tx: DbTransaction,
  lockedShard: LockedScheduleClaimShard,
): Promise<boolean> {
  if (lockedShard.recovery !== null) return false;
  const cycleStartTurn = lockedShard.cycle?.cycleStartTurn ?? null;
  const [started] = await sqlRows<{ shard_id: number }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          recovery_start_turn = NULL,
          recovery_cutoff_at = statement_timestamp(),
          recovery_cursor_at = NULL,
          recovery_cursor_state = NULL,
          recovery_cursor_id = NULL,
          updated_at = statement_timestamp()
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND claim_shard.shard_id = ${lockedShard.shardId}
        AND claim_shard.last_turn = ${lockedShard.lastTurn}::bigint
        AND claim_shard.recovery_start_turn IS NULL
        AND claim_shard.recovery_cutoff_at IS NULL
        AND claim_shard.recovery_cursor_at IS NULL
        AND claim_shard.recovery_cursor_state IS NULL
        AND claim_shard.recovery_cursor_id IS NULL
        AND claim_shard.cycle_start_turn IS NOT DISTINCT FROM ${cycleStartTurn}::bigint
        AND claim_shard.last_recovery_claim_cycle_start_turn IS NOT DISTINCT FROM
          ${lockedShard.lastRecoveryClaimCycleStartTurn}::bigint
        AND (
          (claim_shard.cycle_observed_at IS NULL AND NOT EXISTS (
            SELECT 1
            FROM ${agentBackupAdmissionWork} AS queued
            WHERE queued.work_kind = 'schedule_capture'
              AND queued.shard_id = claim_shard.shard_id
              AND queued.state = 'queued'
          ))
          OR (claim_shard.cycle_observed_at IS NOT NULL
            AND claim_shard.cycle_start_turn IS NOT NULL
            AND claim_shard.last_recovery_claim_cycle_start_turn IS DISTINCT FROM
              claim_shard.cycle_start_turn)
        )
        AND (
          EXISTS (
            SELECT 1
            FROM ${agentBackupAdmissionWork} AS ready_deferred
            WHERE ready_deferred.work_kind = 'schedule_capture'
              AND ready_deferred.shard_id = claim_shard.shard_id
              AND ready_deferred.state = 'deferred'
              AND ready_deferred.not_before <= statement_timestamp()
          )
          OR EXISTS (
            SELECT 1
            FROM ${agentBackupAdmissionWork} AS expired_lease
            WHERE expired_lease.work_kind = 'schedule_capture'
              AND expired_lease.shard_id = claim_shard.shard_id
              AND expired_lease.state = 'leased'
              AND expired_lease.lease_expires_at <= statement_timestamp()
          )
        )
      RETURNING claim_shard.shard_id`,
  );
  return started !== undefined;
}

function scheduleRecoveryCursorPredicate(
  recovery: ScheduleRecoveryCycle,
  recoveryState: 0 | 1,
): ReturnType<typeof sql> {
  if (recovery.cursorAt === null) return sql``;
  if (recovery.cursorState === null || recovery.cursorId === null) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery cursor is incomplete",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  if (recoveryState === 0) {
    return recovery.cursorState === 0
      ? sql`AND (work.not_before, work.id) > (
          ${recovery.cursorAt}::timestamptz, ${recovery.cursorId}::uuid
        )`
      : sql`AND work.not_before > ${recovery.cursorAt}::timestamptz`;
  }
  return recovery.cursorState === 0
    ? sql`AND work.lease_expires_at >= ${recovery.cursorAt}::timestamptz`
    : sql`AND (work.lease_expires_at, work.id) > (
        ${recovery.cursorAt}::timestamptz, ${recovery.cursorId}::uuid
      )`;
}

async function readScheduleRecoveryPage(
  tx: DbTransaction,
  recovery: ScheduleRecoveryCycle,
): Promise<ScheduleRecoveryKey[]> {
  const deferredCursor = scheduleRecoveryCursorPredicate(recovery, 0);
  const expiredCursor = scheduleRecoveryCursorPredicate(recovery, 1);
  return sqlRows<ScheduleRecoveryKey>(
    tx,
    sql`WITH deferred_keys AS MATERIALIZED (
        SELECT work.id, work.organization_id, work.not_before AS recovery_at,
          0::smallint AS recovery_state
        FROM ${agentBackupAdmissionWork} AS work
        WHERE work.work_kind = 'schedule_capture'
          AND work.shard_id = ${recovery.shardId}
          AND work.state = 'deferred'
          AND work.not_before <= ${recovery.cutoffAt}::timestamptz
          ${deferredCursor}
        ORDER BY work.not_before, work.id
        LIMIT ${MAX_AGENT_BACKUP_ADMISSION_NORMALIZATION_SCAN_BUDGET}
      ),
      expired_keys AS MATERIALIZED (
        SELECT work.id, work.organization_id, work.lease_expires_at AS recovery_at,
          1::smallint AS recovery_state
        FROM ${agentBackupAdmissionWork} AS work
        WHERE work.work_kind = 'schedule_capture'
          AND work.shard_id = ${recovery.shardId}
          AND work.state = 'leased'
          AND work.lease_expires_at <= ${recovery.cutoffAt}::timestamptz
          ${expiredCursor}
        ORDER BY work.lease_expires_at, work.id
        LIMIT ${MAX_AGENT_BACKUP_ADMISSION_NORMALIZATION_SCAN_BUDGET}
      ),
      merged_keys AS MATERIALIZED (
        SELECT * FROM deferred_keys
        UNION ALL
        SELECT * FROM expired_keys
      )
      SELECT id, organization_id, recovery_at::text AS recovery_at, recovery_state
      FROM merged_keys AS merged
      ORDER BY merged.recovery_at, merged.recovery_state, merged.id
      LIMIT ${MAX_AGENT_BACKUP_ADMISSION_NORMALIZATION_SCAN_BUDGET}`,
  );
}

function exactScheduleRecoveryAuthoritySql(
  lockedShard: LockedScheduleClaimShard,
  recovery: ScheduleRecoveryCycle,
): ReturnType<typeof sql> {
  return sql`claim_shard.work_kind = 'schedule_capture'
    AND claim_shard.shard_id = ${lockedShard.shardId}
    AND claim_shard.last_turn = ${lockedShard.lastTurn}::bigint
    AND claim_shard.recovery_start_turn = ${recovery.startTurn}::bigint
    AND claim_shard.recovery_cutoff_at = ${recovery.cutoffAt}::timestamptz
    AND claim_shard.recovery_cursor_at IS NOT DISTINCT FROM ${recovery.cursorAt}::timestamptz
    AND claim_shard.recovery_cursor_state IS NOT DISTINCT FROM ${recovery.cursorState}::smallint
    AND claim_shard.recovery_cursor_id IS NOT DISTINCT FROM ${recovery.cursorId}::uuid
    AND claim_shard.last_recovery_claim_cycle_start_turn IS NOT DISTINCT FROM
      ${lockedShard.lastRecoveryClaimCycleStartTurn}::bigint`;
}

async function advanceScheduleRecoveryCursor(params: {
  tx: DbTransaction;
  lockedShard: LockedScheduleClaimShard;
  recovery: ScheduleRecoveryCycle;
  key: ScheduleRecoveryKey;
}): Promise<void> {
  const cursorAt = requireDatabaseTimestampText(params.key.recovery_at, "recovery cursor");
  const cursorState = requireBoundedInteger({
    value: Number(params.key.recovery_state),
    field: "recovery cursor state",
    min: 0,
    max: 1,
  });
  const cursorId = requireUuid(params.key.id, "recovery cursor id");
  const [advanced] = await sqlRows<{ shard_id: number }>(
    params.tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          recovery_cursor_at = ${cursorAt}::timestamptz,
          recovery_cursor_state = ${cursorState},
          recovery_cursor_id = ${cursorId}::uuid,
          updated_at = clock_timestamp()
      WHERE ${exactScheduleRecoveryAuthoritySql(params.lockedShard, params.recovery)}
      RETURNING claim_shard.shard_id`,
  );
  if (!advanced) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery cursor could not advance",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
}

async function finishScheduleRecoveryCycle(
  tx: DbTransaction,
  lockedShard: LockedScheduleClaimShard,
  recovery: ScheduleRecoveryCycle,
): Promise<void> {
  const [finished] = await sqlRows<{ shard_id: number }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          recovery_start_turn = NULL,
          recovery_cutoff_at = NULL,
          recovery_cursor_at = NULL,
          recovery_cursor_state = NULL,
          recovery_cursor_id = NULL,
          last_recovery_claim_cycle_start_turn = COALESCE(
            claim_shard.cycle_start_turn,
            claim_shard.last_recovery_claim_cycle_start_turn
          ),
          updated_at = clock_timestamp()
      WHERE ${exactScheduleRecoveryAuthoritySql(lockedShard, recovery)}
      RETURNING claim_shard.shard_id`,
  );
  if (!finished) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery cycle could not finish",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
}

async function normalizeOneReadyScheduleRecoveryWindow(
  tx: DbTransaction,
  lockedShard: LockedScheduleClaimShard,
  recovery: ScheduleRecoveryCycle,
): Promise<void> {
  const rawKeys = await readScheduleRecoveryPage(tx, recovery);
  if (rawKeys.length === 0) {
    await finishScheduleRecoveryCycle(tx, lockedShard, recovery);
    return;
  }

  for (const key of rawKeys) {
    requireUuid(key.id, "recovery work id");
    requireUuid(key.organization_id, "recovery organization id");
    requireDatabaseTimestampText(key.recovery_at, "recovery ordering instant");
    requireBoundedInteger({
      value: Number(key.recovery_state),
      field: "recovery ordering state",
      min: 0,
      max: 1,
    });
  }
  const organizationIds = [
    ...new Set(rawKeys.map(({ organization_id }) => organization_id)),
  ].sort();
  const lockedOrganizations = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT account_org.id
      FROM ${organizations} AS account_org
      WHERE account_org.id IN (${sql.join(
        organizationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY account_org.id
      FOR SHARE OF account_org SKIP LOCKED`,
  );
  const lockedOrganizationIds = new Set(lockedOrganizations.map(({ id }) => id));
  const recoverableIds = rawKeys
    .filter(({ organization_id }) => lockedOrganizationIds.has(organization_id))
    .map(({ id }) => id);

  if (recoverableIds.length > 0) {
    await sqlRows<{ id: string }>(
      tx,
      sql`WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at),
      locked AS MATERIALIZED (
        SELECT work.id, work.state, work.not_before, work.deferred_reason,
          work.ready_cohort, work.cohort_ordinal, work.lease_owner,
          work.lease_generation, work.lease_expires_at, work.attempts,
          work.claim_cycle_start_turn, work.claim_proof_turn,
          work.claim_proof_xid, work.claim_proof_priority_pass,
          work.claim_proof_attempt
        FROM ${agentBackupAdmissionWork} AS work
        WHERE work.id IN (${sql.join(
          recoverableIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND work.work_kind = 'schedule_capture'
          AND work.shard_id = ${recovery.shardId}
          AND (
            (work.state = 'deferred'
              AND work.not_before <= ${recovery.cutoffAt}::timestamptz)
            OR (work.state = 'leased'
              AND work.lease_expires_at <= ${recovery.cutoffAt}::timestamptz)
          )
        ORDER BY work.id
        FOR UPDATE OF work SKIP LOCKED
      )
      UPDATE ${agentBackupAdmissionWork} AS work
      SET state = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN 'settled'
            ELSE 'queued'
          END,
          deferred_reason = NULL,
          lease_owner = NULL,
          lease_generation = NULL,
          lease_expires_at = NULL,
          ready_cohort = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN work.ready_cohort
            ELSE nextval('agent_backup_admission_cohort_seq')
          END,
          cohort_ordinal = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN work.cohort_ordinal
            ELSE 0
          END,
          settled_at = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN observed.at
            ELSE NULL
          END,
          settled_reason = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN 'RETRY_EXHAUSTED'
            ELSE NULL
          END,
          updated_at = observed.at
      FROM locked, observed
      WHERE work.id = locked.id
        AND work.state = locked.state
        AND work.not_before IS NOT DISTINCT FROM locked.not_before
        AND work.deferred_reason IS NOT DISTINCT FROM locked.deferred_reason
        AND work.ready_cohort = locked.ready_cohort
        AND work.cohort_ordinal = locked.cohort_ordinal
        AND work.lease_owner IS NOT DISTINCT FROM locked.lease_owner
        AND work.lease_generation IS NOT DISTINCT FROM locked.lease_generation
        AND work.lease_expires_at IS NOT DISTINCT FROM locked.lease_expires_at
        AND work.attempts = locked.attempts
        AND work.claim_cycle_start_turn IS NOT DISTINCT FROM locked.claim_cycle_start_turn
        AND work.claim_proof_turn IS NOT DISTINCT FROM locked.claim_proof_turn
        AND work.claim_proof_xid IS NOT DISTINCT FROM locked.claim_proof_xid
        AND work.claim_proof_priority_pass IS NOT DISTINCT FROM
          locked.claim_proof_priority_pass
        AND work.claim_proof_attempt IS NOT DISTINCT FROM locked.claim_proof_attempt
      RETURNING work.id`,
    );
  }

  const lastKey = rawKeys.at(-1);
  if (!lastKey) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission recovery page lost its final cursor key",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  await advanceScheduleRecoveryCursor({ tx, lockedShard, recovery, key: lastKey });
}

async function advanceIdleShardTurn(
  tx: DbTransaction,
  lockedShard: LockedScheduleClaimShard,
): Promise<void> {
  const [updated] = await sqlRows<{ shard_id: number }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          updated_at = clock_timestamp()
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND claim_shard.shard_id = ${lockedShard.shardId}
        AND claim_shard.last_turn = ${lockedShard.lastTurn}::bigint
        AND claim_shard.cycle_observed_at IS NULL
        AND claim_shard.cycle_start_turn IS NULL
        AND claim_shard.last_admitted_work_id IS NULL
        AND claim_shard.last_admission_proof_turn IS NULL
      RETURNING claim_shard.shard_id`,
  );
  if (!updated) {
    throw new AgentBackupAdmissionClaimError(
      "Idle backup admission claim shard could not advance",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
}

async function startScheduleClaimCycle(params: {
  tx: DbTransaction;
  lockedShard: LockedScheduleClaimShard;
}): Promise<ScheduleClaimCycle | null> {
  if (params.lockedShard.cycle !== null) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission cannot start over an active claim cycle",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const [highWater] = await sqlRows<{
    ready_cohort: bigint | number | string;
    cohort_ordinal: number | string;
    id: string;
  }>(
    params.tx,
    sql`SELECT work.ready_cohort, work.cohort_ordinal, work.id
      FROM ${agentBackupAdmissionWork} AS work
      WHERE work.work_kind = 'schedule_capture'
        AND work.shard_id = ${params.lockedShard.shardId}
        AND work.state = 'queued'
      ORDER BY work.ready_cohort DESC, work.cohort_ordinal DESC, work.id DESC
      LIMIT 1`,
  );
  if (!highWater) {
    await advanceIdleShardTurn(params.tx, params.lockedShard);
    return null;
  }
  const maxCohort = requireDatabaseBigint(highWater.ready_cohort, "claim high-water cohort");
  const maxOrdinal = requireSafeDatabaseInteger(
    highWater.cohort_ordinal,
    "claim high-water ordinal",
  );
  const maxId = requireUuid(highWater.id, "claim high-water id");
  const [updated] = await sqlRows<ClaimShardRow>(
    params.tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          cycle_observed_at = statement_timestamp(),
          cycle_max_cohort = ${maxCohort}::bigint,
          cycle_max_ordinal = ${maxOrdinal},
          cycle_max_id = ${maxId}::uuid,
          cycle_aging_interval_ms = ${DEFAULT_AGENT_BACKUP_ADMISSION_AGING_INTERVAL_MS},
          priority_pass = 0,
          scan_cursor_cohort = NULL,
          scan_cursor_ordinal = NULL,
          scan_cursor_id = NULL,
          last_admitted_work_id = NULL,
          last_admission_proof_turn = NULL,
          updated_at = statement_timestamp()
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND claim_shard.shard_id = ${params.lockedShard.shardId}
        AND claim_shard.last_turn = ${params.lockedShard.lastTurn}::bigint
        AND claim_shard.cycle_observed_at IS NULL
        AND claim_shard.cycle_start_turn IS NULL
        AND claim_shard.last_admitted_work_id IS NULL
        AND claim_shard.last_admission_proof_turn IS NULL
      RETURNING claim_shard.shard_id, claim_shard.last_turn,
        claim_shard.recovery_start_turn,
        claim_shard.recovery_cutoff_at::text AS recovery_cutoff_at,
        claim_shard.recovery_cursor_at::text AS recovery_cursor_at,
        claim_shard.recovery_cursor_state, claim_shard.recovery_cursor_id,
        claim_shard.last_recovery_claim_cycle_start_turn,
        claim_shard.cycle_start_turn,
        claim_shard.cycle_observed_at::text AS cycle_observed_at,
        (EXTRACT(EPOCH FROM claim_shard.cycle_observed_at) * 1000000)::bigint::text
          AS cycle_observed_at_rank,
        claim_shard.cycle_max_cohort, claim_shard.cycle_max_ordinal,
        claim_shard.cycle_max_id, claim_shard.cycle_aging_interval_ms,
        claim_shard.priority_pass, claim_shard.scan_cursor_cohort,
        claim_shard.scan_cursor_ordinal, claim_shard.scan_cursor_id,
        claim_shard.last_admitted_work_id,
        claim_shard.last_admission_proof_turn`,
  );
  if (!updated) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim cycle could not start",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  const started = requireClaimShard(updated);
  if (!started.cycle) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim cycle trigger returned an idle authority",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  return started.cycle;
}

function cycleAtHighWater(cycle: ScheduleClaimCycle): boolean {
  return (
    cycle.cursorCohort === cycle.maxCohort &&
    cycle.cursorOrdinal === cycle.maxOrdinal &&
    cycle.cursorId === cycle.maxId
  );
}

function exactScheduleClaimCycleAuthoritySql(cycle: ScheduleClaimCycle): ReturnType<typeof sql> {
  return sql`claim_shard.work_kind = 'schedule_capture'
    AND claim_shard.shard_id = ${cycle.shardId}
    AND claim_shard.last_turn = ${cycle.lastTurn}::bigint
    AND claim_shard.cycle_start_turn = ${cycle.cycleStartTurn}::bigint
    AND claim_shard.cycle_observed_at = ${cycle.observedAt}::timestamptz
    AND claim_shard.cycle_max_cohort = ${cycle.maxCohort}::bigint
    AND claim_shard.cycle_max_ordinal = ${cycle.maxOrdinal}
    AND claim_shard.cycle_max_id = ${cycle.maxId}::uuid
    AND claim_shard.cycle_aging_interval_ms = ${cycle.agingIntervalMs}
    AND claim_shard.priority_pass = ${cycle.priorityPass}
    AND claim_shard.scan_cursor_cohort IS NOT DISTINCT FROM ${cycle.cursorCohort}::bigint
    AND claim_shard.scan_cursor_ordinal IS NOT DISTINCT FROM ${cycle.cursorOrdinal}::integer
    AND claim_shard.scan_cursor_id IS NOT DISTINCT FROM ${cycle.cursorId}::uuid
    AND claim_shard.last_admitted_work_id IS NOT DISTINCT FROM
      ${cycle.lastAdmittedWorkId}::uuid
    AND claim_shard.last_admission_proof_turn IS NOT DISTINCT FROM
      ${cycle.lastAdmissionProofTurn}::bigint`;
}

async function updateScheduleClaimCursor(
  tx: DbTransaction,
  cycle: ScheduleClaimCycle,
  key: RawScheduleKey,
): Promise<ScheduleClaimCycle> {
  const cursorCohort = requireDatabaseBigint(key.ready_cohort, "claim cursor cohort");
  const cursorOrdinal = requireSafeDatabaseInteger(key.cohort_ordinal, "claim cursor ordinal");
  const cursorId = requireUuid(key.id, "claim cursor id");
  const [updated] = await sqlRows<{ last_turn: bigint | number | string }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          scan_cursor_cohort = ${cursorCohort}::bigint,
          scan_cursor_ordinal = ${cursorOrdinal},
          scan_cursor_id = ${cursorId}::uuid,
          updated_at = clock_timestamp()
      WHERE ${exactScheduleClaimCycleAuthoritySql(cycle)}
      RETURNING claim_shard.last_turn`,
  );
  if (!updated) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim cursor could not advance",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  return {
    ...cycle,
    lastTurn: requireDatabaseBigint(updated.last_turn, "claim cursor turn"),
    cursorCohort,
    cursorOrdinal,
    cursorId,
  };
}

async function markScheduleClaimHighWater(
  tx: DbTransaction,
  cycle: ScheduleClaimCycle,
): Promise<ScheduleClaimCycle> {
  return updateScheduleClaimCursor(tx, cycle, {
    id: cycle.maxId,
    organization_id: "",
    ready_cohort: cycle.maxCohort,
    cohort_ordinal: cycle.maxOrdinal,
  });
}

async function advanceSchedulePriorityPass(
  tx: DbTransaction,
  cycle: ScheduleClaimCycle,
): Promise<ScheduleClaimCycle> {
  const nextPass = cycle.priorityPass + 1;
  const [updated] = await sqlRows<{ last_turn: bigint | number | string }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          priority_pass = ${nextPass},
          scan_cursor_cohort = NULL,
          scan_cursor_ordinal = NULL,
          scan_cursor_id = NULL,
          updated_at = clock_timestamp()
      WHERE ${exactScheduleClaimCycleAuthoritySql(cycle)}
      RETURNING claim_shard.last_turn`,
  );
  if (!updated) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission priority pass could not advance",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
  return {
    ...cycle,
    lastTurn: requireDatabaseBigint(updated.last_turn, "claim priority pass turn"),
    priorityPass: nextPass,
    cursorCohort: null,
    cursorOrdinal: null,
    cursorId: null,
  };
}

async function finishScheduleClaimCycle(
  tx: DbTransaction,
  cycle: ScheduleClaimCycle,
): Promise<void> {
  const [updated] = await sqlRows<{ shard_id: number }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          cycle_observed_at = NULL,
          cycle_max_cohort = NULL,
          cycle_max_ordinal = NULL,
          cycle_max_id = NULL,
          cycle_aging_interval_ms = NULL,
          priority_pass = NULL,
          scan_cursor_cohort = NULL,
          scan_cursor_ordinal = NULL,
          scan_cursor_id = NULL,
          last_admitted_work_id = NULL,
          last_admission_proof_turn = NULL,
          updated_at = clock_timestamp()
      WHERE ${exactScheduleClaimCycleAuthoritySql(cycle)}
      RETURNING claim_shard.shard_id`,
  );
  if (!updated) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission claim cycle could not finish",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
}

interface ScheduleAdmissionProof {
  workId: string;
  cycleStartTurn: string;
  proofTurn: string;
  proofXid: string;
  priorityPass: number;
  attempt: number;
}

async function restartActiveScheduleClaimCycleAfterAdmission(
  tx: DbTransaction,
  cycle: ScheduleClaimCycle,
  proof: ScheduleAdmissionProof,
): Promise<void> {
  requireUuid(proof.workId, "admission proof work id");
  requirePositiveDatabaseBigint(proof.cycleStartTurn, "admission proof cycle start turn");
  requirePositiveDatabaseBigint(proof.proofTurn, "admission proof turn");
  requirePositiveDatabaseBigint(proof.proofXid, "admission proof xid");
  requireBoundedInteger({
    value: proof.priorityPass,
    field: "admission proof priority pass",
    min: 0,
    max: FINAL_SCHEDULE_PRIORITY_PASS,
  });
  requireBoundedInteger({
    value: proof.attempt,
    field: "admission proof attempt",
    min: 1,
    max: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
  });
  if (
    proof.cycleStartTurn !== cycle.cycleStartTurn ||
    proof.priorityPass !== cycle.priorityPass ||
    BigInt(proof.proofTurn) <= BigInt(cycle.lastTurn)
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission proof does not fence the exact current cycle turn",
      "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
    );
  }
  const [updated] = await sqlRows<{ shard_id: number }>(
    tx,
    sql`UPDATE ${agentBackupAdmissionClaimShards} AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          priority_pass = 0,
          scan_cursor_cohort = NULL,
          scan_cursor_ordinal = NULL,
          scan_cursor_id = NULL,
          last_admitted_work_id = ${proof.workId}::uuid,
          last_admission_proof_turn = ${proof.proofTurn}::bigint,
          updated_at = clock_timestamp()
      WHERE ${exactScheduleClaimCycleAuthoritySql(cycle)}
      RETURNING claim_shard.shard_id`,
  );
  if (!updated) {
    throw new AgentBackupAdmissionClaimError(
      "Active backup admission cycle could not restart after admission",
      "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
    );
  }
}

async function readRawSchedulePage(params: {
  tx: DbTransaction;
  cycle: ScheduleClaimCycle;
  limit: number;
}): Promise<RawScheduleKey[]> {
  const cursorPredicate =
    params.cycle.cursorId === null
      ? sql``
      : sql`AND (work.ready_cohort, work.cohort_ordinal, work.id) > (
          ${params.cycle.cursorCohort}::bigint,
          ${params.cycle.cursorOrdinal}::integer,
          ${params.cycle.cursorId}::uuid
        )`;
  return sqlRows<RawScheduleKey>(
    params.tx,
    sql`WITH raw_keys AS MATERIALIZED (
        SELECT work.id, work.organization_id, work.ready_cohort, work.cohort_ordinal
        FROM ${agentBackupAdmissionWork} AS work
        WHERE work.work_kind = 'schedule_capture'
          AND work.shard_id = ${params.cycle.shardId}
          AND work.state = 'queued'
          ${cursorPredicate}
          AND (work.ready_cohort, work.cohort_ordinal, work.id) <= (
            ${params.cycle.maxCohort}::bigint,
            ${params.cycle.maxOrdinal}::integer,
            ${params.cycle.maxId}::uuid
          )
        ORDER BY work.ready_cohort, work.cohort_ordinal, work.id
        LIMIT ${params.limit}
      )
      SELECT id, organization_id, ready_cohort, cohort_ordinal
      FROM raw_keys
      ORDER BY ready_cohort, cohort_ordinal, id`,
  );
}

async function lockAdmissibleOrganizations(
  tx: DbTransaction,
  rawKeys: readonly RawScheduleKey[],
): Promise<Set<string>> {
  const organizationIds = [
    ...new Set(rawKeys.map(({ organization_id }) => organization_id)),
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
      FOR SHARE OF account_org SKIP LOCKED`,
  );
  return new Set(rows.map(({ id }) => id));
}

async function lockRawScheduleWork(params: {
  tx: DbTransaction;
  cycle: ScheduleClaimCycle;
  rawKeys: readonly RawScheduleKey[];
  admissibleOrganizations: ReadonlySet<string>;
}): Promise<LockedScheduleCandidate[]> {
  const ids = params.rawKeys
    .filter(({ organization_id }) => params.admissibleOrganizations.has(organization_id))
    .map(({ id }) => id);
  if (ids.length === 0) return [];
  const rows = await sqlRows<LockedScheduleCandidateRow>(
    params.tx,
    sql`SELECT work.id, work.work_kind, work.shard_id,
        work.organization_id, work.sandbox_id,
        work.node_history_id, work.source_activation_generation,
        work.source_lifecycle_revision, work.source_provider_handle,
        work.source_container_id, work.source_image_digest, work.source_rpo_ms,
        work.source_due_at, work.rpo_deadline_at, work.first_eligible_at,
        (EXTRACT(EPOCH FROM work.first_eligible_at) * 1000000)::bigint::text
          AS first_eligible_rank,
        work.not_before::text AS not_before,
        (EXTRACT(EPOCH FROM work.not_before) * 1000000)::bigint::text
          AS not_before_rank,
        work.attempts, work.ready_cohort, work.cohort_ordinal,
        agent_backup_admission_effective_priority(
          work.base_priority,
          work.first_eligible_at,
          ${params.cycle.observedAt}::timestamptz,
          ${params.cycle.agingIntervalMs}
        )::integer AS effective_priority,
        work.claim_cycle_start_turn, work.claim_proof_turn,
        work.claim_proof_xid::text AS claim_proof_xid,
        work.claim_proof_priority_pass, work.claim_proof_attempt
      FROM ${agentBackupAdmissionWork} AS work
      WHERE work.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND work.work_kind = 'schedule_capture'
        AND work.work_stage = 'reserve_capture'
        AND work.shard_id = ${params.cycle.shardId}
        AND work.state = 'queued'
        AND work.not_before <= ${params.cycle.observedAt}::timestamptz
        AND work.source_due_at <= ${params.cycle.observedAt}::timestamptz
      ORDER BY work.id
      FOR UPDATE OF work SKIP LOCKED`,
  );
  return rows.map((row) => {
    if (row.work_kind !== "schedule_capture") {
      throw new AgentBackupAdmissionClaimError(
        "Locked backup admission work belongs to another work kind",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
    const shardId = requireBoundedInteger({
      value: Number(row.shard_id),
      field: "claim work shard id",
      min: 0,
      max: 63,
    });
    if (shardId !== params.cycle.shardId) {
      throw new AgentBackupAdmissionClaimError(
        "Locked backup admission work belongs to another shard",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
    const attempts = requireSafeDatabaseInteger(row.attempts, "claim attempts");
    const proofFields = [
      row.claim_cycle_start_turn,
      row.claim_proof_turn,
      row.claim_proof_xid,
      row.claim_proof_priority_pass,
      row.claim_proof_attempt,
    ];
    const proofFieldCount = proofFields.filter((value) => value !== null).length;
    if ((attempts === 0 && proofFieldCount !== 0) || (attempts > 0 && proofFieldCount !== 5)) {
      throw new AgentBackupAdmissionClaimError(
        "Locked backup admission work has a partial claim proof",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
    if (row.claim_proof_attempt !== null && Number(row.claim_proof_attempt) !== attempts) {
      throw new AgentBackupAdmissionClaimError(
        "Locked backup admission work proof does not fence its latest attempt",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
    const sandboxId = requireUuid(row.sandbox_id, "claim sandbox id");
    const notBeforeAuthority = requireDatabaseTimestampText(row.not_before, "claim notBefore");
    return {
      id: requireUuid(row.id, "claim work id"),
      workKind: "schedule_capture",
      shardSourceId: sandboxId,
      shardId,
      organizationId: requireUuid(row.organization_id, "claim organization id"),
      sandboxId,
      nodeHistoryId: requireUuid(row.node_history_id, "claim node history id"),
      sourceActivationGeneration: requireUuid(
        row.source_activation_generation,
        "claim source activation generation",
      ),
      sourceLifecycleRevision: requireDatabaseBigint(
        row.source_lifecycle_revision,
        "claim source lifecycle revision",
      ),
      sourceProviderHandle: row.source_provider_handle,
      sourceContainerId: row.source_container_id,
      sourceImageDigest: row.source_image_digest,
      sourceRpoMs: requireSafeDatabaseInteger(row.source_rpo_ms, "claim source RPO"),
      sourceDueAt: requireDatabaseDate(row.source_due_at, "claim source dueAt"),
      rpoDeadlineAt: requireDatabaseDate(row.rpo_deadline_at, "claim RPO deadline"),
      firstEligibleAt: requireDatabaseDate(row.first_eligible_at, "claim first eligibleAt"),
      firstEligibleRank: requireDatabaseBigint(
        row.first_eligible_rank,
        "claim first eligible rank",
      ),
      notBefore: requireDatabaseDate(row.not_before, "claim notBefore"),
      notBeforeAuthority,
      notBeforeRank: requireDatabaseBigint(row.not_before_rank, "claim notBefore rank"),
      attempts,
      readyCohort: requireDatabaseBigint(row.ready_cohort, "claim ready cohort"),
      cohortOrdinal: requireSafeDatabaseInteger(row.cohort_ordinal, "claim cohort ordinal"),
      effectivePriority: requireSafeDatabaseInteger(
        row.effective_priority,
        "claim effective priority",
      ),
      organizationCursorRank: null,
      nodeCursorRank: null,
      previousClaimCycleStartTurn:
        row.claim_cycle_start_turn === null
          ? null
          : requirePositiveDatabaseBigint(
              row.claim_cycle_start_turn,
              "previous claim cycle start turn",
            ),
      previousClaimProofTurn:
        row.claim_proof_turn === null
          ? null
          : requirePositiveDatabaseBigint(row.claim_proof_turn, "previous claim proof turn"),
      previousClaimProofXid:
        row.claim_proof_xid === null
          ? null
          : requirePositiveDatabaseBigint(row.claim_proof_xid, "previous claim proof xid"),
      previousClaimProofPriorityPass:
        row.claim_proof_priority_pass === null
          ? null
          : requireBoundedInteger({
              value: Number(row.claim_proof_priority_pass),
              field: "previous claim proof priority pass",
              min: 0,
              max: FINAL_SCHEDULE_PRIORITY_PASS,
            }),
      previousClaimProofAttempt:
        row.claim_proof_attempt === null
          ? null
          : requireBoundedInteger({
              value: Number(row.claim_proof_attempt),
              field: "previous claim proof attempt",
              min: 1,
              max: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
            }),
    };
  });
}

function exactQueuedScheduleCandidateAuthoritySql(
  candidate: LockedScheduleCandidate,
): ReturnType<typeof sql> {
  return sql`work.id = ${candidate.id}::uuid
    AND work.work_kind = 'schedule_capture'
    AND work.work_stage = 'reserve_capture'
    AND work.shard_id = ${candidate.shardId}
    AND work.organization_id = ${candidate.organizationId}::uuid
    AND work.sandbox_id = ${candidate.sandboxId}::uuid
    AND work.node_history_id = ${candidate.nodeHistoryId}::uuid
    AND work.source_activation_generation = ${candidate.sourceActivationGeneration}::uuid
    AND work.source_lifecycle_revision = ${candidate.sourceLifecycleRevision}::bigint
    AND work.source_provider_handle = ${candidate.sourceProviderHandle}
    AND work.source_container_id = ${candidate.sourceContainerId}
    AND work.source_image_digest = ${candidate.sourceImageDigest}
    AND work.source_rpo_ms = ${candidate.sourceRpoMs}
    AND work.state = 'queued'
    AND work.not_before = ${candidate.notBeforeAuthority}::timestamptz
    AND work.deferred_reason IS NULL
    AND work.ready_cohort = ${candidate.readyCohort}::bigint
    AND work.cohort_ordinal = ${candidate.cohortOrdinal}
    AND work.lease_owner IS NULL
    AND work.lease_generation IS NULL
    AND work.lease_expires_at IS NULL
    AND work.attempts = ${candidate.attempts}
    AND work.claim_cycle_start_turn IS NOT DISTINCT FROM
      ${candidate.previousClaimCycleStartTurn}::bigint
    AND work.claim_proof_turn IS NOT DISTINCT FROM ${candidate.previousClaimProofTurn}::bigint
    AND work.claim_proof_xid::text IS NOT DISTINCT FROM ${candidate.previousClaimProofXid}::text
    AND work.claim_proof_priority_pass IS NOT DISTINCT FROM
      ${candidate.previousClaimProofPriorityPass}::smallint
    AND work.claim_proof_attempt IS NOT DISTINCT FROM
      ${candidate.previousClaimProofAttempt}::integer
    AND work.settled_at IS NULL
    AND work.settled_reason IS NULL`;
}

async function settleRetryExhaustedScheduleWork(
  tx: DbTransaction,
  candidates: readonly LockedScheduleCandidate[],
  observedAt: string,
): Promise<LockedScheduleCandidate[]> {
  const exhausted = candidates.filter(
    ({ attempts }) => attempts >= MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
  );
  if (exhausted.length > 0) {
    const settled = await sqlRows<{ id: string }>(
      tx,
      sql`UPDATE ${agentBackupAdmissionWork} AS work
      SET state = 'settled',
          deferred_reason = NULL,
          lease_owner = NULL,
          lease_generation = NULL,
          lease_expires_at = NULL,
          settled_at = ${observedAt},
          settled_reason = 'RETRY_EXHAUSTED',
          updated_at = ${observedAt}
      WHERE (${sql.join(
        exhausted.map((candidate) => exactQueuedScheduleCandidateAuthoritySql(candidate)),
        sql`) OR (`,
      )})
        AND work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS}
      RETURNING work.id`,
    );
    if (settled.length !== exhausted.length) {
      throw new AgentBackupAdmissionClaimError(
        "Retry-exhausted backup admission work lost its locked CAS authority",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
  }
  return candidates.filter(({ attempts }) => attempts < MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS);
}

function filterSchedulePriorityPass(
  candidates: readonly LockedScheduleCandidate[],
  cycle: ScheduleClaimCycle,
): LockedScheduleCandidate[] {
  return candidates.filter((candidate) => candidate.effectivePriority === cycle.priorityPass);
}

async function requireExistingLaneAuthorities(
  tx: DbTransaction,
  candidates: readonly LockedScheduleCandidate[],
): Promise<void> {
  const organizationIds = [
    ...new Set(candidates.map(({ organizationId }) => organizationId)),
  ].sort();
  const nodeHistoryIds = [...new Set(candidates.map(({ nodeHistoryId }) => nodeHistoryId))].sort();
  const organizationRows = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT organization_id AS id
      FROM ${agentBackupOrganizationAdmissionCursors}
      WHERE organization_id IN (${sql.join(
        organizationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
  );
  const nodeRows = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT node_history_id AS id
      FROM ${agentBackupNodeAdmissionCursors}
      WHERE node_history_id IN (${sql.join(
        nodeHistoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
  );
  if (
    organizationRows.length !== organizationIds.length ||
    nodeRows.length !== nodeHistoryIds.length
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission lane authority is missing",
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
}

async function lockLaneAuthorities(
  tx: DbTransaction,
  candidates: readonly LockedScheduleCandidate[],
): Promise<LockedScheduleCandidate[]> {
  if (candidates.length === 0) return [];
  await requireExistingLaneAuthorities(tx, candidates);
  const organizationIds = [
    ...new Set(candidates.map(({ organizationId }) => organizationId)),
  ].sort();
  const nodeHistoryIds = [...new Set(candidates.map(({ nodeHistoryId }) => nodeHistoryId))].sort();
  const lockedOrganizations = await sqlRows<{ id: string; cursor_rank: string | null }>(
    tx,
    sql`SELECT organization_id AS id,
        CASE WHEN cursor_at IS NULL THEN NULL
          ELSE (EXTRACT(EPOCH FROM cursor_at) * 1000000)::bigint::text
        END AS cursor_rank
      FROM ${agentBackupOrganizationAdmissionCursors}
      WHERE organization_id IN (${sql.join(
        organizationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY organization_id
      FOR UPDATE SKIP LOCKED`,
  );
  const lockedNodes = await sqlRows<{ id: string; cursor_rank: string | null }>(
    tx,
    sql`SELECT node_history_id AS id,
        CASE WHEN cursor_at IS NULL THEN NULL
          ELSE (EXTRACT(EPOCH FROM cursor_at) * 1000000)::bigint::text
        END AS cursor_rank
      FROM ${agentBackupNodeAdmissionCursors}
      WHERE node_history_id IN (${sql.join(
        nodeHistoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY node_history_id
      FOR UPDATE SKIP LOCKED`,
  );
  const organizationCursor = new Map(
    lockedOrganizations.map(({ id, cursor_rank }) => [id, cursor_rank]),
  );
  const nodeCursor = new Map(lockedNodes.map(({ id, cursor_rank }) => [id, cursor_rank]));
  return candidates
    .filter(
      ({ organizationId, nodeHistoryId }) =>
        organizationCursor.has(organizationId) && nodeCursor.has(nodeHistoryId),
    )
    .map((candidate) => ({
      ...candidate,
      organizationCursorRank: organizationCursor.get(candidate.organizationId) ?? null,
      nodeCursorRank: nodeCursor.get(candidate.nodeHistoryId) ?? null,
    }));
}

async function lockAndRevalidateScheduleSources(
  tx: DbTransaction,
  candidates: readonly LockedScheduleCandidate[],
  observedAt: string,
): Promise<LockedScheduleCandidate[]> {
  if (candidates.length === 0) return [];
  const nodeHistoryIds = [...new Set(candidates.map(({ nodeHistoryId }) => nodeHistoryId))];
  const histories = await sqlRows<{ id: string; node_record_id: string }>(
    tx,
    sql`SELECT history.id, history.docker_node_record_id AS node_record_id
      FROM ${agentNodeIncarnationHistories} AS history
      WHERE history.id IN (${sql.join(
        nodeHistoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
  );
  const nodeRecordByHistory = new Map(
    histories.map(({ id, node_record_id }) => [id, node_record_id]),
  );
  if (nodeRecordByHistory.size !== nodeHistoryIds.length) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission source occurrence authority is missing",
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  const sourceCandidates: SourceCandidate[] = candidates.map((candidate) => {
    const nodeRecordId = nodeRecordByHistory.get(candidate.nodeHistoryId);
    if (!nodeRecordId) {
      throw new AgentBackupAdmissionClaimError(
        "Backup admission source occurrence lost its node authority",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
    return { ...candidate, nodeRecordId };
  });
  const sandboxIds = [...new Set(sourceCandidates.map(({ sandboxId }) => sandboxId))].sort();
  const sourceNodeRecordIds = [
    ...new Set(sourceCandidates.map(({ nodeRecordId }) => nodeRecordId)),
  ].sort();
  const existingSandboxes = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT source_sandbox.id
      FROM ${agentSandboxes} AS source_sandbox
      WHERE source_sandbox.id IN (${sql.join(
        sandboxIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
  );
  const existingNodes = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT source_node.id
      FROM ${dockerNodes} AS source_node
      WHERE source_node.id IN (${sql.join(
        sourceNodeRecordIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
  );
  const existingSandboxIds = new Set(existingSandboxes.map(({ id }) => id));
  const existingNodeIds = new Set(existingNodes.map(({ id }) => id));
  const missingSource = sourceCandidates.filter(
    ({ sandboxId, nodeRecordId }) =>
      !existingSandboxIds.has(sandboxId) || !existingNodeIds.has(nodeRecordId),
  );
  if (missingSource.length > 0) {
    const settled = await sqlRows<{ id: string }>(
      tx,
      sql`UPDATE ${agentBackupAdmissionWork} AS work
      SET state = 'settled',
          deferred_reason = NULL,
          lease_owner = NULL,
          lease_generation = NULL,
          lease_expires_at = NULL,
          settled_at = ${observedAt},
          settled_reason = 'SOURCE_SUPERSEDED',
          updated_at = ${observedAt}
      WHERE (${sql.join(
        missingSource.map((candidate) => exactQueuedScheduleCandidateAuthoritySql(candidate)),
        sql`) OR (`,
      )})
      RETURNING work.id`,
    );
    if (settled.length !== missingSource.length) {
      throw new AgentBackupAdmissionClaimError(
        "Missing-source backup admission work lost its locked CAS authority",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
  }
  const presentSourceCandidates = sourceCandidates.filter(
    ({ sandboxId, nodeRecordId }) =>
      existingSandboxIds.has(sandboxId) && existingNodeIds.has(nodeRecordId),
  );
  if (presentSourceCandidates.length === 0) return [];
  const presentSandboxIds = [
    ...new Set(presentSourceCandidates.map(({ sandboxId }) => sandboxId)),
  ].sort();
  const lockedSandboxes = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT source_sandbox.id
      FROM ${agentSandboxes} AS source_sandbox
      WHERE source_sandbox.id IN (${sql.join(
        presentSandboxIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY source_sandbox.id
      FOR NO KEY UPDATE OF source_sandbox SKIP LOCKED`,
  );
  const sandboxSet = new Set(lockedSandboxes.map(({ id }) => id));
  const nodeRecordIds = [
    ...new Set(
      presentSourceCandidates
        .filter(({ sandboxId }) => sandboxSet.has(sandboxId))
        .map(({ nodeRecordId }) => nodeRecordId),
    ),
  ].sort();
  if (nodeRecordIds.length === 0) return [];
  const lockedNodes = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT source_node.id
      FROM ${dockerNodes} AS source_node
      WHERE source_node.id IN (${sql.join(
        nodeRecordIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY source_node.id
      FOR NO KEY UPDATE OF source_node SKIP LOCKED`,
  );
  const nodeSet = new Set(lockedNodes.map(({ id }) => id));
  const fullyLocked = presentSourceCandidates.filter(
    ({ sandboxId, nodeRecordId }) => sandboxSet.has(sandboxId) && nodeSet.has(nodeRecordId),
  );
  if (fullyLocked.length === 0) return [];
  const validRows = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT work.id
      FROM ${agentBackupAdmissionWork} AS work
      WHERE work.id IN (${sql.join(
        fullyLocked.map(({ id }) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND work.state = 'queued'
        AND ${exactScheduleSourceSql()}
      ORDER BY work.id`,
  );
  const validIds = new Set(validRows.map(({ id }) => id));
  const stale = fullyLocked.filter(({ id }) => !validIds.has(id));
  if (stale.length > 0) {
    const settled = await sqlRows<{ id: string }>(
      tx,
      sql`UPDATE ${agentBackupAdmissionWork} AS work
      SET state = 'settled',
          deferred_reason = NULL,
          lease_owner = NULL,
          lease_generation = NULL,
          lease_expires_at = NULL,
          settled_at = ${observedAt},
          settled_reason = 'SOURCE_SUPERSEDED',
          updated_at = ${observedAt}
      WHERE (${sql.join(
        stale.map((candidate) => exactQueuedScheduleCandidateAuthoritySql(candidate)),
        sql`) OR (`,
      )})
      RETURNING work.id`,
    );
    if (settled.length !== stale.length) {
      throw new AgentBackupAdmissionClaimError(
        "Stale-source backup admission work lost its locked CAS authority",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
  }
  return fullyLocked.filter(({ id }) => validIds.has(id));
}

async function filterAvailableScheduleLanes(
  tx: DbTransaction,
  candidates: readonly LockedScheduleCandidate[],
): Promise<LockedScheduleCandidate[]> {
  if (candidates.length === 0) return [];
  const valid = await sqlRows<{ id: string }>(
    tx,
    sql`SELECT work.id
      FROM ${agentBackupAdmissionWork} AS work
      WHERE work.id IN (${sql.join(
        candidates.map(({ id }) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND work.state = 'queued'
        AND ${queueLanesAvailableSql()}
        AND ${catalogueLanesAvailableSql()}
      ORDER BY work.id`,
  );
  const validIds = new Set(valid.map(({ id }) => id));
  return candidates.filter(({ id }) => validIds.has(id));
}

function compareNullableCursorRank(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  const leftRank = BigInt(left);
  const rightRank = BigInt(right);
  if (leftRank < rightRank) return -1;
  if (leftRank > rightRank) return 1;
  return 0;
}

function greatestCursorRank(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return BigInt(left) >= BigInt(right) ? left : right;
}

function leastCursorRank(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  return BigInt(left) <= BigInt(right) ? left : right;
}

function compareScheduleCandidateRank(
  left: LockedScheduleCandidate,
  right: LockedScheduleCandidate,
): number {
  const priority = left.effectivePriority - right.effectivePriority;
  if (priority !== 0) return priority;
  const greatest = compareNullableCursorRank(
    greatestCursorRank(left.organizationCursorRank, left.nodeCursorRank),
    greatestCursorRank(right.organizationCursorRank, right.nodeCursorRank),
  );
  if (greatest !== 0) return greatest;
  const least = compareNullableCursorRank(
    leastCursorRank(left.organizationCursorRank, left.nodeCursorRank),
    leastCursorRank(right.organizationCursorRank, right.nodeCursorRank),
  );
  if (least !== 0) return least;
  const eligible = BigInt(left.firstEligibleRank) - BigInt(right.firstEligibleRank);
  if (eligible !== 0n) return eligible < 0n ? -1 : 1;
  const cohort = BigInt(left.readyCohort) - BigInt(right.readyCohort);
  if (cohort !== 0n) return cohort < 0n ? -1 : 1;
  const ordinal = left.cohortOrdinal - right.cohortOrdinal;
  if (ordinal !== 0) return ordinal;
  return left.id.localeCompare(right.id);
}

async function advanceClaimedLaneCursors(
  tx: DbTransaction,
  claimed: readonly LockedScheduleCandidate[],
): Promise<void> {
  if (claimed.length === 0) return;
  const organizationIds = [...new Set(claimed.map(({ organizationId }) => organizationId))];
  const nodeHistoryIds = [...new Set(claimed.map(({ nodeHistoryId }) => nodeHistoryId))];
  const [turn] = await sqlRows<{ cursor_at: string }>(
    tx,
    sql`SELECT GREATEST(
        clock_timestamp(),
        COALESCE(MAX(lane.cursor_at), '-infinity'::timestamptz) + INTERVAL '1 microsecond'
      )::text AS cursor_at
      FROM (
        SELECT cursor_at
        FROM ${agentBackupOrganizationAdmissionCursors}
        WHERE organization_id IN (${sql.join(
          organizationIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        UNION ALL
        SELECT cursor_at
        FROM ${agentBackupNodeAdmissionCursors}
        WHERE node_history_id IN (${sql.join(
          nodeHistoryIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      ) AS lane`,
  );
  if (!turn) {
    throw new AgentBackupAdmissionClaimError(
      "Primary database could not produce a backup admission lane turn",
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  const organizationsAdvanced = await sqlRows<{ id: string }>(
    tx,
    sql`UPDATE ${agentBackupOrganizationAdmissionCursors}
      SET cursor_at = ${turn.cursor_at}::timestamptz,
          updated_at = ${turn.cursor_at}::timestamptz
      WHERE organization_id IN (${sql.join(
        organizationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      RETURNING organization_id AS id`,
  );
  const nodesAdvanced = await sqlRows<{ id: string }>(
    tx,
    sql`UPDATE ${agentBackupNodeAdmissionCursors}
      SET cursor_at = ${turn.cursor_at}::timestamptz,
          updated_at = ${turn.cursor_at}::timestamptz
      WHERE node_history_id IN (${sql.join(
        nodeHistoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      RETURNING node_history_id AS id`,
  );
  if (
    organizationsAdvanced.length !== organizationIds.length ||
    nodesAdvanced.length !== nodeHistoryIds.length
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission did not advance every locked lane",
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
}

async function leaseScheduleCandidates(params: {
  tx: DbTransaction;
  cycle: ScheduleClaimCycle;
  candidates: readonly LockedScheduleCandidate[];
  ownerId: string;
  generation: string;
  leaseMs: number;
}): Promise<AgentBackupAdmissionClaim[]> {
  if (params.candidates.length === 0) return [];
  interface TransitionedScheduleLeaseRow {
    id: string;
    lease_expires_at_rank: bigint | number | string;
    claim_cycle_start_turn: bigint | number | string;
    claim_proof_turn: bigint | number | string;
    claim_proof_xid: string;
    claim_proof_priority_pass: number | string;
    claim_proof_attempt: number | string;
  }
  const transitioned = await sqlRows<TransitionedScheduleLeaseRow>(
    params.tx,
    sql`WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
      UPDATE ${agentBackupAdmissionWork} AS work
      SET state = 'leased',
          deferred_reason = NULL,
          lease_owner = ${params.ownerId},
          lease_generation = ${params.generation},
          lease_expires_at = observed.at + (${params.leaseMs} * INTERVAL '1 millisecond'),
          attempts = work.attempts + 1,
          updated_at = observed.at
      FROM observed
      WHERE (${sql.join(
        params.candidates.map((candidate) => exactQueuedScheduleCandidateAuthoritySql(candidate)),
        sql`) OR (`,
      )})
        AND work.attempts < ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS}
      RETURNING work.id,
        (EXTRACT(EPOCH FROM work.lease_expires_at) * 1000000)::bigint::text
          AS lease_expires_at_rank,
        work.claim_cycle_start_turn, work.claim_proof_turn,
        work.claim_proof_xid::text AS claim_proof_xid,
        work.claim_proof_priority_pass, work.claim_proof_attempt`,
  );
  if (transitioned.length !== params.candidates.length) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission could not transition every locked schedule item",
      "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
    );
  }
  const candidateById = new Map(params.candidates.map((candidate) => [candidate.id, candidate]));
  const admissionProofs = transitioned.map((row): ScheduleAdmissionProof => {
    const candidate = candidateById.get(row.id);
    if (!candidate) {
      throw new AgentBackupAdmissionClaimError(
        "Transitioned backup admission row has no exact locked candidate",
        "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
      );
    }
    const proof: ScheduleAdmissionProof = {
      workId: requireUuid(row.id, "transitioned claim work id"),
      cycleStartTurn: requirePositiveDatabaseBigint(
        row.claim_cycle_start_turn,
        "transitioned claim cycle start turn",
      ),
      proofTurn: requirePositiveDatabaseBigint(
        row.claim_proof_turn,
        "transitioned claim proof turn",
      ),
      proofXid: requirePositiveDatabaseBigint(row.claim_proof_xid, "transitioned claim proof xid"),
      priorityPass: requireBoundedInteger({
        value: Number(row.claim_proof_priority_pass),
        field: "transitioned claim proof priority pass",
        min: 0,
        max: FINAL_SCHEDULE_PRIORITY_PASS,
      }),
      attempt: requireBoundedInteger({
        value: Number(row.claim_proof_attempt),
        field: "transitioned claim proof attempt",
        min: 1,
        max: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
      }),
    };
    if (
      proof.cycleStartTurn !== params.cycle.cycleStartTurn ||
      proof.priorityPass !== params.cycle.priorityPass ||
      proof.attempt !== candidate.attempts + 1 ||
      BigInt(proof.proofTurn) <= BigInt(params.cycle.lastTurn)
    ) {
      throw new AgentBackupAdmissionClaimError(
        "Transitioned backup admission proof does not match its locked authority",
        "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
      );
    }
    return proof;
  });
  if (
    new Set(admissionProofs.map(({ proofTurn }) => proofTurn)).size !== admissionProofs.length ||
    new Set(admissionProofs.map(({ proofXid }) => proofXid)).size !== 1
  ) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission batch did not receive unique same-transaction proofs",
      "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
    );
  }
  const greatestAdmissionProof = admissionProofs.reduce<ScheduleAdmissionProof | null>(
    (greatest, proof) =>
      greatest === null || BigInt(proof.proofTurn) > BigInt(greatest.proofTurn) ? proof : greatest,
    null,
  );
  if (!greatestAdmissionProof) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission transition returned no exact restart token",
      "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
    );
  }
  await restartActiveScheduleClaimCycleAfterAdmission(
    params.tx,
    params.cycle,
    greatestAdmissionProof,
  );
  await advanceClaimedLaneCursors(params.tx, params.candidates);
  const transitionById = new Map(transitioned.map((row) => [row.id, row]));
  const claimed = await sqlRows<{
    id: string;
    organization_id: string;
    sandbox_id: string;
    node_history_id: string;
    source_activation_generation: string;
    source_lifecycle_revision: bigint | number | string;
    source_provider_handle: string;
    source_container_id: string;
    source_image_digest: string;
    source_rpo_ms: number | string;
    source_due_at: Date | string;
    rpo_deadline_at: Date | string;
    first_eligible_at: Date | string;
    attempts: number | string;
    expires_at: Date | string;
    claim_cycle_start_turn: bigint | number | string;
    claim_proof_turn: bigint | number | string;
    claim_proof_xid: string;
    claim_proof_priority_pass: number | string;
    claim_proof_attempt: number | string;
  }>(
    params.tx,
    sql`WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
      UPDATE ${agentBackupAdmissionWork} AS work
      SET lease_expires_at = GREATEST(
            work.lease_expires_at,
            observed.at + (${params.leaseMs} * INTERVAL '1 millisecond')
          ),
          updated_at = observed.at
      FROM observed
      WHERE (${sql.join(
        admissionProofs.map((proof) => {
          const transition = transitionById.get(proof.workId);
          if (!transition) {
            throw new AgentBackupAdmissionClaimError(
              "Backup admission proof lost its transition lease",
              "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
            );
          }
          return sql`work.id = ${proof.workId}::uuid
            AND work.work_kind = 'schedule_capture'
            AND work.work_stage = 'reserve_capture'
            AND work.state = 'leased'
            AND work.lease_owner = ${params.ownerId}
            AND work.lease_generation = ${params.generation}::uuid
            AND (EXTRACT(EPOCH FROM work.lease_expires_at) * 1000000)::bigint =
              ${requireDatabaseBigint(
                transition.lease_expires_at_rank,
                "transition lease expiry rank",
              )}::bigint
            AND work.attempts = ${proof.attempt}
            AND work.claim_cycle_start_turn = ${proof.cycleStartTurn}::bigint
            AND work.claim_proof_turn = ${proof.proofTurn}::bigint
            AND work.claim_proof_xid::text = ${proof.proofXid}
            AND work.claim_proof_priority_pass = ${proof.priorityPass}
            AND work.claim_proof_attempt = ${proof.attempt}`;
        }),
        sql`) OR (`,
      )})
      RETURNING work.id, work.organization_id, work.sandbox_id,
        work.node_history_id, work.source_activation_generation,
        work.source_lifecycle_revision, work.source_provider_handle,
        work.source_container_id, work.source_image_digest, work.source_rpo_ms,
        work.source_due_at, work.rpo_deadline_at, work.first_eligible_at,
        work.attempts, work.lease_expires_at AS expires_at,
        work.claim_cycle_start_turn, work.claim_proof_turn,
        work.claim_proof_xid::text AS claim_proof_xid,
        work.claim_proof_priority_pass, work.claim_proof_attempt`,
  );
  if (claimed.length !== params.candidates.length) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission could not lease every locked schedule item",
      "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
    );
  }
  const [leaseAuthority] = await sqlRows<{ live_count: number | string }>(
    params.tx,
    sql`WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT COUNT(*)::integer AS live_count
      FROM ${agentBackupAdmissionWork} AS work
      CROSS JOIN observed
      WHERE (${sql.join(
        admissionProofs.map(
          (proof) => sql`work.id = ${proof.workId}::uuid
            AND work.state = 'leased'
            AND work.lease_owner = ${params.ownerId}
            AND work.lease_generation = ${params.generation}::uuid
            AND work.attempts = ${proof.attempt}
            AND work.claim_cycle_start_turn = ${proof.cycleStartTurn}::bigint
            AND work.claim_proof_turn = ${proof.proofTurn}::bigint
            AND work.claim_proof_xid::text = ${proof.proofXid}
            AND work.claim_proof_priority_pass = ${proof.priorityPass}
            AND work.claim_proof_attempt = ${proof.attempt}`,
        ),
        sql`) OR (`,
      )})
        AND work.lease_expires_at > observed.at`,
  );
  if (Number(leaseAuthority?.live_count ?? -1) !== params.candidates.length) {
    throw new AgentBackupAdmissionClaimError(
      "Backup admission lease batch expired before it became consumable",
      "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
    );
  }
  const positionById = new Map(params.candidates.map(({ id }, index) => [id, index]));
  return claimed
    .sort(
      (left, right) =>
        (positionById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (positionById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((row) => {
      const candidate = candidateById.get(row.id);
      if (!candidate) {
        throw new AgentBackupAdmissionClaimError(
          "Leased backup admission row has no locked candidate",
          "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
        );
      }
      const claimCycleStartTurn = requirePositiveDatabaseBigint(
        row.claim_cycle_start_turn,
        "claim cycle start turn",
      );
      const claimProofTurn = requirePositiveDatabaseBigint(
        row.claim_proof_turn,
        "claim proof turn",
      );
      const claimProofXid = requirePositiveDatabaseBigint(row.claim_proof_xid, "claim proof xid");
      const claimProofPriorityPass = requireBoundedInteger({
        value: Number(row.claim_proof_priority_pass),
        field: "claim proof priority pass",
        min: 0,
        max: FINAL_SCHEDULE_PRIORITY_PASS,
      });
      const workAttempt = requireSafeDatabaseInteger(row.attempts, "claim work attempt");
      if (Number(row.claim_proof_attempt) !== workAttempt) {
        throw new AgentBackupAdmissionClaimError(
          "Leased backup admission proof does not fence its returned attempt",
          "BACKUP_ADMISSION_CLAIM_LEASE_FAILED",
        );
      }
      return {
        workId: row.id,
        organizationId: row.organization_id,
        sandboxId: row.sandbox_id,
        nodeHistoryId: row.node_history_id,
        sourceActivationGeneration: row.source_activation_generation,
        sourceLifecycleRevision: requireDatabaseBigint(
          row.source_lifecycle_revision,
          "claim source lifecycle revision",
        ),
        sourceProviderHandle: row.source_provider_handle,
        sourceContainerId: row.source_container_id,
        sourceImageDigest: row.source_image_digest,
        sourceRpoMs: requireSafeDatabaseInteger(row.source_rpo_ms, "claim source RPO"),
        sourceDueAt: requireDatabaseDate(row.source_due_at, "claim source dueAt"),
        rpoDeadlineAt: requireDatabaseDate(row.rpo_deadline_at, "claim RPO deadline"),
        firstEligibleAt: requireDatabaseDate(row.first_eligible_at, "claim first eligibleAt"),
        effectivePriority: candidate.effectivePriority,
        ownerId: params.ownerId,
        generation: params.generation,
        expiresAt: requireDatabaseDate(row.expires_at, "claim expiresAt"),
        workAttempt,
        claimCycleStartTurn,
        claimProofTurn,
        claimProofXid,
        claimProofPriorityPass,
      };
    });
}

/**
 * Claim a bounded batch of exact periodic-capture reservations.
 *
 * One transaction performs exactly one bounded recovery, cycle transition, or
 * 1,024-key scan-and-claim turn. Raw LIMIT happens before organization, work,
 * source, and lane locks; a caller polls again after an empty progress turn.
 */
export async function claimAgentBackupAdmissionWorkTurn(params: {
  ownerId: string;
  limit: number;
  leaseMs: number;
}): Promise<AgentBackupAdmissionClaimTurn> {
  const ownerId = requireLeaseOwner(params.ownerId);
  const limit = requireBoundedInteger({
    value: params.limit,
    field: "limit",
    min: 1,
    max: MAX_AGENT_BACKUP_ADMISSION_CLAIM_BATCH,
  });
  const leaseMs = requireBoundedInteger({
    value: params.leaseMs,
    field: "leaseMs",
    min: MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
    max: MAX_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
  });
  const generation = randomUUID();

  return dbWrite.transaction(async (tx) => {
    const lockedShard = await lockLeastServedScheduleClaimShard(tx);
    if (!lockedShard) {
      return {
        outcome: (await scheduleClaimWorkRemains(tx)) ? "contended" : "idle",
        claims: [],
      };
    }
    if (lockedShard.recovery !== null) {
      await normalizeOneReadyScheduleRecoveryWindow(tx, lockedShard, lockedShard.recovery);
      return { outcome: "progressed", claims: [] };
    }
    if (await startScheduleRecoveryCycle(tx, lockedShard)) {
      return { outcome: "progressed", claims: [] };
    }

    if (lockedShard.cycle === null) {
      await startScheduleClaimCycle({ tx, lockedShard });
      return { outcome: "progressed", claims: [] };
    }
    const transactionObservedAt = await readPrimaryClock(tx);
    const cycle = lockedShard.cycle;
    if (cycleAtHighWater(cycle)) {
      if (cycle.priorityPass === FINAL_SCHEDULE_PRIORITY_PASS) {
        await finishScheduleClaimCycle(tx, cycle);
      } else {
        await advanceSchedulePriorityPass(tx, cycle);
      }
      return { outcome: "progressed", claims: [] };
    }

    const rawKeys = await readRawSchedulePage({
      tx,
      cycle,
      limit: MAX_AGENT_BACKUP_ADMISSION_CLAIM_SCAN_BUDGET,
    });
    if (rawKeys.length === 0) {
      await markScheduleClaimHighWater(tx, cycle);
      return { outcome: "progressed", claims: [] };
    }

    const admissibleOrganizations = await lockAdmissibleOrganizations(tx, rawKeys);
    const queueLocked = await lockRawScheduleWork({
      tx,
      cycle,
      rawKeys,
      admissibleOrganizations,
    });
    const retryable = await settleRetryExhaustedScheduleWork(
      tx,
      queueLocked,
      transactionObservedAt,
    );
    const priorityEligible = filterSchedulePriorityPass(retryable, cycle);
    const sourceLocked = await lockAndRevalidateScheduleSources(
      tx,
      priorityEligible,
      transactionObservedAt,
    );
    const authorityLocked = await lockLaneAuthorities(tx, sourceLocked);
    const laneAvailable = await filterAvailableScheduleLanes(tx, authorityLocked);
    const ranked = [...laneAvailable].sort(compareScheduleCandidateRank);
    let matchingCursor: {
      readyCohort: string;
      cohortOrdinal: number;
      id: string;
    } | null = null;
    if (cycle.cursorId !== null) {
      if (cycle.cursorCohort === null || cycle.cursorOrdinal === null) {
        throw new AgentBackupAdmissionClaimError(
          "Backup admission claim cycle lost part of its matching cursor",
          "BACKUP_ADMISSION_CLAIM_CYCLE_INVALID",
        );
      }
      matchingCursor = {
        readyCohort: cycle.cursorCohort,
        cohortOrdinal: cycle.cursorOrdinal,
        id: cycle.cursorId,
      };
    }
    const selected = selectStrictPriorityLaneBatch(
      ranked,
      {
        workKind: "schedule_capture",
        shardId: cycle.shardId,
        cycleObservedAtRank: cycle.observedAtRank,
        priorityPass: cycle.priorityPass,
        highWater: {
          readyCohort: cycle.maxCohort,
          cohortOrdinal: cycle.maxOrdinal,
          id: cycle.maxId,
        },
        cursor: matchingCursor,
      },
      limit,
    );
    const advancedCycle = await updateScheduleClaimCursor(
      tx,
      cycle,
      rawKeys.at(-1) as RawScheduleKey,
    );
    if (selected.length === 0) return { outcome: "progressed", claims: [] };
    const claims = await leaseScheduleCandidates({
      tx,
      cycle: advancedCycle,
      candidates: selected,
      ownerId,
      generation,
      leaseMs,
    });
    const [firstClaim, ...remainingClaims] = claims;
    if (!firstClaim) {
      throw new AgentBackupAdmissionClaimError(
        "Backup admission selected work but did not lease any claim",
        "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
      );
    }
    return { outcome: "claimed", claims: [firstClaim, ...remainingClaims] };
  });
}

/**
 * Compatibility wrapper for repository consumers that only need claimed rows.
 * Scheduler callers must use `claimAgentBackupAdmissionWorkTurn` so durable
 * progress is never mistaken for an idle queue.
 */
export async function claimAgentBackupAdmissionWork(params: {
  ownerId: string;
  limit: number;
  leaseMs: number;
}): Promise<AgentBackupAdmissionClaim[]> {
  return (await claimAgentBackupAdmissionWorkTurn(params)).claims;
}

function exactLeasedScheduleFenceAuthoritySql(
  fence: AgentBackupAdmissionFence,
): ReturnType<typeof sql> {
  return sql`work.id = ${fence.workId}::uuid
    AND work.work_kind = 'schedule_capture'
    AND work.work_stage = 'reserve_capture'
    AND work.state = 'leased'
    AND work.deferred_reason IS NULL
    AND work.lease_owner = ${fence.ownerId}
    AND work.lease_generation = ${fence.generation}::uuid
    AND work.attempts = ${fence.workAttempt}
    AND work.claim_cycle_start_turn = ${fence.claimCycleStartTurn}::bigint
    AND work.claim_proof_turn = ${fence.claimProofTurn}::bigint
    AND work.claim_proof_xid::text = ${fence.claimProofXid}
    AND work.claim_proof_priority_pass = ${fence.claimProofPriorityPass}
    AND work.claim_proof_attempt = ${fence.workAttempt}
    AND work.settled_at IS NULL
    AND work.settled_reason IS NULL`;
}

/** Extend one exact unexpired queue fence using the primary database clock. */
export async function heartbeatAgentBackupAdmissionClaim(params: {
  fence: AgentBackupAdmissionFence;
  leaseMs: number;
}): Promise<Date | null> {
  const fence = requireFence(params.fence);
  const leaseMs = requireBoundedInteger({
    value: params.leaseMs,
    field: "leaseMs",
    min: MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
    max: MAX_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
  });
  const [updated] = await sqlRows<{ expires_at: Date | string }>(
    dbWrite,
    sql`WITH locked AS MATERIALIZED (
        SELECT work.id
        FROM ${agentBackupAdmissionWork} AS work
        WHERE ${exactLeasedScheduleFenceAuthoritySql(fence)}
        FOR UPDATE OF work
      ),
      observed AS MATERIALIZED (
        SELECT clock_timestamp() AS at
        FROM locked
      )
      UPDATE ${agentBackupAdmissionWork} AS work
      SET lease_expires_at = GREATEST(
            work.lease_expires_at,
            observed.at + (${leaseMs} * INTERVAL '1 millisecond')
          ),
          updated_at = observed.at
      FROM locked, observed
      WHERE work.id = locked.id
        AND ${exactLeasedScheduleFenceAuthoritySql(fence)}
        AND work.lease_expires_at > observed.at
      RETURNING work.lease_expires_at AS expires_at`,
  );
  return updated ? requireDatabaseDate(updated.expires_at, "heartbeat expiresAt") : null;
}

/** Release one exact claim into bounded explicit backpressure. */
export async function deferAgentBackupAdmissionClaim(params: {
  fence: AgentBackupAdmissionFence;
  retryDelayMs: number;
  reason: string;
}): Promise<AgentBackupAdmissionDeferResult> {
  const fence = requireFence(params.fence);
  const retryDelayMs = requireBoundedInteger({
    value: params.retryDelayMs,
    field: "retryDelayMs",
    min: 1,
    max: MAX_AGENT_BACKUP_ADMISSION_DEFER_MS,
  });
  const reason = requireReason(params.reason, "reason");
  const [updated] = await sqlRows<{ outcome: Exclude<AgentBackupAdmissionDeferResult, null> }>(
    dbWrite,
    sql`WITH locked AS MATERIALIZED (
        SELECT work.id
        FROM ${agentBackupAdmissionWork} AS work
        WHERE ${exactLeasedScheduleFenceAuthoritySql(fence)}
        FOR UPDATE OF work
      ),
      observed AS MATERIALIZED (
        SELECT clock_timestamp() AS at
        FROM locked
      )
      UPDATE ${agentBackupAdmissionWork} AS work
      SET state = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN 'settled'
            ELSE 'deferred'
          END,
          not_before = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN work.not_before
            ELSE GREATEST(
              work.not_before,
              observed.at + (${retryDelayMs} * INTERVAL '1 millisecond')
            )
          END,
          deferred_reason = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN NULL
            ELSE ${reason}
          END,
          lease_owner = NULL,
          lease_generation = NULL,
          lease_expires_at = NULL,
          settled_at = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS} THEN observed.at
            ELSE NULL
          END,
          settled_reason = CASE
            WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS}
              THEN 'RETRY_EXHAUSTED'
            ELSE NULL
          END,
          updated_at = observed.at
      FROM locked, observed
      WHERE work.id = locked.id
        AND ${exactLeasedScheduleFenceAuthoritySql(fence)}
        AND work.lease_expires_at > observed.at
      RETURNING CASE
        WHEN work.attempts >= ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS}
          THEN 'retry_exhausted'
        ELSE 'deferred'
      END AS outcome`,
  );
  return updated?.outcome ?? null;
}

/** Terminally settle one exact unexpired claim. */
export async function settleAgentBackupAdmissionClaim(params: {
  fence: AgentBackupAdmissionFence;
  reason: string;
}): Promise<boolean> {
  const fence = requireFence(params.fence);
  const reason = requireReason(params.reason, "reason");
  const [updated] = await sqlRows<{ id: string }>(
    dbWrite,
    sql`WITH locked AS MATERIALIZED (
        SELECT work.id
        FROM ${agentBackupAdmissionWork} AS work
        WHERE ${exactLeasedScheduleFenceAuthoritySql(fence)}
        FOR UPDATE OF work
      ),
      observed AS MATERIALIZED (
        SELECT clock_timestamp() AS at
        FROM locked
      )
      UPDATE ${agentBackupAdmissionWork} AS work
      SET state = 'settled',
          deferred_reason = NULL,
          lease_owner = NULL,
          lease_generation = NULL,
          lease_expires_at = NULL,
          settled_at = observed.at,
          settled_reason = ${reason},
          updated_at = observed.at
      FROM locked, observed
      WHERE work.id = locked.id
        AND ${exactLeasedScheduleFenceAuthoritySql(fence)}
        AND work.lease_expires_at > observed.at
      RETURNING work.id`,
  );
  return Boolean(updated);
}

/** Count every unsettled queue item once, without multiplying through backing joins. */
export async function countUnsettledAgentBackupAdmissionWork(): Promise<number> {
  const [row] = await sqlRows<{ count: number | string }>(
    dbWrite,
    sql`SELECT COUNT(*)::bigint AS count
      FROM ${agentBackupAdmissionWork}
      WHERE state <> 'settled'`,
  );
  if (!row) {
    throw new AgentBackupAdmissionClaimError(
      "Primary database did not return backup admission capacity",
      "BACKUP_ADMISSION_CLAIM_AUTHORITY_CORRUPT",
    );
  }
  return requireSafeDatabaseInteger(row.count, "unsettled schedule count");
}
