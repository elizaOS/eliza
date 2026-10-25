/**
 * Runs one bounded caller cycle for durable V3 periodic-backup admission.
 *
 * The service composes only primary-database enrollment, claim, reservation,
 * and deferral authorities. It never discovers or creates capacity, invokes a
 * provider, captures a sandbox, or autoscales. A leased batch is always drained
 * before cancellation, deadline, or compensated failures are propagated.
 */

import { ElizaError } from "@elizaos/core";
import {
  type AgentBackupAdmissionClaim,
  claimAgentBackupAdmissionWorkTurn,
  deferAgentBackupAdmissionClaim,
} from "../../db/repositories/agent-backup-admission-claim";
import { enrollDueAgentBackupScheduleAdmissionCohort } from "../../db/repositories/agent-backup-admission-enrollment";
import { reserveAndSettleAgentBackupAdmissionClaim } from "../../db/repositories/agent-backup-admission-reservation";
import { AGENT_BACKUP_ADMISSION_SHARD_COUNT } from "../../db/schemas/agent-backup-admission";

export const ENROLLMENT_BATCH_SIZE = 100;
export const MAX_ENROLLMENT_TURNS = AGENT_BACKUP_ADMISSION_SHARD_COUNT;
export const BACKUP_ADMISSION_RPO_MS = 15 * 60_000;
export const BACKUP_ADMISSION_LEASE_MS = 5 * 60_000;
export const CLAIM_BATCH_SIZE = 25;
export const MAX_CLAIM_TURNS_PER_INVOCATION = 4_096;
// Fourteen minute-spaced invocations at 800 items cover a 10,640-item cohort
// inside the 15-minute RPO while retaining one minute of boundary tolerance.
export const MAX_CLAIMS_PER_INVOCATION = 800;
export const BACKUP_ADMISSION_DEFER_MS = 30_000;
// The scheduler-anchored cycle leaves 15 seconds of the minute trigger for
// transport and shutdown, including when delivery itself was delayed.
export const BACKUP_ADMISSION_CYCLE_DEADLINE_MS = 45_000;
export const BACKUP_ADMISSION_CONTENTION_BACKOFF_MS = 5_000;

export const BACKUP_ADMISSION_RESERVATION_RETRY_REASON = "BACKUP_ADMISSION_RESERVATION_RETRY";
export const BACKUP_ADMISSION_RESERVATION_RETRY_EXHAUSTED_ALERT =
  "BACKUP_ADMISSION_RESERVATION_RETRY_EXHAUSTED";
export const BACKUP_ADMISSION_RESERVATION_RECONCILE_ALERT =
  "BACKUP_ADMISSION_RESERVATION_RECONCILE_REQUIRED";
export const BACKUP_ADMISSION_CLAIM_CONTENDED_ALERT = "BACKUP_ADMISSION_CLAIM_CONTENDED";
export const BACKUP_ADMISSION_CLAIM_TURN_BUDGET_ALERT =
  "BACKUP_ADMISSION_CLAIM_TURN_BUDGET_REACHED";
export const BACKUP_ADMISSION_CLAIM_ITEM_BUDGET_ALERT =
  "BACKUP_ADMISSION_CLAIM_ITEM_BUDGET_REACHED";
export const BACKUP_ADMISSION_ENROLLMENT_CONTENDED_ALERT = "BACKUP_ADMISSION_ENROLLMENT_CONTENDED";
export const BACKUP_ADMISSION_ENROLLMENT_TURN_BUDGET_ALERT =
  "BACKUP_ADMISSION_ENROLLMENT_TURN_BUDGET_REACHED";

export type AgentBackupAdmissionRuntimeStopReason =
  | "idle"
  | "enrollment_contended"
  | "enrollment_turn_budget"
  | "contended"
  | "claim_turn_budget"
  | "claim_item_budget"
  | "failed";

