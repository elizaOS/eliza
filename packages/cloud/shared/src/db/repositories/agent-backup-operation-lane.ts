/** Primary-DB singleton fence for every backup provider mutation. */

import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  type AgentBackupOperationLane,
  type AgentBackupOperationLanePhase,
  agentBackupOperationLane,
  agentBackupOperationNodeWatermarks,
  agentBackupOperationTenantWatermarks,
} from "../schemas/agent-backup-operation-lane";

const OWNER_ID_MAX_BYTES = 255;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
export const AGENT_BACKUP_OPERATION_LANE_MAX_LEASE_MS = 5 * 60 * 1_000;

export interface AgentBackupOperationLaneCallerToken {
  readonly ownerId: string;
  readonly generation: string;
}

/** Monotone post-claim fence; never serialize `claimSequence` as a JSON number. */
export interface AgentBackupOperationLaneExecution extends AgentBackupOperationLaneCallerToken {
  readonly claimSequence: bigint;
}

export interface AgentBackupOperationLaneTarget {
  readonly organizationId: string;
  readonly backupId: string;
  readonly operationId: string;
  readonly operationPhase: AgentBackupOperationLanePhase;
}

export interface AgentBackupOperationLaneFairness {
  readonly sourceNodeHistoryId: string;
  readonly sourceNodeRecordId: string;
  readonly sourceNodeIncarnation: string;
}

/**
 * An active proof is meaningful only while its originating transaction holds
 * the singleton row lock. Refreshing a stale, released, or foreign proof fails
 * closed instead of returning an easy-to-ignore inactive value.
 */
export interface AgentBackupOperationLaneProof {
  readonly lane: Readonly<AgentBackupOperationLane>;
  readonly databaseNow: Date;
  readonly active: true;
}

export type AgentBackupOperationLaneClaimResult =
  | {
      readonly kind: "claimed" | "replayed";
      readonly proof: AgentBackupOperationLaneProof;
      readonly execution: AgentBackupOperationLaneExecution;
    }
  | {
      readonly kind: "busy";
      readonly lane: Readonly<AgentBackupOperationLane>;
      readonly databaseNow: Date;
    };

export interface AgentBackupOperationLaneReleaseResult {
  readonly kind: "released" | "replayed";
  readonly lane: Readonly<AgentBackupOperationLane>;
}

interface ProofAuthority {
  readonly tx: DbTransaction;
  readonly transactionId: string;
  readonly target: AgentBackupOperationLaneTarget;
  readonly execution: AgentBackupOperationLaneExecution;
}

const proofAuthorities = new WeakMap<AgentBackupOperationLaneProof, ProofAuthority>();

function invalidInput(message: string, field: string): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_BACKUP_OPERATION_LANE_INVALID_INPUT",
    severity: "fatal",
    context: { field },
  });
}

function authorityMissing(): ElizaError {
  return new ElizaError("Global backup operation lane authority is missing", {
    code: "AGENT_BACKUP_OPERATION_LANE_MISSING",
    severity: "fatal",
    context: { singleton: true },
  });
}

function transactionRequired(): ElizaError {
  return new ElizaError(
    "Global backup operation lane requires one explicit primary-database transaction",
    {
      code: "AGENT_BACKUP_OPERATION_LANE_TRANSACTION_REQUIRED",
      severity: "fatal",
    },
  );
}

function proofTransactionMismatch(): ElizaError {
  return new ElizaError(
    "Global backup operation lane proof belongs to another or completed database transaction",
    {
      code: "AGENT_BACKUP_OPERATION_LANE_PROOF_TRANSACTION_MISMATCH",
      severity: "fatal",
    },
  );
}

function executionContext(
  execution: AgentBackupOperationLaneCallerToken | AgentBackupOperationLaneExecution,
): Record<string, string> {
  return {
    ownerId: execution.ownerId,
    generation: execution.generation,
    ...(Object.hasOwn(execution, "claimSequence")
      ? { claimSequence: (execution as AgentBackupOperationLaneExecution).claimSequence.toString() }
      : {}),
  };
}

function authorityLost(
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneCallerToken | AgentBackupOperationLaneExecution,
): ElizaError {
  return new ElizaError(
    "Global backup operation lane is absent, expired, released, or superseded",
    {
      code: "AGENT_BACKUP_OPERATION_LANE_LOST",
      severity: "fatal",
      context: {
        organizationId: target.organizationId,
        backupId: target.backupId,
        operationId: target.operationId,
        operationPhase: target.operationPhase,
        ...executionContext(execution),
      },
    },
  );
}

