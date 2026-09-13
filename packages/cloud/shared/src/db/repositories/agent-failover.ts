/**
 * Durable authority for node-failure records and agent failover work.
 *
 * Failover must survive the process that started it, so every decision here is a
 * row-level compare-and-set against `agent_failover_operations` and its journal,
 * never against in-process state. Four properties are load-bearing and are
 * enforced by the guards in `0388_agent_failover_guards.sql` rather than by
 * convention:
 *
 * - **Progress is not lost.** `readOperationResume` reconstructs position from
 *   the append-only attempt journal. Attempts are `(operation_id, step, attempt)`
 *   unique, and the guard refuses the next attempt of a step while the previous
 *   one is unresolved, so a restart reconciles what the interrupted executor
 *   actually did before it may run the step again.
 * - **Steps advance one at a time.** `beginStepAttempt` accepts only the step the
 *   operation is already on, or its immediate successor after that step
 *   succeeded. Skipping ahead is refused, including by the guard, so a
 *   completion can never be reached without the steps before it.
 * - **Work is not duplicated.** A partial unique index allows one non-terminal
 *   operation per Agent, `claimNextOperation` skips locked rows, and the guard
 *   rotates a lease generation only from an absent or expired horizon.
 * - **A superseded executor cannot commit.** Every progress write matches the
 *   live `(lease_owner, lease_generation)` fence while the guard re-checks the
 *   horizon against the database clock under the operation row lock.
 *
 * Detection is allowed to be wrong. Reachability cannot separate a dead node from
 * a partitioned one, so safety does not rest on the fault record: the frozen set
 * is built from the activation publications that actually authorize each Agent on
 * that occurrence, the source publication is copied rather than invented, and
 * `cutover` cannot be settled until a *restore* publication exists that directly
 * succeeds it. Recording that chain is not isolation — only refusing the stale
 * authority at the boundaries that write, route, and send is, and those checks
 * are deliberately not part of this module.
 *
 * Capacity is never counted here. The restore operation reserves the target slot
 * under its own exact-occurrence constraint; this module records the references
 * and parks the operation until that admission succeeds.
 *
 * Clock decisions are made by PostgreSQL, never by a host clock: lease horizons
 * are written and compared with `clock_timestamp()` in SQL.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbRead, writeTransaction } from "../helpers";
import { agentBackupRestoreOperations } from "../schemas/agent-backup-catalog";
import { agentActivationPublications } from "../schemas/agent-backup-restore-history";
import {
  AGENT_FAILOVER_STEPS,
  type AgentFailoverAttemptState,
  type AgentFailoverOperation,
  type AgentFailoverOperationStatus,
  type AgentFailoverReconcileAction,
  type AgentFailoverStep,
  type AgentFailoverStepAttempt,
  type AgentFailoverWaitReason,
  type AgentNodeFailureCandidate,
  type AgentNodeFailureEvent,
  type AgentNodeFailureSignal,
  type AgentNodeFailureSignalClass,
  type AgentNodeFailureSignalKind,
  type AgentNodeFailureSignalSource,
  agentFailoverOperations,
  agentFailoverOperatorActions,
  agentFailoverStepAttempts,
  agentNodeFailureCandidates,
  agentNodeFailureEvents,
  agentNodeFailureSignals,
} from "../schemas/agent-failover";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { readPostLockDatabaseNow } from "./primary-database-clock";

/**
 * The observation policy in force. Bumping the version is how a change to the
 * classes below is recorded; signals keep the version they were collected under,
 * so nothing is re-classified retroactively.
 */
export const AGENT_FAILOVER_OBSERVATION_POLICY_VERSION = 1;

/**
 * Declared independence classes. A source not listed here cannot be recorded:
 * the observer identity is controlled, not a free-form label a caller can
 * invent, and two probes that share a failure domain deliberately share a class.
 */
const DECLARED_SOURCE_CLASSES: Readonly<
  Record<AgentNodeFailureSignalSource, AgentNodeFailureSignalClass>
> = {
  platform_heartbeat_monitor: "platform_reachability",
  platform_placement_probe: "platform_reachability",
  platform_control_plane_probe: "platform_reachability",
  platform_runtime_inventory: "platform_runtime_state",
  infrastructure_provider_api: "infrastructure_provider",
};

/**
 * Non-terminal states, as a SQL fragment so no query lists them by hand.
 *
 * Hand-repeated lists are how a newly added state gets missed by one query and
 * silently becomes invisible to the guards.
 */
const NON_TERMINAL_STATUS_SQL = sql.raw(`('pending', 'running', 'awaiting_capacity',
  'awaiting_reconcile', 'restore_release_required', 'intervention_required')`);

/** Non-terminal states. A terminal operation is immutable and holds no lease. */
const NON_TERMINAL_STATUSES: readonly AgentFailoverOperationStatus[] = [
  "pending",
  "running",
  "awaiting_capacity",
  "awaiting_reconcile",
  "intervention_required",
];

/** Terminal states a committed cutover forbids. */
const PRE_CUTOVER_TERMINAL_STATUSES: readonly AgentFailoverOperationStatus[] = [
  "failed",
  "cancelled",
  "blocked_no_backup",
];

/** Attempt states that mean the step still has work the executor never finished. */
const UNRESOLVED_ATTEMPT_STATES: readonly AgentFailoverAttemptState[] = [
  "started",
  "awaiting_reconcile",
];

/** Attempt states that let the step run again. */
const SETTLED_ATTEMPT_STATES: readonly AgentFailoverAttemptState[] = [
  "succeeded",
  "failed",
  "abandoned",
  "reconciled",
];

const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 3_600_000;
const DEFAULT_CAPACITY_WAIT_MS = 300_000;
const DEFAULT_POST_CUTOVER_ATTEMPT_LIMIT = 5;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 86_400_000;

/** Typed refusal for a write that cannot present the operation's live lease. */
export class AgentFailoverStaleExecutorError extends ElizaError {
  override readonly name = "AgentFailoverStaleExecutorError";
  readonly operationId: string;
  readonly leaseOwner: string;
  readonly leaseGeneration: string;

  constructor(operationId: string, leaseOwner: string, leaseGeneration: string) {
    super(
      `Failover operation ${operationId} is not held by ${leaseOwner}/${leaseGeneration} with a live lease`,
      {
        code: "AGENT_FAILOVER_STALE_EXECUTOR",
        context: { operationId, leaseOwner, leaseGeneration },
      },
    );
    this.operationId = operationId;
    this.leaseOwner = leaseOwner;
    this.leaseGeneration = leaseGeneration;
  }
}

/** Typed invariant failure for a durable failover state that forbids the request. */
export class AgentFailoverConflictError extends ElizaError {
  override readonly name = "AgentFailoverConflictError";

  constructor(code: string, message: string, options?: { cause?: unknown; operationId?: string }) {
    super(message, {
      code,
      cause: options?.cause,
      context: options?.operationId ? { operationId: options.operationId } : undefined,
    });
  }
}

export interface OpenFailureRecordInput {
  nodeRecordId: string;
  nodeId: string;
  nodeIncarnation: string;
  nodeHistoryId: string;
  /** Independent observations required before the trigger. Floored at 2 by the schema. */
  corroborationRequired?: number;
}

export interface RecordFailureSignalInput {
  failureEventId: string;
  kind: AgentNodeFailureSignalKind;
  /** Controlled observer identity; its independence class is declared, not supplied. */
  source: AgentNodeFailureSignalSource;
  observedAt?: Date;
  detail?: Record<string, unknown>;
}

/** Corroboration standing of a fault record, evaluated under its row lock. */
export interface FailureCorroborationStanding {
  readonly event: AgentNodeFailureEvent;
  readonly distinctKinds: number;
  readonly distinctClasses: number;
  readonly observations: number;
  readonly required: number;
  readonly corroborated: boolean;
}

/** The cordoned node and the Agent set frozen against it, written in one transaction. */
export interface FailureFreezeOutcome {
  readonly event: AgentNodeFailureEvent;
  readonly candidates: readonly AgentNodeFailureCandidate[];
}

export interface FailoverClaimInput {
  operationId: string;
  leaseOwner: string;
  leaseMs?: number;
}

/** Exact DB-clock claim receipt. Callers never compare expiry against host time. */
export interface FailoverClaimReceipt {
  readonly operation: AgentFailoverOperation;
  readonly leaseOwner: string;
  readonly leaseGeneration: string;
  readonly expiresAt: Date;
  readonly databaseNow: Date;
}

export type FailoverLeaseRenewal =
  | { readonly renewed: true; readonly expiresAt: Date; readonly databaseNow: Date }
  | { readonly renewed: false; readonly reason: "settled" | "lost" };

export interface BeginStepAttemptInput {
  operationId: string;
  leaseOwner: string;
  leaseGeneration: string;
  step: AgentFailoverStep;
  detail?: Record<string, unknown>;
}

export interface SettleStepAttemptInput {
  operationId: string;
  leaseOwner: string;
  leaseGeneration: string;
  step: AgentFailoverStep;
  attempt: number;
  outcome: "succeeded" | "failed" | "abandoned";
  detail?: Record<string, unknown>;
}