/** Stable, log-safe result of one admission invocation. */
export interface AgentBackupAdmissionRuntimeSummary {
  readonly enrollmentTurns: number;
  readonly enrollmentUnavailable: number;
  readonly enrollmentCompletedShards: number;
  readonly enrolled: number;
  readonly queued: number;
  readonly cohortsComplete: number;
  readonly claimTurns: number;
  readonly claimClaimedTurns: number;
  readonly claimProgressedTurns: number;
  readonly claimContendedTurns: number;
  readonly claimIdleTurns: number;
  readonly claimed: number;
  readonly reserved: number;
  readonly replayed: number;
  readonly deferred: number;
  readonly retryExhausted: number;
  readonly indeterminate: number;
  readonly stopReason: AgentBackupAdmissionRuntimeStopReason;
  /** False only when claim is idle after a complete distinct 64-shard enrollment pass. */
  readonly continuationRequired: boolean;
  /** Fixed retry hint; `null` means no continuation is required. */
  readonly retryAfterMs: number | null;
  /** Sorted, unique static codes safe for structured logs and aggregation. */
  readonly alerts: readonly string[];
}

interface AgentBackupAdmissionRuntimeAccumulator {
  enrollmentTurns: number;
  enrollmentUnavailable: number;
  enrollmentCompletedShards: number;
  enrolled: number;
  queued: number;
  cohortsComplete: number;
  claimTurns: number;
  claimClaimedTurns: number;
  claimProgressedTurns: number;
  claimContendedTurns: number;
  claimIdleTurns: number;
  claimed: number;
  reserved: number;
  replayed: number;
  deferred: number;
  retryExhausted: number;
  indeterminate: number;
}

export interface AgentBackupAdmissionRuntimeDependencies {
  enroll: typeof enrollDueAgentBackupScheduleAdmissionCohort;
  claim: typeof claimAgentBackupAdmissionWorkTurn;
  reserve: typeof reserveAndSettleAgentBackupAdmissionClaim;
  defer: typeof deferAgentBackupAdmissionClaim;
  now: () => number;
}

export interface AgentBackupAdmissionRuntimeParams {
  ownerId: string;
  /** Exact Cloudflare scheduler epoch milliseconds anchoring this invocation. */
  scheduledTime: number;
  signal?: AbortSignal;
}

const PRODUCTION_DEPENDENCIES: AgentBackupAdmissionRuntimeDependencies = {
  enroll: enrollDueAgentBackupScheduleAdmissionCohort,
  claim: claimAgentBackupAdmissionWorkTurn,
  reserve: reserveAndSettleAgentBackupAdmissionClaim,
  defer: deferAgentBackupAdmissionClaim,
  now: Date.now,
};

/** Failure raised after every item in an already leased batch was accounted. */
export class AgentBackupAdmissionBatchError extends ElizaError {
  override readonly name = "AgentBackupAdmissionBatchError";
  readonly summary: AgentBackupAdmissionRuntimeSummary;

  constructor(summary: AgentBackupAdmissionRuntimeSummary, failures: readonly Error[]) {
    super("Backup admission leased batch failed after compensation", {
      code: "BACKUP_ADMISSION_LEASED_BATCH_FAILED",
      cause: new AggregateError(failures, "Backup admission leased batch failures"),
      context: {
        stopReason: summary.stopReason,
        claimed: summary.claimed,
        reserved: summary.reserved,
        deferred: summary.deferred,
        retryExhausted: summary.retryExhausted,
        indeterminate: summary.indeterminate,
        alerts: summary.alerts,
      },
      severity: "ephemeral",
    });
    this.summary = summary;
  }
}

/** Cooperative wall-clock deadline reached between durable authority calls. */
export class AgentBackupAdmissionDeadlineError extends ElizaError {
  override readonly name = "AgentBackupAdmissionDeadlineError";

  constructor(deadlineAt: number, observedAt: number) {
    super("Backup admission cycle deadline reached", {
      code: "BACKUP_ADMISSION_CYCLE_DEADLINE_REACHED",
      context: { deadlineAt, observedAt },
      severity: "ephemeral",
    });
  }
}