function claimSequenceExhausted(): ElizaError {
  return new ElizaError("Global backup operation lane claim sequence is exhausted", {
    code: "AGENT_BACKUP_OPERATION_LANE_SEQUENCE_EXHAUSTED",
    severity: "fatal",
  });
}

function claimExpired(
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneCallerToken | AgentBackupOperationLaneExecution,
): ElizaError {
  return new ElizaError("Global backup operation lane lease expired before commit", {
    code: "AGENT_BACKUP_OPERATION_LANE_CLAIM_EXPIRED",
    severity: "fatal",
    context: {
      organizationId: target.organizationId,
      backupId: target.backupId,
      operationId: target.operationId,
      operationPhase: target.operationPhase,
      ...executionContext(execution),
    },
  });
}

function fairnessMismatch(
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneExecution,
): ElizaError {
  return new ElizaError("Global backup operation lane fairness receipt is missing or mismatched", {
    code: "AGENT_BACKUP_OPERATION_LANE_FAIRNESS_MISMATCH",
    severity: "fatal",
    context: {
      organizationId: target.organizationId,
      backupId: target.backupId,
      operationId: target.operationId,
      operationPhase: target.operationPhase,
      ...executionContext(execution),
    },
  });
}

function requireCanonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidUUID(value) || value !== value.toLowerCase()) {
    throw invalidInput(`${field} must be a canonical lowercase UUID`, field);
  }
  return value;
}

function requireOperationPhase(value: unknown): AgentBackupOperationLanePhase {
  if (value !== "capture" && value !== "publication") {
    throw invalidInput("operationPhase must be capture or publication", "operationPhase");
  }
  return value;
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireOwnerId(value: unknown): string {
  const byteLength = typeof value === "string" ? new TextEncoder().encode(value).byteLength : 0;
  if (
    typeof value !== "string" ||
    hasUnpairedUtf16Surrogate(value) ||
    value !== value.trim() ||
    byteLength < 1 ||
    byteLength > OWNER_ID_MAX_BYTES ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw invalidInput(
      `execution.ownerId must be well-formed Unicode, trimmed, contain no control characters, and occupy 1-${OWNER_ID_MAX_BYTES} UTF-8 bytes`,
      "execution.ownerId",
    );
  }
  return value;
}

function requireLeaseMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > AGENT_BACKUP_OPERATION_LANE_MAX_LEASE_MS
  ) {
    throw invalidInput(
      `leaseMs must be an integer between 1 and ${AGENT_BACKUP_OPERATION_LANE_MAX_LEASE_MS}`,
      "leaseMs",
    );
  }
  return value;
}

function requireClaimSequence(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > MAX_SIGNED_BIGINT) {
    throw invalidInput("execution.claimSequence must be a positive signed bigint", "claimSequence");
  }
  return value;
}

function snapshotTarget(
  target: AgentBackupOperationLaneTarget,
): Readonly<AgentBackupOperationLaneTarget> {
  if (!target || typeof target !== "object") {
    throw invalidInput(
      "target must identify an organization, backup, operation, and operation phase",
      "target",
    );
  }
  return Object.freeze({
    organizationId: requireCanonicalUuid(target.organizationId, "organizationId"),
    backupId: requireCanonicalUuid(target.backupId, "backupId"),
    operationId: requireCanonicalUuid(target.operationId, "operationId"),
    operationPhase: requireOperationPhase(target.operationPhase),
  });
}

function snapshotCallerToken(
  token: AgentBackupOperationLaneCallerToken,
): Readonly<AgentBackupOperationLaneCallerToken> {
  if (!token || typeof token !== "object") {
    throw invalidInput("callerToken must contain an owner and generation", "callerToken");
  }
  return Object.freeze({
    ownerId: requireOwnerId(token.ownerId),
    generation: requireCanonicalUuid(token.generation, "execution.generation"),
  });
}

/** Validate and detach a caller token before a coordinator crosses an await. */
export function normalizeAgentBackupOperationLaneCallerToken(
  token: AgentBackupOperationLaneCallerToken,
): Readonly<AgentBackupOperationLaneCallerToken> {
  return snapshotCallerToken(token);
}

/** Share the lane's exact lease bounds with atomic admission coordinators. */
export function normalizeAgentBackupOperationLaneLeaseMs(value: unknown): number {
  return requireLeaseMs(value);
}