export interface ReconcileStepAttemptInput {
  operationId: string;
  leaseOwner: string;
  leaseGeneration: string;
  step: AgentFailoverStep;
  attempt: number;
  action: AgentFailoverReconcileAction;
  /** Evidence inspected before deciding. The guard requires it to be non-empty. */
  detail: Record<string, unknown>;
}

/**
 * The target authority and container identity the cutover will publish.
 *
 * Persisted before the first publish attempt so an unknown outcome can be
 * resolved by replaying the same identities rather than guessing whether the
 * cutover happened.
 */
export interface CutoverIdentityInput {
  operationId: string;
  leaseOwner: string;
  leaseGeneration: string;
  targetPublicationId: string;
  targetActivationGeneration: string;
  targetLifecycleRevision: bigint;
  targetContainerId: string;
  targetReceiptSha256: string;
  targetNodeRecordId: string;
  targetNodeIncarnation: string;
  targetNodeHistoryId: string;
}

/** References to the restore authority that owns the lease, the slot, and the attempt. */
export interface RestoreAdmissionReferenceInput {
  operationId: string;
  leaseOwner: string;
  leaseGeneration: string;
  restoreOperationId: string;
  restoreLeaseId: string;
  restoreLeaseOwner: string;
  restoreLeaseGeneration: string;
  restoreBackupId: string;
  restoreManifestSha256: string;
  replacementAttemptId?: string;
}

/** One step's durable position, derived from the attempt journal. */
export interface FailoverStepProgress {
  readonly step: AgentFailoverStep;
  readonly attempts: number;
  readonly latestAttempt: number;
  readonly latestState: AgentFailoverAttemptState | null;
  readonly unresolvedAttempt: number | null;
  readonly lastFinishedAt: Date | null;
}

export interface FailoverOperationResume {
  readonly operation: AgentFailoverOperation;
  readonly steps: readonly FailoverStepProgress[];
  readonly succeededSteps: readonly AgentFailoverStep[];
  readonly unresolved: { readonly step: AgentFailoverStep; readonly attempt: number } | null;
  readonly nextStep: AgentFailoverStep | null;
  readonly cutoverCommitted: boolean;
}

/**
 * The reported recovery point objective gap.
 *
 * `to` is set only by a committed cutover, so an unfinished or failed attempt
 * never presents itself as the end of the gap.
 */
export interface FailoverRpoGap {
  readonly from: Date;
  readonly to: Date | null;
  readonly cutoverCommitted: boolean;
}

function requireLifecycleRevision(value: number | bigint, field: string): bigint {
  const asBigInt = typeof value === "bigint" ? value : BigInt(value);
  if (asBigInt < 0n) {
    throw new AgentFailoverConflictError(
      "AGENT_FAILOVER_SOURCE_REVISION_INVALID",
      `${field} must be a non-negative int64 revision`,
    );
  }
  return asBigInt;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AgentFailoverConflictError(
      "AGENT_FAILOVER_INPUT_INVALID",
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function boundedLeaseMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
    throw new AgentFailoverConflictError(
      "AGENT_FAILOVER_INPUT_INVALID",
      `leaseMs must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`,
    );
  }
  return value;
}

function leaseHorizonSql(leaseMs: number) {
  return sql`clock_timestamp() + (${leaseMs} * INTERVAL '1 millisecond')`;
}

function timestampParam(value: Date) {
  return sql`${value.toISOString()}::timestamptz`;
}

/**
 * Durable reads and fenced writes for node-failure records and failover work.
 *
 * Every method that mutates failover state takes the executor's
 * `(leaseOwner, leaseGeneration)` and refuses a generation that no longer holds a
 * live lease, so a resumed process can never act on stale in-memory position.
 */
export class AgentFailoverRepository {
  // ==========================================================================
  // READ OPERATIONS
  // ==========================================================================

  async findFailureRecord(failureEventId: string): Promise<AgentNodeFailureEvent | null> {
    const [event] = await dbRead
      .select()
      .from(agentNodeFailureEvents)
      .where(eq(agentNodeFailureEvents.id, failureEventId))
      .limit(1);
    return event ?? null;
  }

  async findOpenFailureRecordForOccurrence(input: {
    nodeRecordId: string;
    nodeHistoryId: string;
  }): Promise<AgentNodeFailureEvent | null> {
    const [event] = await dbRead
      .select()
      .from(agentNodeFailureEvents)
      .where(
        and(
          eq(agentNodeFailureEvents.node_record_id, input.nodeRecordId),
          eq(agentNodeFailureEvents.node_history_id, input.nodeHistoryId),
          sql`${agentNodeFailureEvents.status} IN ('collecting', 'triggered')`,
        ),
      )
      .limit(1);
    return event ?? null;
  }

  async findSignals(failureEventId: string): Promise<AgentNodeFailureSignal[]> {
    return dbRead
      .select()
      .from(agentNodeFailureSignals)
      .where(eq(agentNodeFailureSignals.failure_event_id, failureEventId))
      .orderBy(asc(agentNodeFailureSignals.kind), asc(agentNodeFailureSignals.source));
  }

  async findCandidates(failureEventId: string): Promise<AgentNodeFailureCandidate[]> {
    return dbRead
      .select()
      .from(agentNodeFailureCandidates)
      .where(eq(agentNodeFailureCandidates.failure_event_id, failureEventId))
      .orderBy(asc(agentNodeFailureCandidates.agent_id));
  }

  async findOperation(operationId: string): Promise<AgentFailoverOperation | null> {
    const [operation] = await dbRead
      .select()
      .from(agentFailoverOperations)
      .where(eq(agentFailoverOperations.id, operationId))
      .limit(1);
    return operation ?? null;
  }

  async findActiveOperationForAgent(agentId: string): Promise<AgentFailoverOperation | null> {
    const [operation] = await dbRead
      .select()
      .from(agentFailoverOperations)
      .where(
        and(
          eq(agentFailoverOperations.agent_id, agentId),
          sql`${agentFailoverOperations.status} IN ${NON_TERMINAL_STATUS_SQL}`,
        ),
      )
      .orderBy(asc(agentFailoverOperations.created_at))
      .limit(1);
    return operation ?? null;
  }

  /**
   * Reconstructs position from the journal, not from memory.
   *
   * `unresolved` names an attempt that was opened and never settled; the guard
   * refuses to run that step again until it is reconciled, so the caller must
   * inspect the effect the interrupted attempt may have produced.
   */
  async readOperationResume(operationId: string): Promise<FailoverOperationResume | null> {
    const operation = await this.findOperation(operationId);
    if (!operation) return null;
    const attempts = await dbRead
      .select()
      .from(agentFailoverStepAttempts)
      .where(eq(agentFailoverStepAttempts.operation_id, operationId))
      .orderBy(asc(agentFailoverStepAttempts.attempt));

    const steps: FailoverStepProgress[] = [];
    const succeededSteps: AgentFailoverStep[] = [];
    let unresolved: { step: AgentFailoverStep; attempt: number } | null = null;
    let nextStep: AgentFailoverStep | null = null;
    let cutoverCommitted = false;

    for (const step of AGENT_FAILOVER_STEPS) {
      const forStep = attempts.filter((attempt) => attempt.step === step);
      const latest = forStep[forStep.length - 1];
      if (!latest) {
        steps.push({
          step,
          attempts: 0,
          latestAttempt: 0,
          latestState: null,
          unresolvedAttempt: null,
          lastFinishedAt: null,
        });
        if (nextStep === null) nextStep = step;
        continue;
      }
      const stepUnresolved = UNRESOLVED_ATTEMPT_STATES.includes(latest.state);
      steps.push({
        step,
        attempts: forStep.length,
        latestAttempt: latest.attempt,
        latestState: latest.state,
        unresolvedAttempt: stepUnresolved ? latest.attempt : null,
        lastFinishedAt: latest.finished_at,
      });
      const settled =
        latest.state === "succeeded" ||
        (latest.state === "reconciled" && latest.reconcile_action === "continued");
      if (settled) {
        succeededSteps.push(step);
        if (step === "cutover") cutoverCommitted = true;
      } else if (nextStep === null) {
        // The unresolved step is also the resume point: reconciliation decides
        // whether it continues or runs again, and the guard refuses it until then.
        nextStep = step;
      }
      if (stepUnresolved && unresolved === null) {
        unresolved = { step, attempt: latest.attempt };
      }
    }

    return { operation, steps, succeededSteps, unresolved, nextStep, cutoverCommitted };
  }

  /**
   * The durable recovery point objective gap.
   *
   * The upper bound comes only from a committed cutover — a succeeded attempt or
   * one reconciled as continued. A failed or still-unresolved cutover does not
   * end the gap, because nothing was published at that instant.
   */
  async readRpoGap(operationId: string): Promise<FailoverRpoGap | null> {
    const resume = await this.readOperationResume(operationId);
    if (!resume?.operation.source_data_watermark_at) return null;
    const cutover = resume.steps.find((step) => step.step === "cutover");
    return {
      from: resume.operation.source_data_watermark_at,
      to: resume.cutoverCommitted ? (cutover?.lastFinishedAt ?? null) : null,
      cutoverCommitted: resume.cutoverCommitted,
    };
  }