function emptyAccumulator(): AgentBackupAdmissionRuntimeAccumulator {
  return {
    enrollmentTurns: 0,
    enrollmentUnavailable: 0,
    enrollmentCompletedShards: 0,
    enrolled: 0,
    queued: 0,
    cohortsComplete: 0,
    claimTurns: 0,
    claimClaimedTurns: 0,
    claimProgressedTurns: 0,
    claimContendedTurns: 0,
    claimIdleTurns: 0,
    claimed: 0,
    reserved: 0,
    replayed: 0,
    deferred: 0,
    retryExhausted: 0,
    indeterminate: 0,
  };
}

function requireEpochMilliseconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ElizaError(`${field} must be a non-negative safe epoch millisecond`, {
      code: "BACKUP_ADMISSION_RUNTIME_TIME_INVALID",
      context: { field, value },
      severity: "fatal",
    });
  }
  return value;
}

function finalizeSummary(params: {
  accumulator: AgentBackupAdmissionRuntimeAccumulator;
  stopReason: AgentBackupAdmissionRuntimeStopReason;
  continuationRequired: boolean;
  retryAfterMs: number | null;
  alerts: ReadonlySet<string>;
}): AgentBackupAdmissionRuntimeSummary {
  return Object.freeze({
    ...params.accumulator,
    stopReason: params.stopReason,
    continuationRequired: params.continuationRequired,
    retryAfterMs: params.retryAfterMs,
    alerts: Object.freeze([...params.alerts].sort()),
  });
}

type RuntimeInterruption = { readonly error: unknown } | null;

function currentInterruption(params: {
  signal?: AbortSignal;
  deadlineAt: number;
  now: () => number;
}): RuntimeInterruption {
  if (params.signal?.aborted) return { error: params.signal.reason };
  const observedAt = requireEpochMilliseconds(params.now(), "dependencies.now()");
  if (observedAt >= params.deadlineAt) {
    return { error: new AgentBackupAdmissionDeadlineError(params.deadlineAt, observedAt) };
  }
  return null;
}

function throwIfInterrupted(params: {
  signal?: AbortSignal;
  deadlineAt: number;
  now: () => number;
}): void {
  const interruption = currentInterruption(params);
  if (interruption !== null) throw interruption.error;
}

function contextualFailure(params: {
  claim: AgentBackupAdmissionClaim;
  stage: "reservation" | "defer" | "claim_contract";
  code: string;
  message: string;
  cause?: unknown;
}): ElizaError {
  return new ElizaError(params.message, {
    code: params.code,
    cause: params.cause,
    context: { workId: params.claim.workId, stage: params.stage },
    severity: "ephemeral",
  });
}

/**
 * Run one fixed-budget admission cycle.
 *
 * `progressed` is durable cursor progress and always continues. Only `idle`
 * proves completion. Contention returns a fixed bounded retry hint, while the
 * 4,096-turn and 800-item ceilings return explicit continuation state.
 */