function snapshotExecution(
  execution: AgentBackupOperationLaneExecution,
): Readonly<AgentBackupOperationLaneExecution> {
  const callerToken = snapshotCallerToken(execution);
  return Object.freeze({
    ...callerToken,
    claimSequence: requireClaimSequence(execution.claimSequence),
  });
}

function snapshotFairness(
  fairness: AgentBackupOperationLaneFairness,
): Readonly<AgentBackupOperationLaneFairness> {
  if (!fairness || typeof fairness !== "object") {
    throw invalidInput("fairness must be an exact source-node occurrence", "fairness");
  }
  return Object.freeze({
    sourceNodeHistoryId: requireCanonicalUuid(
      fairness.sourceNodeHistoryId,
      "fairness.sourceNodeHistoryId",
    ),
    sourceNodeRecordId: requireCanonicalUuid(
      fairness.sourceNodeRecordId,
      "fairness.sourceNodeRecordId",
    ),
    sourceNodeIncarnation: requireCanonicalUuid(
      fairness.sourceNodeIncarnation,
      "fairness.sourceNodeIncarnation",
    ),
  });
}

async function readLaneTransactionContext(
  tx: DbTransaction,
  expectedTransactionId?: string,
): Promise<{ databaseNow: Date; transactionId: string }> {
  const [context] = await sqlRows<{
    database_now: Date | string;
    transaction_id: string | null;
  }>(
    tx,
    sql`SELECT
      clock_timestamp() AS database_now,
      txid_current_if_assigned()::text AS transaction_id`,
  );
  const databaseNow =
    context?.database_now instanceof Date
      ? context.database_now
      : new Date(context?.database_now ?? Number.NaN);
  if (!Number.isFinite(databaseNow.getTime())) {
    throw new ElizaError("Primary database clock is unavailable", {
      code: "PRIMARY_DATABASE_CLOCK_UNAVAILABLE",
      severity: "fatal",
    });
  }
  if (!context?.transaction_id) throw transactionRequired();
  if (expectedTransactionId && context.transaction_id !== expectedTransactionId) {
    throw proofTransactionMismatch();
  }
  return { databaseNow, transactionId: context.transaction_id };
}

function laneIsActive(lane: AgentBackupOperationLane, databaseNow: Date): boolean {
  return (
    lane.released_at === null &&
    lane.lease_expires_at !== null &&
    lane.lease_expires_at.getTime() > databaseNow.getTime()
  );
}

function callerTokenMatches(
  lane: AgentBackupOperationLane,
  target: AgentBackupOperationLaneTarget,
  token: AgentBackupOperationLaneCallerToken,
): boolean {
  return (
    lane.owner_id === token.ownerId &&
    lane.generation === token.generation &&
    lane.organization_id === target.organizationId &&
    lane.backup_id === target.backupId &&
    lane.operation_id === target.operationId &&
    lane.operation_phase === target.operationPhase
  );
}

function executionMatches(
  lane: AgentBackupOperationLane,
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneExecution,
): boolean {
  return (
    callerTokenMatches(lane, target, execution) && lane.claim_sequence === execution.claimSequence
  );
}

function observedLane(lane: AgentBackupOperationLane): Readonly<AgentBackupOperationLane> {
  return Object.freeze({ ...lane });
}

function executionFor(
  lane: AgentBackupOperationLane,
  token: AgentBackupOperationLaneCallerToken,
): AgentBackupOperationLaneExecution {
  return Object.freeze({
    ownerId: token.ownerId,
    generation: token.generation,
    claimSequence: lane.claim_sequence,
  });
}

function bindProof(
  tx: DbTransaction,
  transactionId: string,
  lane: AgentBackupOperationLane,
  databaseNow: Date,
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneExecution,
): AgentBackupOperationLaneProof {
  const proof = Object.freeze({
    lane: observedLane(lane),
    databaseNow: new Date(databaseNow.getTime()),
    active: true as const,
  });
  proofAuthorities.set(proof, {
    tx,
    transactionId,
    target: Object.freeze({ ...target }),
    execution: Object.freeze({ ...execution }),
  });
  return proof;
}