  // ==========================================================================
  // FAILURE RECORDS
  // ==========================================================================

  /**
   * Opens (or returns) the single open fault record for one node occurrence.
   *
   * Idempotent on `(node_record_id, node_incarnation, node_history_id)`, so two
   * processes that notice the same outage converge on one record.
   */
  async openFailureRecord(input: OpenFailureRecordInput): Promise<AgentNodeFailureEvent> {
    return writeTransaction(async (tx) => {
      const [opened] = await tx
        .insert(agentNodeFailureEvents)
        .values({
          node_record_id: input.nodeRecordId,
          node_id: input.nodeId,
          node_incarnation: input.nodeIncarnation,
          node_history_id: input.nodeHistoryId,
          corroboration_required: input.corroborationRequired ?? 2,
        })
        .onConflictDoNothing({
          target: [
            agentNodeFailureEvents.node_record_id,
            agentNodeFailureEvents.node_incarnation,
            agentNodeFailureEvents.node_history_id,
          ],
          // The open-occurrence index is partial, so the predicate must be part
          // of the conflict target for PostgreSQL to infer it.
          where: sql`${agentNodeFailureEvents.status} IN ('collecting', 'triggered')`,
        })
        .returning();
      if (opened) return opened;
      const [existing] = await tx
        .select()
        .from(agentNodeFailureEvents)
        .where(
          and(
            eq(agentNodeFailureEvents.node_record_id, input.nodeRecordId),
            eq(agentNodeFailureEvents.node_incarnation, input.nodeIncarnation),
            eq(agentNodeFailureEvents.node_history_id, input.nodeHistoryId),
            sql`${agentNodeFailureEvents.status} IN ('collecting', 'triggered')`,
          ),
        )
        .for("update");
      if (!existing) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_UNAVAILABLE",
          "The open fault record for this node occurrence disappeared during open",
        );
      }
      return existing;
    });
  }

  /**
   * Records one observation and returns the record's corroboration standing.
   *
   * The independence class and policy version are resolved from the declared
   * table, never supplied by the caller, so a new probe cannot claim independence
   * it was not granted. Repeated observations from one source increment a counter
   * instead of widening the evidence.
   */
  async recordFailureSignal(
    input: RecordFailureSignalInput,
  ): Promise<FailureCorroborationStanding> {
    const sourceClass = DECLARED_SOURCE_CLASSES[input.source];
    if (!sourceClass) {
      throw new AgentFailoverConflictError(
        "AGENT_FAILOVER_SIGNAL_SOURCE_UNKNOWN",
        `${input.source} is not a controlled observation source`,
      );
    }
    return writeTransaction(async (tx) => {
      const [current] = await tx
        .select({ status: agentNodeFailureEvents.status })
        .from(agentNodeFailureEvents)
        .where(eq(agentNodeFailureEvents.id, input.failureEventId))
        .for("update");
      if (!current) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }
      if (current.status !== "collecting") {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_CLOSED",
          `Fault record ${input.failureEventId} is ${current.status}; evidence is frozen once it leaves collection`,
        );
      }

      const observedAt = input.observedAt
        ? sql`${input.observedAt.toISOString()}::timestamptz`
        : null;
      await tx
        .insert(agentNodeFailureSignals)
        .values({
          failure_event_id: input.failureEventId,
          kind: input.kind,
          source: input.source,
          source_class: sourceClass,
          policy_version: AGENT_FAILOVER_OBSERVATION_POLICY_VERSION,
          detail: input.detail ?? {},
          ...(observedAt ? { first_observed_at: observedAt, last_observed_at: observedAt } : {}),
        })
        .onConflictDoUpdate({
          target: [
            agentNodeFailureSignals.failure_event_id,
            agentNodeFailureSignals.kind,
            agentNodeFailureSignals.source,
          ],
          set: {
            observation_count: sql`${agentNodeFailureSignals.observation_count} + 1`,
            last_observed_at: observedAt
              ? sql`GREATEST(${agentNodeFailureSignals.last_observed_at}, ${observedAt})`
              : sql`GREATEST(${agentNodeFailureSignals.last_observed_at}, clock_timestamp())`,
            detail: input.detail ?? {},
          },
        });

      const [event] = await tx
        .update(agentNodeFailureEvents)
        .set({
          last_observed_at: sql`GREATEST(
            ${agentNodeFailureEvents.last_observed_at},
            (SELECT MAX(signal.last_observed_at) FROM ${agentNodeFailureSignals} signal
              WHERE signal.failure_event_id = ${input.failureEventId})
          )`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(agentNodeFailureEvents.id, input.failureEventId))
        .returning();
      if (!event) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }

      const counts = await this.readCorroborationCounts(tx, input.failureEventId);
      return {
        event,
        distinctKinds: counts.distinctKinds,
        distinctClasses: counts.distinctClasses,
        observations: counts.observations,
        required: event.corroboration_required,
        corroborated:
          counts.distinctKinds >= 2 &&
          counts.distinctClasses >= 2 &&
          counts.observations >= event.corroboration_required,
      };
    });
  }

  /**
   * Moves a fault record to `triggered`.
   *
   * Refuses without cross-class corroboration. The refusal is repeated by the
   * schema guard, so a direct SQL path cannot trigger on one failure domain
   * either. Triggering starts recovery work; it does not establish that the node
   * is dead.
   */
  async triggerFailureRecord(input: { failureEventId: string }): Promise<AgentNodeFailureEvent> {
    return writeTransaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(agentNodeFailureEvents)
        .where(eq(agentNodeFailureEvents.id, input.failureEventId))
        .for("update");
      if (!current) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }
      if (current.status === "triggered") return current;
      if (current.status !== "collecting") {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_CLOSED",
          `Fault record ${input.failureEventId} is ${current.status} and cannot be triggered`,
        );
      }

      const counts = await this.readCorroborationCounts(tx, input.failureEventId);
      if (
        counts.distinctKinds < 2 ||
        counts.distinctClasses < 2 ||
        counts.observations < current.corroboration_required
      ) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_TRIGGER_UNCORROBORATED",
          `Fault record ${input.failureEventId} has ${counts.distinctKinds} kind(s) from ${counts.distinctClasses} independence class(es) across ${counts.observations} observation(s); ${current.corroboration_required} observations from at least two kinds and two classes are required`,
        );
      }

      const [triggered] = await tx
        .update(agentNodeFailureEvents)
        .set({
          status: "triggered",
          triggered_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentNodeFailureEvents.id, input.failureEventId),
            eq(agentNodeFailureEvents.status, "collecting"),
          ),
        )
        .returning();
      if (!triggered) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_CLOSED",
          `Fault record ${input.failureEventId} changed state during the trigger`,
        );
      }
      return triggered;
    });
  }

  /** Closes a fault record as recovered (`cleared`) or expired (`inconclusive`). */
  async closeFailureRecord(input: {
    failureEventId: string;
    status: "cleared" | "inconclusive";
    reason: string;
  }): Promise<AgentNodeFailureEvent> {
    return writeTransaction(async (tx) => {
      // The event row is locked first so a concurrent openOperation either lands
      // before this check or waits for it — never after the withdrawal.
      const [event] = await tx
        .select()
        .from(agentNodeFailureEvents)
        .where(eq(agentNodeFailureEvents.id, input.failureEventId))
        .for("update");
      if (!event) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }
      // Withdrawing a trigger is only honest once nothing is mid-recovery: a
      // live operation holds a restore lease and a target authority, and
      // abandoning it silently would strand both.
      const [outstanding] = await tx
        .select({ status: agentFailoverOperations.status })
        .from(agentFailoverOperations)
        .where(
          and(
            eq(agentFailoverOperations.failure_event_id, input.failureEventId),
            sql`${agentFailoverOperations.status} IN ${NON_TERMINAL_STATUS_SQL}`,
          ),
        )
        .limit(1);
      if (outstanding) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_OPERATIONS_OUTSTANDING",
          `Fault record ${input.failureEventId} still has a ${outstanding.status} failover operation; cancel or complete it before withdrawing the trigger`,
        );
      }
      const [closed] = await tx
        .update(agentNodeFailureEvents)
        .set({
          status: input.status,
          closed_at: sql`clock_timestamp()`,
          closure_reason: input.reason,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentNodeFailureEvents.id, input.failureEventId),
            sql`${agentNodeFailureEvents.status} IN ('collecting', 'triggered')`,
          ),
        )
        .returning();
      if (!closed) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_CLOSED",
          `Fault record ${input.failureEventId} is already closed`,
        );
      }
      return closed;
    });
  }

  /**
   * Cordons the failed node and freezes the Agent set against it, atomically.
   *
   * One transaction takes the occurrence lock, verifies the node record still
   * answers to the frozen occurrence, cordons it, and writes one candidate row per
   * Agent whose *current* activation publication authorizes it on that
   * occurrence. Enumeration therefore cannot race a concurrent placement, and a
   * later placement is excluded by construction.
   *
   * Uncordoning is deliberately absent: reopening a node is a node-level recovery
   * decision, because the same node may carry other fault records or migrations.
   */
  async cordonAndFreezeFailure(input: { failureEventId: string }): Promise<FailureFreezeOutcome> {
    return writeTransaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(agentNodeFailureEvents)
        .where(eq(agentNodeFailureEvents.id, input.failureEventId))
        .for("update");
      if (!event) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }
      if (event.status !== "triggered") {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_EVENT_NOT_TRIGGERED",
          `Fault record ${input.failureEventId} is ${event.status}; only a triggered failure cordons and freezes`,
        );
      }
      if (event.enumerated_at !== null) {
        const candidates = await tx
          .select()
          .from(agentNodeFailureCandidates)
          .where(eq(agentNodeFailureCandidates.failure_event_id, input.failureEventId));
        return { event, candidates };
      }

      const [node] = await tx
        .select({
          id: dockerNodes.id,
          node_id: dockerNodes.node_id,
          node_incarnation: dockerNodes.node_incarnation,
          current_node_history_id: dockerNodes.current_node_history_id,
        })
        .from(dockerNodes)
        .where(eq(dockerNodes.id, event.node_record_id))
        .for("update");
      if (!node) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_NODE_NOT_FOUND",
          `No node record ${event.node_record_id}`,
        );
      }
      if (
        node.node_id !== event.node_id ||
        node.node_incarnation !== event.node_incarnation ||
        node.current_node_history_id !== event.node_history_id
      ) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_OCCURRENCE_SUPERSEDED",
          `Node record ${event.node_record_id} no longer answers to the frozen occurrence; refusing to cordon a replacement`,
        );
      }

      // The frozen set comes from the publications that authorize each Agent on
      // this exact occurrence, never from the reusable node handle.
      const authorized = await tx
        .select({
          organization_id: agentActivationPublications.organization_id,
          agent_id: agentActivationPublications.agent_id,
          publication_id: agentActivationPublications.id,
          activation_generation: agentActivationPublications.activation_generation,
          lifecycle_revision: agentActivationPublications.lifecycle_revision,
          container_id: agentActivationPublications.container_id,
          container_name: agentSandboxes.container_name,
        })
        .from(agentActivationPublications)
        .innerJoin(
          agentSandboxes,
          and(
            eq(agentSandboxes.id, agentActivationPublications.agent_id),
            eq(agentSandboxes.organization_id, agentActivationPublications.organization_id),
            eq(
              agentSandboxes.activation_generation,
              agentActivationPublications.activation_generation,
            ),
          ),
        )
        .where(
          and(
            eq(agentActivationPublications.node_history_id, event.node_history_id),
            eq(agentActivationPublications.node_incarnation, event.node_incarnation),
            eq(agentActivationPublications.docker_node_record_id, event.node_record_id),
          ),
        )
        .for("share");

      await tx
        .update(dockerNodes)
        .set({ placement_state: "cordoned", updated_at: sql`clock_timestamp()` })
        .where(eq(dockerNodes.id, event.node_record_id));

      const candidates: AgentNodeFailureCandidate[] = [];
      for (const row of authorized) {
        const [candidate] = await tx
          .insert(agentNodeFailureCandidates)
          .values({
            failure_event_id: event.id,
            organization_id: row.organization_id,
            agent_id: row.agent_id,
            source_publication_id: row.publication_id,
            source_activation_generation: row.activation_generation,
            source_lifecycle_revision: row.lifecycle_revision,
            source_container_id: row.container_id,
            source_container_name: row.container_name,
          })
          .onConflictDoNothing({
            target: [
              agentNodeFailureCandidates.failure_event_id,
              agentNodeFailureCandidates.agent_id,
            ],
          })
          .returning();
        if (candidate) candidates.push(candidate);
      }

      const [frozen] = await tx
        .update(agentNodeFailureEvents)
        .set({
          cordoned_at: sql`COALESCE(${agentNodeFailureEvents.cordoned_at}, clock_timestamp())`,
          enumerated_at: sql`COALESCE(${agentNodeFailureEvents.enumerated_at}, clock_timestamp())`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(agentNodeFailureEvents.id, event.id))
        .returning();
      if (!frozen) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }
      return { event: frozen, candidates };
    });
  }

  // ==========================================================================
  // FAILOVER OPERATIONS
  // ==========================================================================

  /**
   * Opens the recovery operation for one Agent from its frozen candidate row.
   *
   * The source authority is copied from the frozen candidate, not read live, so
   * the operation replaces exactly the instance that was recorded on the failed
   * occurrence. An Agent outside the frozen set cannot be opened at all, and a
   * second active operation for the same Agent is a conflict rather than a
   * duplicate recovery.
   */
  async openOperation(input: {
    failureEventId: string;
    agentId: string;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(agentNodeFailureEvents)
        .where(eq(agentNodeFailureEvents.id, input.failureEventId))
        .for("share");
      if (!event) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_FAILURE_RECORD_NOT_FOUND",
          `No fault record ${input.failureEventId}`,
        );
      }
      if (event.status !== "triggered") {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_EVENT_NOT_TRIGGERED",
          `Fault record ${input.failureEventId} is ${event.status}; a withdrawn trigger opens no recovery work`,
        );
      }
      const [candidate] = await tx
        .select()
        .from(agentNodeFailureCandidates)
        .where(
          and(
            eq(agentNodeFailureCandidates.failure_event_id, input.failureEventId),
            eq(agentNodeFailureCandidates.agent_id, input.agentId),
          ),
        )
        .for("share");
      if (!candidate) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_AGENT_NOT_FROZEN",
          `Agent ${input.agentId} is not in the frozen set for fault record ${input.failureEventId}`,
        );
      }

      const [sameFault] = await tx
        .select()
        .from(agentFailoverOperations)
        .where(
          and(
            eq(agentFailoverOperations.failure_event_id, input.failureEventId),
            eq(agentFailoverOperations.agent_id, input.agentId),
          ),
        )
        .limit(1);
      if (sameFault) return sameFault;

      const [otherActive] = await tx
        .select()
        .from(agentFailoverOperations)
        .where(
          and(
            eq(agentFailoverOperations.agent_id, input.agentId),
            sql`${agentFailoverOperations.status} IN ${NON_TERMINAL_STATUS_SQL}`,
          ),
        )
        .limit(1);
      if (otherActive) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ALREADY_ACTIVE",
          `Agent ${input.agentId} already has failover operation ${otherActive.id} under fault record ${otherActive.failure_event_id}`,
          { operationId: otherActive.id },
        );
      }

      const [opened] = await tx
        .insert(agentFailoverOperations)
        .values({
          failure_event_id: input.failureEventId,
          organization_id: candidate.organization_id,
          agent_id: candidate.agent_id,
          source_node_record_id: event.node_record_id,
          source_node_id: event.node_id,
          source_node_incarnation: event.node_incarnation,
          source_node_history_id: event.node_history_id,
          source_container_name: candidate.source_container_name,
          source_publication_id: candidate.source_publication_id,
          source_activation_generation: candidate.source_activation_generation,
          source_lifecycle_revision: requireLifecycleRevision(
            candidate.source_lifecycle_revision,
            "source lifecycle revision",
          ),
          source_container_id: candidate.source_container_id,
        })
        .returning();
      if (!opened) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_OPERATION_UNAVAILABLE",
          `Failover operation for agent ${input.agentId} disappeared during open`,
        );
      }
      return opened;
    });
  }

  /**
   * Claims one specific operation.
   *
   * The compare-and-set is on an absent or expired lease horizon, so a claim
   * cannot displace a live executor. A fresh claim rotates `lease_generation`,
   * which is the fence every later write is checked against.
   */
  async claimOperation(input: FailoverClaimInput): Promise<FailoverClaimReceipt | null> {
    const leaseMs = boundedLeaseMs(input.leaseMs);
    return writeTransaction(async (tx) => {
      const [claimed] = await tx
        .update(agentFailoverOperations)
        .set({
          lease_owner: input.leaseOwner,
          lease_generation: sql`gen_random_uuid()`,
          lease_expires_at: leaseHorizonSql(leaseMs),
          lease_heartbeat_at: sql`clock_timestamp()`,
          claim_count: sql`${agentFailoverOperations.claim_count} + 1`,
          status: sql`CASE WHEN ${agentFailoverOperations.status} = 'pending' THEN 'running' ELSE ${agentFailoverOperations.status} END`,
          started_at: sql`COALESCE(${agentFailoverOperations.started_at}, clock_timestamp())`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            sql`${agentFailoverOperations.status} IN ('pending', 'running', 'awaiting_capacity',
              'restore_release_required')`,
            sql`${agentFailoverOperations.next_attempt_at} <= clock_timestamp()`,
            sql`(${agentFailoverOperations.lease_generation} IS NULL OR ${agentFailoverOperations.lease_expires_at} <= clock_timestamp())`,
            // An exhausted wait is escalated, never re-claimed.
            sql`(${agentFailoverOperations.wait_deadline_at} IS NULL
              OR ${agentFailoverOperations.wait_deadline_at} > clock_timestamp())`,
          ),
        )
        .returning();
      if (!claimed) return null;
      return this.claimReceipt(tx, claimed, input.leaseOwner);
    });
  }

  /**
   * Claims the earliest due operation, or returns null.
   *
   * The candidate row is locked with `SKIP LOCKED` and the claim re-checks the
   * horizon, so two workers polling at the same time cannot both be handed the
   * same operation.
   */
  async claimNextOperation(input: {
    leaseOwner: string;
    leaseMs?: number;
  }): Promise<FailoverClaimReceipt | null> {
    const leaseMs = boundedLeaseMs(input.leaseMs);
    return writeTransaction(async (tx) => {
      const [candidate] = await tx
        .select({ id: agentFailoverOperations.id })
        .from(agentFailoverOperations)
        .where(
          and(
            sql`${agentFailoverOperations.status} IN ('pending', 'running', 'awaiting_capacity',
              'restore_release_required')`,
            sql`${agentFailoverOperations.next_attempt_at} <= clock_timestamp()`,
            sql`(${agentFailoverOperations.lease_generation} IS NULL OR ${agentFailoverOperations.lease_expires_at} <= clock_timestamp())`,
            sql`(${agentFailoverOperations.wait_deadline_at} IS NULL
              OR ${agentFailoverOperations.wait_deadline_at} > clock_timestamp())`,
          ),
        )
        .orderBy(
          asc(agentFailoverOperations.next_attempt_at),
          asc(agentFailoverOperations.created_at),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;

      const [claimed] = await tx
        .update(agentFailoverOperations)
        .set({
          lease_owner: input.leaseOwner,
          lease_generation: sql`gen_random_uuid()`,
          lease_expires_at: leaseHorizonSql(leaseMs),
          lease_heartbeat_at: sql`clock_timestamp()`,
          claim_count: sql`${agentFailoverOperations.claim_count} + 1`,
          status: sql`CASE WHEN ${agentFailoverOperations.status} = 'pending' THEN 'running' ELSE ${agentFailoverOperations.status} END`,
          started_at: sql`COALESCE(${agentFailoverOperations.started_at}, clock_timestamp())`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(agentFailoverOperations.id, candidate.id))
        .returning();
      if (!claimed) return null;
      return this.claimReceipt(tx, claimed, input.leaseOwner);
    });
  }

  /**
   * Extends the lease horizon.
   *
   * An expired lease is never revived: the executor must claim again, which
   * rotates the generation and forces its interrupted attempt through
   * reconciliation before the step may run again.
   */
  async renewOperationLease(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    leaseMs?: number;
  }): Promise<FailoverLeaseRenewal> {
    const leaseMs = boundedLeaseMs(input.leaseMs);
    return writeTransaction(async (tx) => {
      const [renewed] = await tx
        .update(agentFailoverOperations)
        .set({
          lease_expires_at: leaseHorizonSql(leaseMs),
          lease_heartbeat_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running')`,
          ),
        )
        .returning();
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (renewed?.lease_expires_at) {
        return { renewed: true, expiresAt: renewed.lease_expires_at, databaseNow };
      }
      const [current] = await tx
        .select({ status: agentFailoverOperations.status })
        .from(agentFailoverOperations)
        .where(eq(agentFailoverOperations.id, input.operationId));
      if (current && !NON_TERMINAL_STATUSES.includes(current.status)) {
        return { renewed: false, reason: "settled" };
      }
      return { renewed: false, reason: "lost" };
    });
  }

  /** Drops the lease fence without settling the operation. */
  async releaseOperationLease(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
  }): Promise<boolean> {
    return writeTransaction(async (tx) => {
      const [released] = await tx
        .update(agentFailoverOperations)
        .set({
          lease_owner: null,
          lease_generation: null,
          lease_expires_at: null,
          lease_heartbeat_at: null,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
          ),
        )
        .returning({ id: agentFailoverOperations.id });
      return released !== undefined;
    });
  }

  // ==========================================================================
  // STEP JOURNAL
  // ==========================================================================

  /**
   * Opens the next attempt of the current step, or of its immediate successor.
   *
   * Advancing is allowed only when the current step actually succeeded, so a
   * completion can never be reached by skipping the steps that justify it. The
   * attempt ordinal is derived from the journal inside the operation row lock and
   * re-verified by the guard.
   */
  async beginStepAttempt(
    input: BeginStepAttemptInput,
  ): Promise<{ attempt: AgentFailoverStepAttempt; operation: AgentFailoverOperation }> {
    return writeTransaction(async (tx) => {
      const held = await this.assertLiveLease(tx, input);
      const heldIndex = AGENT_FAILOVER_STEPS.indexOf(held.step);
      const targetIndex = AGENT_FAILOVER_STEPS.indexOf(input.step);
      if (targetIndex === heldIndex + 1) {
        if (held.step_state !== "succeeded") {
          throw new AgentFailoverConflictError(
            "AGENT_FAILOVER_STEP_NOT_COMPLETE",
            `Operation ${input.operationId} is on ${held.step} (${held.step_state}) and cannot advance to ${input.step}`,
            { operationId: input.operationId },
          );
        }
      } else if (targetIndex !== heldIndex) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_STEP_NOT_ADJACENT",
          `Operation ${input.operationId} is on ${held.step} and may only advance to ${
            AGENT_FAILOVER_STEPS[heldIndex + 1] ?? "no further step"
          }, not ${input.step}`,
          { operationId: input.operationId },
        );
      } else if (held.step_state === "succeeded") {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_STEP_ALREADY_SUCCEEDED",
          `Step ${input.step} on operation ${input.operationId} already succeeded; advance to the next step`,
          { operationId: input.operationId },
        );
      }

      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          step: input.step,
          step_state: "in_progress",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running')`,
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }

      const [previous] = await tx
        .select({
          attempt: agentFailoverStepAttempts.attempt,
          state: agentFailoverStepAttempts.state,
        })
        .from(agentFailoverStepAttempts)
        .where(
          and(
            eq(agentFailoverStepAttempts.operation_id, input.operationId),
            eq(agentFailoverStepAttempts.step, input.step),
          ),
        )
        .orderBy(desc(agentFailoverStepAttempts.attempt))
        .limit(1);
      if (previous && !SETTLED_ATTEMPT_STATES.includes(previous.state)) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ATTEMPT_UNRESOLVED",
          `Attempt ${previous.attempt} of step ${input.step} on operation ${input.operationId} is ${previous.state}; it must be reconciled before the step runs again`,
          { operationId: input.operationId },
        );
      }

      const [attempt] = await tx
        .insert(agentFailoverStepAttempts)
        .values({
          operation_id: input.operationId,
          step: input.step,
          attempt: (previous?.attempt ?? 0) + 1,
          state: "started",
          lease_owner: input.leaseOwner,
          lease_generation: input.leaseGeneration,
          detail: input.detail ?? {},
        })
        .returning();
      if (!attempt) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ATTEMPT_UNAVAILABLE",
          `Attempt for step ${input.step} of operation ${input.operationId} was not created`,
          { operationId: input.operationId },
        );
      }
      return { attempt, operation };
    });
  }

  /** Settles an open attempt. Only the generation that opened it may settle it. */
  async settleStepAttempt(
    input: SettleStepAttemptInput,
  ): Promise<{ attempt: AgentFailoverStepAttempt; operation: AgentFailoverOperation }> {
    return writeTransaction(async (tx) => {
      await this.assertLiveLease(tx, input);
      const [attempt] = await tx
        .update(agentFailoverStepAttempts)
        .set({
          state: input.outcome,
          finished_at: sql`clock_timestamp()`,
          detail: input.detail ?? {},
        })
        .where(
          and(
            eq(agentFailoverStepAttempts.operation_id, input.operationId),
            eq(agentFailoverStepAttempts.step, input.step),
            eq(agentFailoverStepAttempts.attempt, input.attempt),
            eq(agentFailoverStepAttempts.state, "started"),
          ),
        )
        .returning();
      if (!attempt) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ATTEMPT_NOT_OPEN",
          `Attempt ${input.attempt} of step ${input.step} on operation ${input.operationId} is not open for settlement`,
          { operationId: input.operationId },
        );
      }
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          step_state: input.outcome === "succeeded" ? "succeeded" : "failed",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }
      return { attempt, operation };
    });
  }

  /**
   * Marks an attempt left behind by a previous executor as unresolved.
   *
   * Requires a fresh lease generation, so the executor that abandoned the attempt
   * cannot mark its own work clean. The operation status moves with the step, as
   * the guard requires they agree.
   */
  async markAttemptAwaitingReconcile(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    step: AgentFailoverStep;
    attempt: number;
    detail?: Record<string, unknown>;
  }): Promise<{ attempt: AgentFailoverStepAttempt; operation: AgentFailoverOperation }> {
    return writeTransaction(async (tx) => {
      await this.assertLiveLease(tx, input);
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          step_state: "awaiting_reconcile",
          status: "awaiting_reconcile",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            eq(agentFailoverOperations.step, input.step),
            eq(agentFailoverOperations.step_state, "in_progress"),
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }
      const [attempt] = await tx
        .update(agentFailoverStepAttempts)
        .set({
          state: "awaiting_reconcile",
          finished_at: sql`clock_timestamp()`,
          detail: input.detail ?? {},
        })
        .where(
          and(
            eq(agentFailoverStepAttempts.operation_id, input.operationId),
            eq(agentFailoverStepAttempts.step, input.step),
            eq(agentFailoverStepAttempts.attempt, input.attempt),
            eq(agentFailoverStepAttempts.state, "started"),
          ),
        )
        .returning();
      if (!attempt) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ATTEMPT_NOT_OPEN",
          `Attempt ${input.attempt} of step ${input.step} on operation ${input.operationId} is not open to be marked unresolved`,
          { operationId: input.operationId },
        );
      }
      return { attempt, operation };
    });
  }

  /**
   * Records the resume decision for an interrupted attempt.
   *
   * `continued` treats the interrupted attempt as having taken effect, `retried`
   * reopens the step, and `abandoned` fails the step. The evidence inspected to
   * reach the decision is required and the schema guard rejects an empty one, so
   * a reconcile cannot be recorded by assumption. For an unknown `cutover`, the
   * decision is normally `continued`: replaying the publication with the same
   * identities is what establishes whether it happened.
   */
  async reconcileStepAttempt(
    input: ReconcileStepAttemptInput,
  ): Promise<{ attempt: AgentFailoverStepAttempt; operation: AgentFailoverOperation }> {
    if (Object.keys(input.detail).length === 0) {
      throw new AgentFailoverConflictError(
        "AGENT_FAILOVER_RECONCILE_EVIDENCE_REQUIRED",
        "Reconciliation must record the evidence it inspected",
        { operationId: input.operationId },
      );
    }
    const stepState =
      input.action === "continued"
        ? "succeeded"
        : input.action === "retried"
          ? "not_started"
          : "failed";
    return writeTransaction(async (tx) => {
      await this.assertLiveLease(tx, input);
      // The attempt settles while the operation still reads `awaiting_reconcile`:
      // the guard ties the reconciled transition to that step state.
      const [attempt] = await tx
        .update(agentFailoverStepAttempts)
        .set({
          state: "reconciled",
          reconcile_action: input.action,
          detail: input.detail,
        })
        .where(
          and(
            eq(agentFailoverStepAttempts.operation_id, input.operationId),
            eq(agentFailoverStepAttempts.step, input.step),
            eq(agentFailoverStepAttempts.attempt, input.attempt),
            sql`${agentFailoverStepAttempts.state} IN ('started', 'awaiting_reconcile')`,
          ),
        )
        .returning();
      if (!attempt) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ATTEMPT_NOT_OPEN",
          `Attempt ${input.attempt} of step ${input.step} on operation ${input.operationId} is not awaiting reconciliation`,
          { operationId: input.operationId },
        );
      }
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          step_state: stepState,
          status: "running",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            eq(agentFailoverOperations.step, input.step),
            eq(agentFailoverOperations.status, "awaiting_reconcile"),
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }
      return { attempt, operation };
    });
  }

  // ==========================================================================
  // PRE-CONDITIONS, TARGET AUTHORITY, COMPLETION
  // ==========================================================================

  /**
   * Records the data watermark the chosen recovery source will restore to.
   *
   * This is the lower bound of the RPO gap. The guard refuses to settle the
   * `restore` step without it, so a blank instance can never be presented as a
   * completed recovery, and it refuses to move the watermark backward, so a retry
   * can shrink the gap but never quietly widen it.
   */
  async setRecoverySource(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    dataWatermarkAt: Date;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          source_data_watermark_at: timestampParam(input.dataWatermarkAt),
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running')`,
            sql`(${agentFailoverOperations.source_data_watermark_at} IS NULL
              OR ${agentFailoverOperations.source_data_watermark_at} < ${timestampParam(input.dataWatermarkAt)})`,
          ),
        )
        .returning();
      if (operation) return operation;
      const current = await this.loadOperationForRefusal(tx, input.operationId);
      if (current?.source_data_watermark_at) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RECOVERY_SOURCE_NOT_FORWARD",
          `Operation ${input.operationId} already restores from ${current.source_data_watermark_at.toISOString()}, which is not older than ${input.dataWatermarkAt.toISOString()}`,
          { operationId: input.operationId },
        );
      }
      throw new AgentFailoverStaleExecutorError(
        input.operationId,
        input.leaseOwner,
        input.leaseGeneration,
      );
    });
  }

  /**
   * Records the restore authority this failover is riding on.
   *
   * The restore runtime owns the lease, the operation, and the target slot; this
   * records the references once so a restarted orchestrator resumes the same
   * recovery instead of starting a second one. Capacity is never incremented here.
   */
  async recordRestoreAdmission(
    input: RestoreAdmissionReferenceInput,
  ): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const authority = await this.readRestoreAuthority(tx, input.restoreOperationId);
      if (!authority) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_OPERATION_NOT_FOUND",
          `No restore operation ${input.restoreOperationId}`,
          { operationId: input.operationId },
        );
      }
      if (
        authority.lease_id !== input.restoreLeaseId ||
        authority.lease_owner_id !== input.restoreLeaseOwner ||
        authority.lease_generation !== input.restoreLeaseGeneration ||
        authority.backup_id !== input.restoreBackupId ||
        authority.expected_manifest_sha256 !== input.restoreManifestSha256
      ) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_AUTHORITY_MISMATCH",
          `Restore operation ${input.restoreOperationId} is held by ${authority.lease_owner_id}/${authority.lease_generation} for backup ${authority.backup_id}, which does not match the recorded admission`,
          { operationId: input.operationId },
        );
      }
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          restore_operation_id: input.restoreOperationId,
          restore_lease_id: input.restoreLeaseId,
          restore_lease_owner: input.restoreLeaseOwner,
          restore_lease_generation: input.restoreLeaseGeneration,
          restore_backup_id: input.restoreBackupId,
          restore_manifest_sha256: input.restoreManifestSha256,
          ...(input.replacementAttemptId
            ? { replacement_attempt_id: input.replacementAttemptId }
            : {}),
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running')`,
            isNull(agentFailoverOperations.restore_operation_id),
          ),
        )
        .returning();
      if (operation) return operation;
      const current = await this.loadOperationForRefusal(tx, input.operationId);
      if (current?.restore_operation_id) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_ADMISSION_ALREADY_RECORDED",
          `Operation ${input.operationId} already references restore operation ${current.restore_operation_id}`,
          { operationId: input.operationId },
        );
      }
      throw new AgentFailoverStaleExecutorError(
        input.operationId,
        input.leaseOwner,
        input.leaseGeneration,
      );
    });
  }

  /**
   * Rebinds to a fresh restore authority after a stall invalidated the old lease.
   *
   * Only legal before a cutover intent exists, and only once the previous attempt
   * is provably dead — the guard requires the old lease to be released or
   * expired, so a live holder can never be displaced. Without this, a process
   * that stalls past the restore lease lifetime would strand the operation.
   */
  async rebindRestoreAdmission(
    input: RestoreAdmissionReferenceInput,
  ): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const authority = await this.readRestoreAuthority(tx, input.restoreOperationId);
      if (!authority) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_OPERATION_NOT_FOUND",
          `No restore operation ${input.restoreOperationId}`,
          { operationId: input.operationId },
        );
      }
      if (
        authority.lease_id !== input.restoreLeaseId ||
        authority.lease_owner_id !== input.restoreLeaseOwner ||
        authority.lease_generation !== input.restoreLeaseGeneration ||
        authority.backup_id !== input.restoreBackupId ||
        authority.expected_manifest_sha256 !== input.restoreManifestSha256
      ) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_AUTHORITY_MISMATCH",
          `Restore operation ${input.restoreOperationId} does not match the recorded admission`,
          { operationId: input.operationId },
        );
      }
      const [currentLease] = await tx
        .select({ lease_id: agentFailoverOperations.restore_lease_id })
        .from(agentFailoverOperations)
        .where(eq(agentFailoverOperations.id, input.operationId));
      if (currentLease?.lease_id === input.restoreLeaseId) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_REBIND_NOOP",
          `Operation ${input.operationId} already references restore lease ${input.restoreLeaseId}; a rebind must name a different authority`,
          { operationId: input.operationId },
        );
      }
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          restore_operation_id: input.restoreOperationId,
          restore_lease_id: input.restoreLeaseId,
          restore_lease_owner: input.restoreLeaseOwner,
          restore_lease_generation: input.restoreLeaseGeneration,
          restore_backup_id: input.restoreBackupId,
          restore_manifest_sha256: input.restoreManifestSha256,
          replacement_attempt_id: input.replacementAttemptId ?? null,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running', 'awaiting_capacity',
              'restore_release_required')`,
            isNull(agentFailoverOperations.target_publication_id),
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }
      return operation;
    });
  }

  /**
   * Fails an operation that was parked waiting for its restore lease to be
   * released.
   *
   * The guard refuses the terminal transition while the lease is still held, so
   * this can only succeed once the restore runtime has actually released it.
   */
  async failAfterRestoreRelease(input: {
    operationId: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const [failed] = await tx
        .update(agentFailoverOperations)
        .set({
          status: "failed",
          completed_at: sql`clock_timestamp()`,
          last_error_code: input.errorCode,
          last_error_message: input.errorMessage,
          wait_reason: null,
          wait_deadline_at: null,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.status, "restore_release_required"),
          ),
        )
        .returning();
      if (!failed) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_NOT_AWAITING_RESTORE_RELEASE",
          `Failover operation ${input.operationId} is not waiting on a restore release`,
          { operationId: input.operationId },
        );
      }
      return failed;
    });
  }

  /**
   * Attaches the replacement attempt a reserved target created.
   *
   * The reserve that counts a slot and the intent that records the attempt are one
   * transaction in the restore path, so an attempt may exist before this failover
   * learns its id. Attaching it is a one-way step under a live lease, verified
   * against the attempt's own authority, and it is what unlocks the terminal
   * transition: the guard refuses to fail while a reserved attempt has not proven
   * its cleanup.
   */
  async attachReplacementAttempt(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    replacementAttemptId: string;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          replacement_attempt_id: input.replacementAttemptId,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            isNull(agentFailoverOperations.replacement_attempt_id),
            sql`${agentFailoverOperations.restore_operation_id} IS NOT NULL`,
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_ATTEMPT_ATTACH_REFUSED",
          `Operation ${input.operationId} cannot attach replacement attempt ${input.replacementAttemptId}`,
          { operationId: input.operationId },
        );
      }
      return operation;
    });
  }

  /**
   * Persists the cutover identity bundle before the first publish attempt.
   *
   * Written once and never regenerated, so an unknown cutover outcome is resolved
   * by replaying the publication with these exact identities rather than
   * inventing new ones. The guard refuses a `cutover` success whose publication
   * does not match this bundle.
   */
  async installCutoverIdentity(input: CutoverIdentityInput): Promise<AgentFailoverOperation> {
    if (!/^[0-9a-f]{64}$/.test(input.targetContainerId)) {
      throw new AgentFailoverConflictError(
        "AGENT_FAILOVER_INPUT_INVALID",
        "targetContainerId must be a 64-character lowercase hex container id",
      );
    }
    return writeTransaction(async (tx) => {
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          target_publication_id: input.targetPublicationId,
          target_activation_generation: input.targetActivationGeneration,
          target_lifecycle_revision: input.targetLifecycleRevision,
          target_container_id: input.targetContainerId,
          target_receipt_sha256: input.targetReceiptSha256,
          target_node_record_id: input.targetNodeRecordId,
          target_node_incarnation: input.targetNodeIncarnation,
          target_node_history_id: input.targetNodeHistoryId,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running')`,
            isNull(agentFailoverOperations.target_publication_id),
            ne(
              agentFailoverOperations.source_activation_generation,
              input.targetActivationGeneration,
            ),
            sql`${agentFailoverOperations.restore_operation_id} IS NOT NULL`,
          ),
        )
        .returning();
      if (operation) return operation;
      const current = await this.loadOperationForRefusal(tx, input.operationId);
      if (current?.target_publication_id) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_CUTOVER_IDENTITY_ALREADY_SET",
          `Operation ${input.operationId} already installed cutover identity ${current.target_publication_id}`,
          { operationId: input.operationId },
        );
      }
      if (current && !current.restore_operation_id) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_RESTORE_ADMISSION_MISSING",
          `Operation ${input.operationId} cannot install a cutover identity before a restore authority is recorded`,
          { operationId: input.operationId },
        );
      }
      if (current?.source_activation_generation === input.targetActivationGeneration) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_TARGET_AUTHORITY_NOT_NEWER",
          `Operation ${input.operationId} cannot install the source activation generation it is replacing`,
          { operationId: input.operationId },
        );
      }
      throw new AgentFailoverStaleExecutorError(
        input.operationId,
        input.leaseOwner,
        input.leaseGeneration,
      );
    });
  }

  /**
   * Parks the operation until a slot exists.
   *
   * Waiting carries a reason and a deadline, so an exhausted wait escalates
   * instead of looping forever. The decision to wait comes from the restore
   * authority's admission result; this module never evaluates capacity itself.
   */
  async markAwaitingCapacity(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    reason: AgentFailoverWaitReason;
    waitMs?: number;
    retryAfterMs?: number;
  }): Promise<AgentFailoverOperation> {
    const waitMs = boundedPositiveInteger(
      input.waitMs,
      DEFAULT_CAPACITY_WAIT_MS,
      MIN_WAIT_MS,
      MAX_WAIT_MS,
      "waitMs",
    );
    const retryAfterMs = boundedPositiveInteger(
      input.retryAfterMs,
      DEFAULT_LEASE_MS,
      MIN_LEASE_MS,
      MAX_LEASE_MS,
      "retryAfterMs",
    );
    return writeTransaction(async (tx) => {
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          status: "awaiting_capacity",
          wait_reason: input.reason,
          wait_deadline_at: sql`clock_timestamp() + (${waitMs} * INTERVAL '1 millisecond')`,
          next_attempt_at: sql`clock_timestamp() + (${retryAfterMs} * INTERVAL '1 millisecond')`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            sql`${agentFailoverOperations.status} IN ('pending', 'running')`,
            isNull(agentFailoverOperations.target_publication_id),
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }
      return operation;
    });
  }

  /** Leaves the capacity wait once the restore authority has admitted a target. */
  async resumeFromWait(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          status: "running",
          wait_reason: null,
          wait_deadline_at: null,
          next_attempt_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.lease_owner, input.leaseOwner),
            eq(agentFailoverOperations.lease_generation, input.leaseGeneration),
            sql`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
            eq(agentFailoverOperations.status, "awaiting_capacity"),
            // An expired wait escalates; it is not resumed.
            sql`${agentFailoverOperations.wait_deadline_at} > clock_timestamp()`,
          ),
        )
        .returning();
      if (!operation) {
        throw new AgentFailoverStaleExecutorError(
          input.operationId,
          input.leaseOwner,
          input.leaseGeneration,
        );
      }
      return operation;
    });
  }

  /**
   * Escalates capacity waits whose deadline has passed.
   *
   * A wait is bounded by construction: the claim paths refuse an operation once
   * `wait_deadline_at` has passed, so without this sweep an exhausted wait would
   * sit unreachable. It fails the operation loudly instead, naming the reason.
   */
  async escalateExpiredWaits(input: { limit?: number } = {}): Promise<AgentFailoverOperation[]> {
    const limit = boundedPositiveInteger(input.limit, 50, 1, 500, "limit");
    return writeTransaction(async (tx) => {
      const expired = await tx
        .select({ id: agentFailoverOperations.id })
        .from(agentFailoverOperations)
        .where(
          and(
            eq(agentFailoverOperations.status, "awaiting_capacity"),
            sql`${agentFailoverOperations.wait_deadline_at} IS NOT NULL`,
            sql`${agentFailoverOperations.wait_deadline_at} <= clock_timestamp()`,
            isNull(agentFailoverOperations.target_publication_id),
          ),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
      if (expired.length === 0) return [];
      return tx
        .update(agentFailoverOperations)
        .set({
          // With a restore authority recorded, the slot is still held: park
          // where a runtime that may call restore can release it, and let the
          // guard refuse a terminal failure until the lease is gone.
          status: sql`CASE WHEN ${agentFailoverOperations.restore_lease_id} IS NULL
            THEN 'failed' ELSE 'restore_release_required' END`,
          completed_at: sql`CASE WHEN ${agentFailoverOperations.restore_lease_id} IS NULL
            THEN clock_timestamp() ELSE NULL END`,
          wait_reason: null,
          wait_deadline_at: null,
          last_error_code: "AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED",
          last_error_message: sql`'capacity wait expired: ' || COALESCE(${agentFailoverOperations.wait_reason}, 'unknown')`,
          lease_owner: null,
          lease_generation: null,
          lease_expires_at: null,
          lease_heartbeat_at: null,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          inArray(
            agentFailoverOperations.id,
            expired.map((row) => row.id),
          ),
        )
        .returning();
    });
  }

  /**
   * Resumes an operation parked for an operator.
   *
   * The caller is the authorization boundary: this records who resumed it and
   * why, resets the post-cutover attempt budget so the operation can retry, and
   * returns it to `running` for the normal claim path. It never rolls back a
   * committed cutover, because there is nothing to roll back to.
   */
  async resumeFromIntervention(input: {
    operationId: string;
    operator: string;
    reason: string;
  }): Promise<AgentFailoverOperation> {
    if (input.operator.trim() === "" || input.reason.trim() === "") {
      throw new AgentFailoverConflictError(
        "AGENT_FAILOVER_RESUME_AUDIT_REQUIRED",
        "Resuming an intervened failover requires an operator identity and a reason",
        { operationId: input.operationId },
      );
    }
    return writeTransaction(async (tx) => {
      await tx.insert(agentFailoverOperatorActions).values({
        operation_id: input.operationId,
        action: "resume",
        operator: input.operator,
        reason: input.reason,
      });
      const [resumed] = await tx
        .update(agentFailoverOperations)
        .set({
          status: "running",
          post_cutover_attempts: 0,
          next_attempt_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(agentFailoverOperations.id, input.operationId),
            eq(agentFailoverOperations.status, "intervention_required"),
          ),
        )
        .returning();
      if (!resumed) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_NOT_PARKED",
          `Failover operation ${input.operationId} is not awaiting an operator`,
          { operationId: input.operationId },
        );
      }
      return resumed;
    });
  }

  /**
   * Parks a committed cutover that cannot finish automatically.
   *
   * Only reachable after the cutover is committed: the move already happened, so
   * there is no rollback, and repeated automatic attempts stop here so a failing
   * controller cannot loop forever behind an operator's back.
   */
  async parkForIntervention(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      await this.assertLiveLease(tx, input);
      const [operation] = await tx
        .update(agentFailoverOperations)
        .set({
          status: "intervention_required",
          last_error_code: input.errorCode,
          last_error_message: input.errorMessage,
          lease_owner: null,
          lease_generation: null,
          lease_expires_at: null,
          lease_heartbeat_at: null,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(agentFailoverOperations.id, input.operationId))
        .returning();
      if (!operation) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_OPERATION_NOT_FOUND",
          `No failover operation ${input.operationId}`,
          { operationId: input.operationId },
        );
      }
      return operation;
    });
  }

  /**
   * Terminates an operation.
   *
   * Capacity is not touched: the restore authority owns the slot and releases it
   * on its own failed path. A committed cutover refuses the failure states
   * entirely, in this method and again in the guard.
   */
  async finishOperation(input: {
    operationId: string;
    leaseOwner: string;
    leaseGeneration: string;
    status: "completed" | "failed" | "cancelled" | "blocked_no_backup";
    errorCode?: string;
    errorMessage?: string;
    postCutoverAttempts?: number;
  }): Promise<AgentFailoverOperation> {
    return writeTransaction(async (tx) => {
      const operation = await this.assertLiveLease(tx, input);
      const resume = await this.readCutoverCommittedWithin(tx, input.operationId);
      if (resume && PRE_CUTOVER_TERMINAL_STATUSES.includes(input.status)) {
        const attempts = input.postCutoverAttempts ?? operation.post_cutover_attempts + 1;
        if (attempts >= DEFAULT_POST_CUTOVER_ATTEMPT_LIMIT) {
          return this.parkWithin(tx, input.operationId, {
            errorCode: input.errorCode ?? "AGENT_FAILOVER_POST_CUTOVER_EXHAUSTED",
            errorMessage:
              input.errorMessage ??
              `Cutover is committed and ${attempts} attempts could not finish the source fencing`,
          });
        }
        const [retried] = await tx
          .update(agentFailoverOperations)
          .set({
            post_cutover_attempts: attempts,
            last_error_code: input.errorCode ?? "AGENT_FAILOVER_POST_CUTOVER_RETRY",
            last_error_message: input.errorMessage ?? null,
            next_attempt_at: sql`clock_timestamp() + (${DEFAULT_LEASE_MS} * INTERVAL '1 millisecond')`,
            lease_owner: null,
            lease_generation: null,
            lease_expires_at: null,
            lease_heartbeat_at: null,
            updated_at: sql`clock_timestamp()`,
          })
          .where(eq(agentFailoverOperations.id, input.operationId))
          .returning();
        if (!retried) {
          throw new AgentFailoverConflictError(
            "AGENT_FAILOVER_OPERATION_NOT_FOUND",
            `No failover operation ${input.operationId}`,
            { operationId: input.operationId },
          );
        }
        return retried;
      }

      const [finished] = await tx
        .update(agentFailoverOperations)
        .set({
          status: input.status,
          completed_at: sql`clock_timestamp()`,
          lease_owner: null,
          lease_generation: null,
          lease_expires_at: null,
          lease_heartbeat_at: null,
          // A terminal state carries no wait: leaving these set fails the shape
          // check, which real PostgreSQL caught on a terminal transition taken
          // straight from `awaiting_capacity`.
          wait_reason: null,
          wait_deadline_at: null,
          last_error_code: input.errorCode ?? null,
          last_error_message: input.errorMessage ?? null,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(agentFailoverOperations.id, input.operationId))
        .returning();
      if (!finished) {
        throw new AgentFailoverConflictError(
          "AGENT_FAILOVER_OPERATION_NOT_FOUND",
          `No failover operation ${input.operationId}`,
          { operationId: input.operationId },
        );
      }
      return finished;
    });
  }

  /**
   * Fails closed unless the caller holds the operation's live lease.
   *
   * Liveness is evaluated by the database clock and the row lock is held to the
   * end of the transaction, so the fence cannot change under the write that
   * follows.
   */
  private async assertLiveLease(
    tx: DbTransaction,
    params: { operationId: string; leaseOwner: string; leaseGeneration: string },
  ): Promise<AgentFailoverOperation> {
    const [row] = await tx
      .select({
        operation: agentFailoverOperations,
        lease_live: sql<boolean>`${agentFailoverOperations.lease_expires_at} > clock_timestamp()`,
      })
      .from(agentFailoverOperations)
      .where(eq(agentFailoverOperations.id, params.operationId))
      .for("update");
    if (
      !row ||
      row.operation.lease_owner !== params.leaseOwner ||
      row.operation.lease_generation !== params.leaseGeneration ||
      !row.lease_live
    ) {
      throw new AgentFailoverStaleExecutorError(
        params.operationId,
        params.leaseOwner,
        params.leaseGeneration,
      );
    }
    return row.operation;
  }

  private async claimReceipt(
    tx: DbTransaction,
    operation: AgentFailoverOperation,
    leaseOwner: string,
  ): Promise<FailoverClaimReceipt> {
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (!operation.lease_generation || !operation.lease_expires_at) {
      throw new AgentFailoverConflictError(
        "AGENT_FAILOVER_CLAIM_FENCE_MISSING",
        `Claimed failover operation ${operation.id} has no lease fence`,
        { operationId: operation.id },
      );
    }
    return {
      operation,
      leaseOwner,
      leaseGeneration: operation.lease_generation,
      expiresAt: operation.lease_expires_at,
      databaseNow,
    };
  }

  private async readCutoverCommittedWithin(
    tx: DbTransaction,
    operationId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ committed: sql<boolean>`true` })
      .from(agentFailoverStepAttempts)
      .where(
        and(
          eq(agentFailoverStepAttempts.operation_id, operationId),
          eq(agentFailoverStepAttempts.step, "cutover"),
          sql`(${agentFailoverStepAttempts.state} = 'succeeded'
            OR (${agentFailoverStepAttempts.state} = 'reconciled'
              AND ${agentFailoverStepAttempts.reconcile_action} = 'continued'))`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async parkWithin(
    tx: DbTransaction,
    operationId: string,
    input: { errorCode: string; errorMessage: string },
  ): Promise<AgentFailoverOperation> {
    const [parked] = await tx
      .update(agentFailoverOperations)
      .set({
        status: "intervention_required",
        last_error_code: input.errorCode,
        last_error_message: input.errorMessage,
        lease_owner: null,
        lease_generation: null,
        lease_expires_at: null,
        lease_heartbeat_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(eq(agentFailoverOperations.id, operationId))
      .returning();
    if (!parked) {
      throw new AgentFailoverConflictError(
        "AGENT_FAILOVER_OPERATION_NOT_FOUND",
        `No failover operation ${operationId}`,
        { operationId },
      );
    }
    return parked;
  }

  private async readCorroborationCounts(
    tx: DbTransaction,
    failureEventId: string,
  ): Promise<{ distinctKinds: number; distinctClasses: number; observations: number }> {
    const [counts] = await tx
      .select({
        distinct_kinds: sql<number>`COUNT(DISTINCT ${agentNodeFailureSignals.kind})::int`,
        distinct_classes: sql<number>`COUNT(DISTINCT ${agentNodeFailureSignals.source_class})::int`,
        observations: sql<number>`COALESCE(SUM(${agentNodeFailureSignals.observation_count}), 0)::int`,
      })
      .from(agentNodeFailureSignals)
      .where(eq(agentNodeFailureSignals.failure_event_id, failureEventId));
    return {
      distinctKinds: counts?.distinct_kinds ?? 0,
      distinctClasses: counts?.distinct_classes ?? 0,
      observations: counts?.observations ?? 0,
    };
  }

  private async readRestoreAuthority(
    tx: DbTransaction,
    restoreOperationId: string,
  ): Promise<{
    lease_id: string;
    lease_owner_id: string;
    lease_generation: string;
    backup_id: string;
    expected_manifest_sha256: string;
  } | null> {
    const [row] = await tx
      .select({
        lease_id: agentBackupRestoreOperations.lease_id,
        lease_owner_id: agentBackupRestoreOperations.lease_owner_id,
        lease_generation: agentBackupRestoreOperations.lease_generation,
        backup_id: agentBackupRestoreOperations.backup_id,
        expected_manifest_sha256: agentBackupRestoreOperations.expected_manifest_sha256,
      })
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, restoreOperationId))
      .limit(1);
    return row ?? null;
  }

  private async loadOperationForRefusal(
    tx: DbTransaction,
    operationId: string,
  ): Promise<AgentFailoverOperation | null> {
    const [current] = await tx
      .select()
      .from(agentFailoverOperations)
      .where(eq(agentFailoverOperations.id, operationId));
    return current ?? null;
  }
}

export const agentFailoverRepository = new AgentFailoverRepository();

/** Stable, unique executor identity for a failover worker process. */
export function newFailoverLeaseOwner(workerLabel: string): string {
  return `${workerLabel}:${randomUUID()}`;
}