export async function runAgentBackupAdmissionCycle(
  params: AgentBackupAdmissionRuntimeParams,
  dependencies: AgentBackupAdmissionRuntimeDependencies = PRODUCTION_DEPENDENCIES,
): Promise<AgentBackupAdmissionRuntimeSummary> {
  const accumulator = emptyAccumulator();
  const alerts = new Set<string>();
  const scheduledTime = requireEpochMilliseconds(params.scheduledTime, "scheduledTime");
  const deadlineAt = requireEpochMilliseconds(
    scheduledTime + BACKUP_ADMISSION_CYCLE_DEADLINE_MS,
    "deadlineAt",
  );
  const interruptionParams = {
    signal: params.signal,
    deadlineAt,
    now: dependencies.now,
  };

  throwIfInterrupted(interruptionParams);
  const completedEnrollmentShards = new Set<number>();
  let enrollmentStopReason: "complete" | "contended" | "turn_budget" = "turn_budget";
  for (let turn = 0; turn < MAX_ENROLLMENT_TURNS; turn += 1) {
    throwIfInterrupted(interruptionParams);
    accumulator.enrollmentTurns += 1;
    const enrollment = await dependencies.enroll({
      ownerId: params.ownerId,
      limit: ENROLLMENT_BATCH_SIZE,
      leaseMs: BACKUP_ADMISSION_LEASE_MS,
      rpoMs: BACKUP_ADMISSION_RPO_MS,
    });

    if (enrollment === null) {
      accumulator.enrollmentUnavailable += 1;
      enrollmentStopReason = "contended";
      throwIfInterrupted(interruptionParams);
      break;
    }
    accumulator.enrolled += enrollment.enrolled;
    accumulator.queued += enrollment.queued;
    if (enrollment.cohortComplete) {
      if (
        !Number.isSafeInteger(enrollment.shardId) ||
        enrollment.shardId < 0 ||
        enrollment.shardId >= AGENT_BACKUP_ADMISSION_SHARD_COUNT
      ) {
        throw new ElizaError("Backup admission enrollment returned an invalid shard", {
          code: "BACKUP_ADMISSION_ENROLLMENT_SHARD_INVALID",
          context: { shardId: enrollment.shardId },
          severity: "fatal",
        });
      }
      accumulator.cohortsComplete += 1;
      completedEnrollmentShards.add(enrollment.shardId);
      accumulator.enrollmentCompletedShards = completedEnrollmentShards.size;
      if (completedEnrollmentShards.size === AGENT_BACKUP_ADMISSION_SHARD_COUNT) {
        enrollmentStopReason = "complete";
      }
    }
    throwIfInterrupted(interruptionParams);
    if (enrollmentStopReason === "complete") break;
  }
  if (enrollmentStopReason === "contended") {
    alerts.add(BACKUP_ADMISSION_ENROLLMENT_CONTENDED_ALERT);
  } else if (enrollmentStopReason === "turn_budget") {
    alerts.add(BACKUP_ADMISSION_ENROLLMENT_TURN_BUDGET_ALERT);
  }

  while (
    accumulator.claimTurns < MAX_CLAIM_TURNS_PER_INVOCATION &&
    accumulator.claimed < MAX_CLAIMS_PER_INVOCATION
  ) {
    throwIfInterrupted(interruptionParams);
    const remaining = MAX_CLAIMS_PER_INVOCATION - accumulator.claimed;
    const limit = Math.min(CLAIM_BATCH_SIZE, remaining);
    accumulator.claimTurns += 1;
    const turn = await dependencies.claim({
      ownerId: params.ownerId,
      limit,
      leaseMs: BACKUP_ADMISSION_LEASE_MS,
    });

    if (turn.outcome === "progressed") {
      accumulator.claimProgressedTurns += 1;
      throwIfInterrupted(interruptionParams);
      continue;
    }
    if (turn.outcome === "idle") {
      accumulator.claimIdleTurns += 1;
      throwIfInterrupted(interruptionParams);
      if (enrollmentStopReason === "contended") {
        return finalizeSummary({
          accumulator,
          stopReason: "enrollment_contended",
          continuationRequired: true,
          retryAfterMs: BACKUP_ADMISSION_CONTENTION_BACKOFF_MS,
          alerts,
        });
      }
      if (enrollmentStopReason === "turn_budget") {
        return finalizeSummary({
          accumulator,
          stopReason: "enrollment_turn_budget",
          continuationRequired: true,
          retryAfterMs: 0,
          alerts,
        });
      }
      return finalizeSummary({
        accumulator,
        stopReason: "idle",
        continuationRequired: false,
        retryAfterMs: null,
        alerts,
      });
    }
    if (turn.outcome === "contended") {
      accumulator.claimContendedTurns += 1;
      alerts.add(BACKUP_ADMISSION_CLAIM_CONTENDED_ALERT);
      throwIfInterrupted(interruptionParams);
      return finalizeSummary({
        accumulator,
        stopReason: "contended",
        continuationRequired: true,
        retryAfterMs: BACKUP_ADMISSION_CONTENTION_BACKOFF_MS,
        alerts,
      });
    }

    accumulator.claimClaimedTurns += 1;
    const firstClaim = turn.claims[0];
    if (firstClaim === undefined) {
      throw new ElizaError("Backup admission claimed outcome contained no leased work", {
        code: "BACKUP_ADMISSION_CLAIM_OUTCOME_INVALID",
        severity: "fatal",
      });
    }
    accumulator.claimed += turn.claims.length;
    const failures: Error[] = [];
    if (turn.claims.length > limit) {
      failures.push(
        contextualFailure({
          claim: firstClaim,
          stage: "claim_contract",
          code: "BACKUP_ADMISSION_CLAIM_BUDGET_EXCEEDED",
          message: "Backup admission claimant exceeded its requested processing budget",
        }),
      );
    }

    // Once claimed, every item must reach reservation or exact defer accounting
    // before any interruption or failure leaves this invocation.
    for (const claim of turn.claims) {
      try {
        const reservation = await dependencies.reserve({ claim });
        accumulator.reserved += 1;
        if (reservation.replayed) accumulator.replayed += 1;
        continue;
      } catch (error) {
        // error-policy:J2 aggregate after exact defer compensation and full batch drain.
        alerts.add(BACKUP_ADMISSION_RESERVATION_RETRY_REASON);
        failures.push(
          contextualFailure({
            claim,
            stage: "reservation",
            code: "BACKUP_ADMISSION_RESERVATION_FAILED",
            message: "Backup admission reservation failed",
            cause: error,
          }),
        );
      }

      try {
        const result = await dependencies.defer({
          fence: claim,
          retryDelayMs: BACKUP_ADMISSION_DEFER_MS,
          reason: BACKUP_ADMISSION_RESERVATION_RETRY_REASON,
        });
        if (result === "deferred") {
          accumulator.deferred += 1;
        } else if (result === "retry_exhausted") {
          accumulator.retryExhausted += 1;
          alerts.add(BACKUP_ADMISSION_RESERVATION_RETRY_EXHAUSTED_ALERT);
        } else {
          accumulator.indeterminate += 1;
          alerts.add(BACKUP_ADMISSION_RESERVATION_RECONCILE_ALERT);
          failures.push(
            contextualFailure({
              claim,
              stage: "defer",
              code: "BACKUP_ADMISSION_DEFER_INDETERMINATE",
              message: "Backup admission defer outcome requires reconciliation",
            }),
          );
        }
      } catch (error) {
        // error-policy:J2 aggregate after the remaining leased batch is drained.
        accumulator.indeterminate += 1;
        alerts.add(BACKUP_ADMISSION_RESERVATION_RECONCILE_ALERT);
        failures.push(
          contextualFailure({
            claim,
            stage: "defer",
            code: "BACKUP_ADMISSION_DEFER_FAILED",
            message: "Backup admission defer failed",
            cause: error,
          }),
        );
      }
    }

    const interruption = currentInterruption(interruptionParams);
    if (failures.length > 0) {
      if (interruption !== null) {
        failures.push(
          interruption.error instanceof Error
            ? interruption.error
            : new ElizaError("Backup admission cycle aborted while draining a leased batch", {
                code: "BACKUP_ADMISSION_CYCLE_ABORTED",
                cause: interruption.error,
                severity: "ephemeral",
              }),
        );
      }
      const summary = finalizeSummary({
        accumulator,
        stopReason: "failed",
        continuationRequired: true,
        retryAfterMs: BACKUP_ADMISSION_DEFER_MS,
        alerts,
      });
      throw new AgentBackupAdmissionBatchError(summary, failures);
    }
    if (interruption !== null) throw interruption.error;
  }

  throwIfInterrupted(interruptionParams);
  if (accumulator.claimed >= MAX_CLAIMS_PER_INVOCATION) {
    alerts.add(BACKUP_ADMISSION_CLAIM_ITEM_BUDGET_ALERT);
    return finalizeSummary({
      accumulator,
      stopReason: "claim_item_budget",
      continuationRequired: true,
      retryAfterMs: 0,
      alerts,
    });
  }

  alerts.add(BACKUP_ADMISSION_CLAIM_TURN_BUDGET_ALERT);
  return finalizeSummary({
    accumulator,
    stopReason: "claim_turn_budget",
    continuationRequired: true,
    retryAfterMs: 0,
    alerts,
  });
}