/** Lock the one global lane before any operation, tenant, or source-node row. */
export async function lockAgentBackupOperationLaneInTransaction(
  tx: DbTransaction,
): Promise<{ lane: AgentBackupOperationLane; databaseNow: Date; transactionId: string }> {
  const [lane] = await tx
    .select()
    .from(agentBackupOperationLane)
    .where(eq(agentBackupOperationLane.singleton, true))
    .for("update")
    .limit(1);
  if (!lane) throw authorityMissing();
  return { lane, ...(await readLaneTransactionContext(tx)) };
}

async function assertFairnessReplayInTransaction(
  tx: DbTransaction,
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneExecution,
  fairness: AgentBackupOperationLaneFairness,
): Promise<void> {
  const [tenant] = await tx
    .select()
    .from(agentBackupOperationTenantWatermarks)
    .where(eq(agentBackupOperationTenantWatermarks.organization_id, target.organizationId))
    .for("share")
    .limit(1);
  const [node] = await tx
    .select()
    .from(agentBackupOperationNodeWatermarks)
    .where(
      eq(agentBackupOperationNodeWatermarks.source_node_history_id, fairness.sourceNodeHistoryId),
    )
    .for("share")
    .limit(1);
  if (
    !tenant ||
    tenant.last_backup_id !== target.backupId ||
    tenant.last_operation_id !== target.operationId ||
    tenant.last_service_sequence !== execution.claimSequence ||
    !node ||
    node.source_node_record_id !== fairness.sourceNodeRecordId ||
    node.source_node_incarnation !== fairness.sourceNodeIncarnation ||
    node.last_backup_id !== target.backupId ||
    node.last_operation_id !== target.operationId ||
    node.last_service_sequence !== execution.claimSequence
  ) {
    throw fairnessMismatch(target, execution);
  }
}

async function stampFairnessInTransaction(
  tx: DbTransaction,
  target: AgentBackupOperationLaneTarget,
  execution: AgentBackupOperationLaneExecution,
  fairness: AgentBackupOperationLaneFairness,
  databaseNow: Date,
): Promise<void> {
  await tx
    .insert(agentBackupOperationTenantWatermarks)
    .values({
      organization_id: target.organizationId,
      last_backup_id: target.backupId,
      last_operation_id: target.operationId,
      last_service_sequence: execution.claimSequence,
      service_count: 1n,
      last_served_at: databaseNow,
    })
    .onConflictDoUpdate({
      target: agentBackupOperationTenantWatermarks.organization_id,
      set: {
        last_backup_id: target.backupId,
        last_operation_id: target.operationId,
        last_service_sequence: execution.claimSequence,
        service_count: sql`${agentBackupOperationTenantWatermarks.service_count} + 1`,
        last_served_at: databaseNow,
      },
    });
  await tx
    .insert(agentBackupOperationNodeWatermarks)
    .values({
      source_node_history_id: fairness.sourceNodeHistoryId,
      source_node_record_id: fairness.sourceNodeRecordId,
      source_node_incarnation: fairness.sourceNodeIncarnation,
      last_backup_id: target.backupId,
      last_operation_id: target.operationId,
      last_service_sequence: execution.claimSequence,
      service_count: 1n,
      last_served_at: databaseNow,
    })
    .onConflictDoUpdate({
      target: agentBackupOperationNodeWatermarks.source_node_history_id,
      set: {
        source_node_record_id: fairness.sourceNodeRecordId,
        source_node_incarnation: fairness.sourceNodeIncarnation,
        last_backup_id: target.backupId,
        last_operation_id: target.operationId,
        last_service_sequence: execution.claimSequence,
        service_count: sql`${agentBackupOperationNodeWatermarks.service_count} + 1`,
        last_served_at: databaseNow,
      },
    });
}

/**
 * Claim the lane with a caller-stable token. Exact active retries replay the
 * same sequence. A caller identity reused after an intervening claim receives
 * a fresh sequence, so an expired or released execution fence never revives.
 */
export async function claimAgentBackupOperationLaneInTransaction(
  tx: DbTransaction,
  params: AgentBackupOperationLaneTarget & {
    readonly callerToken: AgentBackupOperationLaneCallerToken;
    readonly leaseMs: number;
    readonly fairness: AgentBackupOperationLaneFairness;
  },
): Promise<AgentBackupOperationLaneClaimResult> {
  const target = snapshotTarget(params);
  const callerToken = snapshotCallerToken(params.callerToken);
  const leaseMs = requireLeaseMs(params.leaseMs);
  const fairness = snapshotFairness(params.fairness);

  const { lane, databaseNow, transactionId } = await lockAgentBackupOperationLaneInTransaction(tx);
  const tokenMatches = callerTokenMatches(lane, target, callerToken);
  if (tokenMatches) {
    if (!laneIsActive(lane, databaseNow)) throw authorityLost(target, callerToken);
    const execution = executionFor(lane, callerToken);
    await assertFairnessReplayInTransaction(tx, target, execution, fairness);
    const { databaseNow: replayNow } = await readLaneTransactionContext(tx, transactionId);
    if (!laneIsActive(lane, replayNow)) throw authorityLost(target, execution);
    return Object.freeze({
      kind: "replayed" as const,
      proof: bindProof(tx, transactionId, lane, replayNow, target, execution),
      execution,
    });
  }
  if (lane.generation === callerToken.generation) {
    throw authorityLost(target, callerToken);
  }
  if (laneIsActive(lane, databaseNow)) {
    return Object.freeze({
      kind: "busy" as const,
      lane: observedLane(lane),
      databaseNow: new Date(databaseNow.getTime()),
    });
  }
  if (lane.claim_sequence >= MAX_SIGNED_BIGINT) throw claimSequenceExhausted();

  const leaseExpiresAt = new Date(databaseNow.getTime() + leaseMs);
  const [claimed] = await tx
    .update(agentBackupOperationLane)
    .set({
      owner_id: callerToken.ownerId,
      generation: callerToken.generation,
      organization_id: target.organizationId,
      backup_id: target.backupId,
      operation_id: target.operationId,
      operation_phase: target.operationPhase,
      claimed_at: databaseNow,
      lease_expires_at: leaseExpiresAt,
      released_at: null,
      claim_sequence: sql`${agentBackupOperationLane.claim_sequence} + 1`,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentBackupOperationLane.singleton, true),
        eq(agentBackupOperationLane.claim_sequence, lane.claim_sequence),
        sql`(${agentBackupOperationLane.generation} IS NULL
          OR ${agentBackupOperationLane.released_at} IS NOT NULL
          OR ${agentBackupOperationLane.lease_expires_at} <= clock_timestamp())`,
      ),
    )
    .returning();
  if (!claimed) throw authorityLost(target, callerToken);

  const execution = executionFor(claimed, callerToken);
  await stampFairnessInTransaction(tx, target, execution, fairness, databaseNow);
  const { databaseNow: postClaimNow } = await readLaneTransactionContext(tx, transactionId);
  if (!laneIsActive(claimed, postClaimNow)) throw claimExpired(target, execution);
  return Object.freeze({
    kind: "claimed" as const,
    proof: bindProof(tx, transactionId, claimed, postClaimNow, target, execution),
    execution,
  });
}

/** Lock and verify one exact, unexpired provider-execution fence. */
export async function assertAgentBackupOperationLaneInTransaction(
  tx: DbTransaction,
  params: AgentBackupOperationLaneTarget & {
    readonly execution: AgentBackupOperationLaneExecution;
  },
): Promise<AgentBackupOperationLaneProof> {
  const target = snapshotTarget(params);
  const execution = snapshotExecution(params.execution);
  const { lane, databaseNow, transactionId } = await lockAgentBackupOperationLaneInTransaction(tx);
  if (!executionMatches(lane, target, execution) || !laneIsActive(lane, databaseNow)) {
    throw authorityLost(target, execution);
  }
  return bindProof(tx, transactionId, lane, databaseNow, target, execution);
}

/** Re-read the locked row and DB clock after every subsequently acquired lock. */
export async function refreshAgentBackupOperationLaneProofInTransaction(
  tx: DbTransaction,
  proof: AgentBackupOperationLaneProof,
): Promise<AgentBackupOperationLaneProof> {
  const authority = proofAuthorities.get(proof);
  if (!authority || authority.tx !== tx) {
    throw proofTransactionMismatch();
  }
  const { lane, databaseNow, transactionId } = await lockAgentBackupOperationLaneInTransaction(tx);
  if (transactionId !== authority.transactionId) throw proofTransactionMismatch();
  if (
    !executionMatches(lane, authority.target, authority.execution) ||
    !laneIsActive(lane, databaseNow)
  ) {
    throw authorityLost(authority.target, authority.execution);
  }
  return bindProof(tx, transactionId, lane, databaseNow, authority.target, authority.execution);
}

/** Extend one exact active fence without ever shortening its current lease. */
export async function renewAgentBackupOperationLaneInTransaction(
  tx: DbTransaction,
  params: AgentBackupOperationLaneTarget & {
    readonly execution: AgentBackupOperationLaneExecution;
    readonly leaseMs: number;
  },
): Promise<AgentBackupOperationLaneProof> {
  const target = snapshotTarget(params);
  const execution = snapshotExecution(params.execution);
  const leaseMs = requireLeaseMs(params.leaseMs);
  const proof = await assertAgentBackupOperationLaneInTransaction(tx, { ...target, execution });
  const authority = proofAuthorities.get(proof);
  if (!authority) throw proofTransactionMismatch();
  const currentExpiry = proof.lane.lease_expires_at;
  if (!currentExpiry) throw authorityLost(target, execution);
  const leaseExpiresAt = new Date(
    Math.max(currentExpiry.getTime(), proof.databaseNow.getTime() + leaseMs),
  );
  const [renewed] = await tx
    .update(agentBackupOperationLane)
    .set({ lease_expires_at: leaseExpiresAt, updated_at: proof.databaseNow })
    .where(
      and(
        eq(agentBackupOperationLane.singleton, true),
        eq(agentBackupOperationLane.owner_id, execution.ownerId),
        eq(agentBackupOperationLane.generation, execution.generation),
        eq(agentBackupOperationLane.organization_id, target.organizationId),
        eq(agentBackupOperationLane.backup_id, target.backupId),
        eq(agentBackupOperationLane.operation_id, target.operationId),
        eq(agentBackupOperationLane.operation_phase, target.operationPhase),
        eq(agentBackupOperationLane.claim_sequence, execution.claimSequence),
        sql`${agentBackupOperationLane.released_at} IS NULL`,
        sql`${agentBackupOperationLane.lease_expires_at} > clock_timestamp()`,
      ),
    )
    .returning();
  if (!renewed) throw authorityLost(target, execution);
  const { databaseNow: postRenewNow } = await readLaneTransactionContext(
    tx,
    authority.transactionId,
  );
  if (!laneIsActive(renewed, postRenewNow)) throw claimExpired(target, execution);
  return bindProof(tx, authority.transactionId, renewed, postRenewNow, target, execution);
}

export async function readAgentBackupOperationLane(): Promise<AgentBackupOperationLane> {
  const [lane] = await dbWrite
    .select()
    .from(agentBackupOperationLane)
    .where(eq(agentBackupOperationLane.singleton, true))
    .limit(1);
  if (!lane) throw authorityMissing();
  return lane;
}

/** Release an active exact fence; an exact already-released retry is a no-op. */
export async function releaseAgentBackupOperationLaneInTransaction(
  tx: DbTransaction,
  params: AgentBackupOperationLaneTarget & {
    readonly execution: AgentBackupOperationLaneExecution;
  },
): Promise<AgentBackupOperationLaneReleaseResult> {
  const target = snapshotTarget(params);
  const execution = snapshotExecution(params.execution);
  const { lane, databaseNow } = await lockAgentBackupOperationLaneInTransaction(tx);
  if (!executionMatches(lane, target, execution)) {
    throw authorityLost(target, execution);
  }
  if (lane.released_at !== null) {
    return Object.freeze({ kind: "replayed" as const, lane: observedLane(lane) });
  }
  if (!laneIsActive(lane, databaseNow)) throw authorityLost(target, execution);

  const [released] = await tx
    .update(agentBackupOperationLane)
    .set({ released_at: databaseNow, updated_at: databaseNow })
    .where(
      and(
        eq(agentBackupOperationLane.singleton, true),
        eq(agentBackupOperationLane.owner_id, execution.ownerId),
        eq(agentBackupOperationLane.generation, execution.generation),
        eq(agentBackupOperationLane.organization_id, target.organizationId),
        eq(agentBackupOperationLane.backup_id, target.backupId),
        eq(agentBackupOperationLane.operation_id, target.operationId),
        eq(agentBackupOperationLane.operation_phase, target.operationPhase),
        eq(agentBackupOperationLane.claim_sequence, execution.claimSequence),
        sql`${agentBackupOperationLane.released_at} IS NULL`,
        sql`${agentBackupOperationLane.lease_expires_at} > clock_timestamp()`,
      ),
    )
    .returning();
  if (!released) throw authorityLost(target, execution);
  return Object.freeze({ kind: "released" as const, lane: observedLane(released) });
}
