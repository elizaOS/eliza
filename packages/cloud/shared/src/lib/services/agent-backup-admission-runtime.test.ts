/**
 * Deterministically exercises the bounded periodic-backup admission caller.
 *
 * Repository authorities are replaced with typed in-memory collaborators so
 * the suite can exhaustively prove caller control flow, leased-batch draining,
 * deadline semantics, compensation failures, and multi-tick fairness.
 */

import { describe, expect, test } from "bun:test";
import {
  AgentBackupAdmissionBatchError,
  AgentBackupAdmissionDeadlineError,
  type AgentBackupAdmissionRuntimeDependencies,
  BACKUP_ADMISSION_CLAIM_CONTENDED_ALERT,
  BACKUP_ADMISSION_CLAIM_ITEM_BUDGET_ALERT,
  BACKUP_ADMISSION_CLAIM_TURN_BUDGET_ALERT,
  BACKUP_ADMISSION_CONTENTION_BACKOFF_MS,
  BACKUP_ADMISSION_CYCLE_DEADLINE_MS,
  BACKUP_ADMISSION_DEFER_MS,
  BACKUP_ADMISSION_ENROLLMENT_CONTENDED_ALERT,
  BACKUP_ADMISSION_ENROLLMENT_TURN_BUDGET_ALERT,
  BACKUP_ADMISSION_LEASE_MS,
  BACKUP_ADMISSION_RESERVATION_RECONCILE_ALERT,
  BACKUP_ADMISSION_RESERVATION_RETRY_EXHAUSTED_ALERT,
  BACKUP_ADMISSION_RESERVATION_RETRY_REASON,
  BACKUP_ADMISSION_RPO_MS,
  CLAIM_BATCH_SIZE,
  ENROLLMENT_BATCH_SIZE,
  MAX_CLAIM_TURNS_PER_INVOCATION,
  MAX_CLAIMS_PER_INVOCATION,
  MAX_ENROLLMENT_TURNS,
  runAgentBackupAdmissionCycle,
} from "./agent-backup-admission-runtime";

const SCHEDULED_TIME = Date.parse("2026-08-29T12:00:00.000Z");
const OWNER_ID = `agent-backup-admission:${SCHEDULED_TIME}`;

type ClaimTurn = Awaited<ReturnType<AgentBackupAdmissionRuntimeDependencies["claim"]>>;
type ClaimedTurn = Extract<ClaimTurn, { outcome: "claimed" }>;
type AdmissionClaim = ClaimedTurn["claims"][number];

function uuid(seed: number): string {
  return `10000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function admissionClaim(
  seed: number,
  options: { ownerId?: string; priority?: number; dueOffsetMs?: number } = {},
): AdmissionClaim {
  const priority = options.priority ?? seed % 4;
  const dueAt = new Date(SCHEDULED_TIME + (options.dueOffsetMs ?? 0));
  return {
    workId: uuid(seed),
    organizationId: uuid(100_000 + (seed % 97)),
    sandboxId: uuid(200_000 + seed),
    nodeHistoryId: uuid(300_000 + (seed % 64)),
    sourceActivationGeneration: uuid(400_000 + seed),
    sourceLifecycleRevision: `${seed + 1}`,
    sourceProviderHandle: `provider-server-${seed % 64}`,
    sourceContainerId: seed.toString(16).padStart(64, "0"),
    sourceImageDigest: `sha256:${(500_000 + seed).toString(16).padStart(64, "0")}`,
    sourceRpoMs: BACKUP_ADMISSION_RPO_MS,
    sourceDueAt: dueAt,
    rpoDeadlineAt: new Date(dueAt.getTime() + BACKUP_ADMISSION_RPO_MS),
    firstEligibleAt: dueAt,
    effectivePriority: priority,
    ownerId: options.ownerId ?? OWNER_ID,
    generation: uuid(600_000 + seed),
    expiresAt: new Date(SCHEDULED_TIME + BACKUP_ADMISSION_LEASE_MS),
    workAttempt: 1,
    claimCycleStartTurn: "1",
    claimProofTurn: `${seed + 1}`,
    claimProofXid: `${seed + 10_000}`,
    claimProofPriorityPass: priority,
  };
}

function claimedTurn(claims: readonly AdmissionClaim[]): ClaimedTurn {
  const [first, ...remaining] = claims;
  if (!first) throw new Error("claimedTurn requires at least one claim");
  return { outcome: "claimed", claims: [first, ...remaining] };
}

function dependencies(
  overrides: Partial<AgentBackupAdmissionRuntimeDependencies> = {},
): AgentBackupAdmissionRuntimeDependencies {
  let enrollmentShard = 0;
  return {
    enroll: async () => {
      const shardId = enrollmentShard;
      enrollmentShard += 1;
      return {
        shardId,
        cohortId: `${shardId + 1}`,
        enrolled: 0,
        queued: 0,
        cohortComplete: true,
      };
    },
    claim: async () => ({ outcome: "idle", claims: [] }),
    reserve: async ({ claim }) => ({
      workId: claim.workId,
      operationId: claim.workId,
      backupId: uuid(900_000),
      replayed: false,
    }),
    defer: async () => "deferred",
    now: () => SCHEDULED_TIME + 1,
    ...overrides,
  };
}

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("agent backup admission runtime", () => {
  test("uses fixed authority bounds and stops only on an authoritative idle outcome", async () => {
    const enrollmentParams: Array<{
      ownerId: string;
      limit: number;
      leaseMs: number;
      rpoMs: number;
    }> = [];
    const claimParams: Array<{ ownerId: string; limit: number; leaseMs: number }> = [];

    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        enroll: async (params) => {
          enrollmentParams.push(params);
          return {
            shardId: enrollmentParams.length - 1,
            cohortId: `${enrollmentParams.length}`,
            enrolled: 2,
            queued: 1,
            cohortComplete: true,
          };
        },
        claim: async (params) => {
          claimParams.push(params);
          return { outcome: "idle", claims: [] };
        },
      }),
    );

    expect(enrollmentParams).toHaveLength(MAX_ENROLLMENT_TURNS);
    expect(
      enrollmentParams.every(
        (params) =>
          params.ownerId === OWNER_ID &&
          params.limit === ENROLLMENT_BATCH_SIZE &&
          params.leaseMs === BACKUP_ADMISSION_LEASE_MS &&
          params.rpoMs === BACKUP_ADMISSION_RPO_MS,
      ),
    ).toBe(true);
    expect(claimParams).toEqual([
      { ownerId: OWNER_ID, limit: CLAIM_BATCH_SIZE, leaseMs: BACKUP_ADMISSION_LEASE_MS },
    ]);
    expect(summary).toEqual({
      enrollmentTurns: 64,
      enrollmentUnavailable: 0,
      enrollmentCompletedShards: 64,
      enrolled: 128,
      queued: 64,
      cohortsComplete: 64,
      claimTurns: 1,
      claimClaimedTurns: 0,
      claimProgressedTurns: 0,
      claimContendedTurns: 0,
      claimIdleTurns: 1,
      claimed: 0,
      reserved: 0,
      replayed: 0,
      deferred: 0,
      retryExhausted: 0,
      indeterminate: 0,
      stopReason: "idle",
      continuationRequired: false,
      retryAfterMs: null,
      alerts: [],
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.alerts)).toBe(true);
  });

  test("does not report idle while enrollment authorities are contended", async () => {
    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        enroll: async () => null,
        claim: async () => ({ outcome: "idle", claims: [] }),
      }),
    );

    expect(summary).toMatchObject({
      enrollmentTurns: 1,
      enrollmentUnavailable: 1,
      enrollmentCompletedShards: 0,
      claimIdleTurns: 1,
      stopReason: "enrollment_contended",
      continuationRequired: true,
      retryAfterMs: BACKUP_ADMISSION_CONTENTION_BACKOFF_MS,
      alerts: [BACKUP_ADMISSION_ENROLLMENT_CONTENDED_ALERT],
    });
  });

  test("requires 64 distinct completed shards before enrollment can support idle", async () => {
    let enrollmentCalls = 0;
    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        enroll: async () => {
          enrollmentCalls += 1;
          return {
            shardId: 0,
            cohortId: `${enrollmentCalls}`,
            enrolled: 1,
            queued: 1,
            cohortComplete: true,
          };
        },
        claim: async () => ({ outcome: "idle", claims: [] }),
      }),
    );

    expect(enrollmentCalls).toBe(MAX_ENROLLMENT_TURNS);
    expect(summary).toMatchObject({
      enrollmentTurns: MAX_ENROLLMENT_TURNS,
      enrollmentUnavailable: 0,
      enrollmentCompletedShards: 1,
      cohortsComplete: MAX_ENROLLMENT_TURNS,
      claimIdleTurns: 1,
      stopReason: "enrollment_turn_budget",
      continuationRequired: true,
      retryAfterMs: 0,
      alerts: [BACKUP_ADMISSION_ENROLLMENT_TURN_BUDGET_ALERT],
    });
  });

  test("fails closed on an invalid completed enrollment shard", async () => {
    let claimCalls = 0;
    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          enroll: async () => ({
            shardId: MAX_ENROLLMENT_TURNS,
            cohortId: "invalid-shard",
            enrolled: 1,
            queued: 1,
            cohortComplete: true,
          }),
          claim: async () => {
            claimCalls += 1;
            return { outcome: "idle", claims: [] };
          },
        }),
      ),
    );

    expect(error).toMatchObject({ code: "BACKUP_ADMISSION_ENROLLMENT_SHARD_INVALID" });
    expect(claimCalls).toBe(0);
  });

  test("continues through 448 progressed turns before a lower-priority claim", async () => {
    const claim = admissionClaim(1, { priority: 3 });
    let claimCalls = 0;
    const reserved: string[] = [];

    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        claim: async () => {
          claimCalls += 1;
          if (claimCalls <= 448) return { outcome: "progressed", claims: [] };
          if (claimCalls === 449) return claimedTurn([claim]);
          return { outcome: "idle", claims: [] };
        },
        reserve: async ({ claim: leased }) => {
          reserved.push(leased.workId);
          return {
            workId: leased.workId,
            operationId: leased.workId,
            backupId: leased.workId,
            replayed: true,
          };
        },
      }),
    );

    expect(claimCalls).toBe(450);
    expect(reserved).toEqual([claim.workId]);
    expect(summary).toMatchObject({
      claimTurns: 450,
      claimClaimedTurns: 1,
      claimProgressedTurns: 448,
      claimContendedTurns: 0,
      claimIdleTurns: 1,
      claimed: 1,
      reserved: 1,
      replayed: 1,
      stopReason: "idle",
      continuationRequired: false,
    });
  });

  test("stops immediately on contention with an explicit bounded retry hint", async () => {
    let claimCalls = 0;
    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        claim: async () => {
          claimCalls += 1;
          return { outcome: "contended", claims: [] };
        },
      }),
    );

    expect(claimCalls).toBe(1);
    expect(summary).toMatchObject({
      claimTurns: 1,
      claimClaimedTurns: 0,
      claimProgressedTurns: 0,
      claimContendedTurns: 1,
      claimIdleTurns: 0,
      stopReason: "contended",
      continuationRequired: true,
      retryAfterMs: BACKUP_ADMISSION_CONTENTION_BACKOFF_MS,
      alerts: [BACKUP_ADMISSION_CLAIM_CONTENDED_ALERT],
    });
    expect(BACKUP_ADMISSION_CONTENTION_BACKOFF_MS).toBeGreaterThan(0);
    expect(BACKUP_ADMISSION_CONTENTION_BACKOFF_MS).toBeLessThan(BACKUP_ADMISSION_CYCLE_DEADLINE_MS);
  });

  test("turn-budget exhaustion requests continuation and never fabricates idle", async () => {
    let claimCalls = 0;
    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        claim: async () => {
          claimCalls += 1;
          return { outcome: "progressed", claims: [] };
        },
      }),
    );

    expect(claimCalls).toBe(MAX_CLAIM_TURNS_PER_INVOCATION);
    expect(summary).toMatchObject({
      claimTurns: MAX_CLAIM_TURNS_PER_INVOCATION,
      claimProgressedTurns: MAX_CLAIM_TURNS_PER_INVOCATION,
      claimIdleTurns: 0,
      claimed: 0,
      stopReason: "claim_turn_budget",
      continuationRequired: true,
      retryAfterMs: 0,
      alerts: [BACKUP_ADMISSION_CLAIM_TURN_BUDGET_ALERT],
    });
  });

  test("claims at most 800 items without probing past the processing budget", async () => {
    const requestedLimits: number[] = [];
    const reserved = new Set<string>();
    let nextSeed = 1;

    const summary = await runAgentBackupAdmissionCycle(
      { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
      dependencies({
        claim: async ({ limit }) => {
          requestedLimits.push(limit);
          return claimedTurn(Array.from({ length: limit }, () => admissionClaim(nextSeed++)));
        },
        reserve: async ({ claim }) => {
          reserved.add(claim.workId);
          return {
            workId: claim.workId,
            operationId: claim.workId,
            backupId: claim.workId,
            replayed: false,
          };
        },
      }),
    );

    expect(requestedLimits).toEqual(Array.from({ length: 32 }, () => CLAIM_BATCH_SIZE));
    expect(reserved.size).toBe(MAX_CLAIMS_PER_INVOCATION);
    expect(summary).toMatchObject({
      claimTurns: 32,
      claimClaimedTurns: 32,
      claimed: MAX_CLAIMS_PER_INVOCATION,
      reserved: MAX_CLAIMS_PER_INVOCATION,
      claimIdleTurns: 0,
      stopReason: "claim_item_budget",
      continuationRequired: true,
      retryAfterMs: 0,
      alerts: [BACKUP_ADMISSION_CLAIM_ITEM_BUDGET_ALERT],
    });
  });

  test("drains an oversized claimed batch before failing its hard claim contract", async () => {
    const claims = Array.from({ length: CLAIM_BATCH_SIZE + 1 }, (_, index) =>
      admissionClaim(index + 1),
    );
    const reserved: string[] = [];

    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          claim: async () => claimedTurn(claims),
          reserve: async ({ claim }) => {
            reserved.push(claim.workId);
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: false,
            };
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentBackupAdmissionBatchError);
    if (!(error instanceof AgentBackupAdmissionBatchError)) throw error;
    expect(reserved).toEqual(claims.map(({ workId }) => workId));
    expect(error.summary).toMatchObject({
      claimed: CLAIM_BATCH_SIZE + 1,
      reserved: CLAIM_BATCH_SIZE + 1,
      stopReason: "failed",
      continuationRequired: true,
    });
    expect(error.cause).toBeInstanceOf(AggregateError);
    if (!(error.cause instanceof AggregateError)) throw error;
    expect(error.cause.errors).toHaveLength(1);
    expect(error.cause.errors[0]).toMatchObject({
      code: "BACKUP_ADMISSION_CLAIM_BUDGET_EXCEEDED",
    });
  });

  test("fails closed on a malformed claimed outcome before reserve or defer", async () => {
    const malformedTurn = claimedTurn([admissionClaim(1)]);
    malformedTurn.claims.pop();
    let reserveCalls = 0;
    let deferCalls = 0;

    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          claim: async () => malformedTurn,
          reserve: async ({ claim }) => {
            reserveCalls += 1;
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: false,
            };
          },
          defer: async () => {
            deferCalls += 1;
            return "deferred";
          },
        }),
      ),
    );

    expect(error).toMatchObject({ code: "BACKUP_ADMISSION_CLAIM_OUTCOME_INVALID" });
    expect(reserveCalls).toBe(0);
    expect(deferCalls).toBe(0);
  });

  test("rejects a tick already past its scheduler-anchored deadline before any authority", async () => {
    const calls: string[] = [];
    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          now: () => SCHEDULED_TIME + BACKUP_ADMISSION_CYCLE_DEADLINE_MS,
          enroll: async () => {
            calls.push("enroll");
            return null;
          },
          claim: async () => {
            calls.push("claim");
            return { outcome: "idle", claims: [] };
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentBackupAdmissionDeadlineError);
    expect(error).toMatchObject({ code: "BACKUP_ADMISSION_CYCLE_DEADLINE_REACHED" });
    expect(calls).toEqual([]);
  });

  test("does not start a claim when the deadline is reached during enrollment", async () => {
    let now = SCHEDULED_TIME + 1;
    let claimCalls = 0;
    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          now: () => now,
          enroll: async () => {
            now = SCHEDULED_TIME + BACKUP_ADMISSION_CYCLE_DEADLINE_MS;
            return null;
          },
          claim: async () => {
            claimCalls += 1;
            return { outcome: "idle", claims: [] };
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentBackupAdmissionDeadlineError);
    expect(claimCalls).toBe(0);
  });

  test("propagates a deadline reached after a progressed claim turn", async () => {
    let now = SCHEDULED_TIME + 1;
    let claimCalls = 0;
    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          now: () => now,
          claim: async () => {
            claimCalls += 1;
            now = SCHEDULED_TIME + BACKUP_ADMISSION_CYCLE_DEADLINE_MS;
            return { outcome: "progressed", claims: [] };
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentBackupAdmissionDeadlineError);
    expect(claimCalls).toBe(1);
  });

  test("drains a claimed batch before propagating its post-claim deadline", async () => {
    let now = SCHEDULED_TIME + 1;
    const claims = [admissionClaim(1), admissionClaim(2), admissionClaim(3)];
    const reserved: string[] = [];
    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          now: () => now,
          claim: async () => {
            now = SCHEDULED_TIME + BACKUP_ADMISSION_CYCLE_DEADLINE_MS;
            return claimedTurn(claims);
          },
          reserve: async ({ claim }) => {
            reserved.push(claim.workId);
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: false,
            };
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(AgentBackupAdmissionDeadlineError);
    expect(reserved).toEqual(claims.map(({ workId }) => workId));
  });

  test("honors AbortSignal before work and only after draining an acquired batch", async () => {
    const preController = new AbortController();
    const preReason = new Error("stop before admission");
    const preCalls: string[] = [];
    preController.abort(preReason);
    const preError = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME, signal: preController.signal },
        dependencies({
          enroll: async () => {
            preCalls.push("enroll");
            return null;
          },
        }),
      ),
    );
    expect(preError).toBe(preReason);
    expect(preCalls).toEqual([]);

    const controller = new AbortController();
    const reason = new Error("shutdown after leased batch");
    const claims = [admissionClaim(1), admissionClaim(2), admissionClaim(3)];
    const reserved: string[] = [];
    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME, signal: controller.signal },
        dependencies({
          claim: async () => {
            controller.abort(reason);
            return claimedTurn(claims);
          },
          reserve: async ({ claim }) => {
            reserved.push(claim.workId);
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: false,
            };
          },
        }),
      ),
    );
    expect(error).toBe(reason);
    expect(reserved).toEqual(claims.map(({ workId }) => workId));
  });

  test("aggregates reservation and defer failures after compensating the full batch", async () => {
    const claims = Array.from({ length: 5 }, (_, index) => admissionClaim(index + 1));
    const events: string[] = [];

    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME },
        dependencies({
          claim: async () => claimedTurn(claims),
          reserve: async ({ claim }) => {
            const index = claims.findIndex(({ workId }) => workId === claim.workId);
            events.push(`reserve:${index + 1}`);
            if (index > 0) throw new Error(`reservation-${index + 1}`);
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: true,
            };
          },
          defer: async ({ fence, reason, retryDelayMs }) => {
            const index = claims.findIndex(({ workId }) => workId === fence.workId);
            events.push(`defer:${index + 1}:${reason}:${retryDelayMs}`);
            if (index === 1) return "deferred";
            if (index === 2) return "retry_exhausted";
            if (index === 3) return null;
            throw new Error("defer-response-lost");
          },
        }),
      ),
    );

    expect(events).toEqual([
      "reserve:1",
      "reserve:2",
      `defer:2:${BACKUP_ADMISSION_RESERVATION_RETRY_REASON}:${BACKUP_ADMISSION_DEFER_MS}`,
      "reserve:3",
      `defer:3:${BACKUP_ADMISSION_RESERVATION_RETRY_REASON}:${BACKUP_ADMISSION_DEFER_MS}`,
      "reserve:4",
      `defer:4:${BACKUP_ADMISSION_RESERVATION_RETRY_REASON}:${BACKUP_ADMISSION_DEFER_MS}`,
      "reserve:5",
      `defer:5:${BACKUP_ADMISSION_RESERVATION_RETRY_REASON}:${BACKUP_ADMISSION_DEFER_MS}`,
    ]);
    expect(error).toBeInstanceOf(AgentBackupAdmissionBatchError);
    if (!(error instanceof AgentBackupAdmissionBatchError)) throw error;
    expect(error.summary).toMatchObject({
      claimTurns: 1,
      claimClaimedTurns: 1,
      claimed: 5,
      reserved: 1,
      replayed: 1,
      deferred: 1,
      retryExhausted: 1,
      indeterminate: 2,
      stopReason: "failed",
      continuationRequired: true,
      retryAfterMs: BACKUP_ADMISSION_DEFER_MS,
      alerts: [
        BACKUP_ADMISSION_RESERVATION_RECONCILE_ALERT,
        BACKUP_ADMISSION_RESERVATION_RETRY_REASON,
        BACKUP_ADMISSION_RESERVATION_RETRY_EXHAUSTED_ALERT,
      ],
    });
    expect(error.cause).toBeInstanceOf(AggregateError);
    if (!(error.cause instanceof AggregateError)) throw error;
    expect(error.cause.errors).toHaveLength(6);
    expect(error.cause.errors.map((failure) => failure.code)).toEqual([
      "BACKUP_ADMISSION_RESERVATION_FAILED",
      "BACKUP_ADMISSION_RESERVATION_FAILED",
      "BACKUP_ADMISSION_RESERVATION_FAILED",
      "BACKUP_ADMISSION_DEFER_INDETERMINATE",
      "BACKUP_ADMISSION_RESERVATION_FAILED",
      "BACKUP_ADMISSION_DEFER_FAILED",
    ]);
  });

  test("preserves compensation failures and cancellation after the entire leased batch", async () => {
    const controller = new AbortController();
    const abortReason = new Error("shutdown during first reservation");
    const claims = [admissionClaim(1), admissionClaim(2), admissionClaim(3)];
    const reservations: string[] = [];
    const deferrals: string[] = [];

    const error = await rejectionOf(
      runAgentBackupAdmissionCycle(
        { ownerId: OWNER_ID, scheduledTime: SCHEDULED_TIME, signal: controller.signal },
        dependencies({
          claim: async () => claimedTurn(claims),
          reserve: async ({ claim }) => {
            reservations.push(claim.workId);
            if (claim.workId === claims[0]?.workId) {
              controller.abort(abortReason);
              throw new Error("first reservation failed");
            }
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: false,
            };
          },
          defer: async ({ fence }) => {
            deferrals.push(fence.workId);
            return "deferred";
          },
        }),
      ),
    );

    expect(reservations).toEqual(claims.map(({ workId }) => workId));
    expect(deferrals).toEqual([claims[0]?.workId]);
    expect(error).toBeInstanceOf(AgentBackupAdmissionBatchError);
    if (!(error instanceof AgentBackupAdmissionBatchError)) throw error;
    expect(error.cause).toBeInstanceOf(AggregateError);
    if (!(error.cause instanceof AggregateError)) throw error;
    expect(error.cause.errors).toHaveLength(2);
    expect(error.cause.errors[1]).toBe(abortReason);
  });

  test("drains 10,640 items across 64 shards and four priorities in fourteen ticks", async () => {
    const cohortSize = 10_640;
    const arrivalTicks = [1, 4, 7, 10] as const;
    const cohort = Array.from({ length: cohortSize }, (_, index) => {
      const seed = index + 1;
      const shard = index % 64;
      const priority = Math.floor(index / 64) % 4;
      const arrivalIndex = index % arrivalTicks.length;
      return {
        arrivalIndex,
        arrivalTick: arrivalTicks[arrivalIndex],
        claim: admissionClaim(seed, {
          priority,
          dueOffsetMs: arrivalIndex * 60_000,
        }),
        priority,
        shard,
      };
    });
    const expectedIds = cohort.map(({ claim }) => claim.workId).sort();
    const cohortById = new Map(cohort.map((item) => [item.claim.workId, item]));
    const ready: typeof cohort = [];
    const reservedIds = new Set<string>();
    const reservedByShard = Array.from({ length: 64 }, () => 0);
    const reservedByPriority = Array.from({ length: 4 }, () => 0);
    const barrierProgress = new Map<string, number>();
    const consumedBarriers = new Map<string, number>();
    let maxConcurrentReservations = 0;
    let concurrentReservations = 0;
    const claimedPerTick: number[] = [];
    const stopReasons: string[] = [];

    const laneKey = (item: (typeof cohort)[number]): string =>
      `${item.arrivalIndex}:${item.priority}`;
    for (const arrivalIndex of [0, 1, 2, 3]) {
      barrierProgress.set(`${arrivalIndex}:0`, 0);
      barrierProgress.set(`${arrivalIndex}:1`, 192);
      barrierProgress.set(`${arrivalIndex}:2`, 448);
      barrierProgress.set(`${arrivalIndex}:3`, 192);
    }

    for (let tick = 1; tick <= 14; tick += 1) {
      ready.push(...cohort.filter(({ arrivalTick }) => arrivalTick === tick));
      ready.sort(
        (left, right) =>
          left.priority - right.priority ||
          left.arrivalTick - right.arrivalTick ||
          left.shard - right.shard ||
          left.claim.workId.localeCompare(right.claim.workId),
      );
      const scheduledTime = SCHEDULED_TIME + (tick - 1) * 60_000;
      const ownerId = `agent-backup-admission:${scheduledTime}`;

      const summary = await runAgentBackupAdmissionCycle(
        { ownerId, scheduledTime },
        dependencies({
          now: () => scheduledTime + 1,
          claim: async ({ limit }) => {
            const next = ready[0];
            if (!next) return { outcome: "idle", claims: [] };
            const key = laneKey(next);
            const remainingProgress = barrierProgress.get(key);
            if (remainingProgress === undefined) throw new Error(`missing barrier ${key}`);
            if (remainingProgress > 0) {
              barrierProgress.set(key, remainingProgress - 1);
              consumedBarriers.set(key, (consumedBarriers.get(key) ?? 0) + 1);
              return { outcome: "progressed", claims: [] };
            }

            let batchSize = 1;
            while (
              batchSize < limit &&
              ready[batchSize] !== undefined &&
              laneKey(ready[batchSize] as (typeof cohort)[number]) === key
            ) {
              batchSize += 1;
            }
            const batch = ready.splice(0, batchSize).map(({ claim }) => ({ ...claim, ownerId }));
            return claimedTurn(batch);
          },
          reserve: async ({ claim }) => {
            concurrentReservations += 1;
            maxConcurrentReservations = Math.max(maxConcurrentReservations, concurrentReservations);
            await Promise.resolve();
            if (reservedIds.has(claim.workId)) {
              throw new Error(`duplicate reservation for ${claim.workId}`);
            }
            const item = cohortById.get(claim.workId);
            if (!item) throw new Error(`unknown claim ${claim.workId}`);
            reservedIds.add(claim.workId);
            reservedByShard[item.shard] += 1;
            reservedByPriority[item.priority] += 1;
            concurrentReservations -= 1;
            return {
              workId: claim.workId,
              operationId: claim.workId,
              backupId: claim.workId,
              replayed: false,
            };
          },
        }),
      );

      claimedPerTick.push(summary.claimed);
      stopReasons.push(summary.stopReason);
      expect(summary.reserved).toBe(summary.claimed);
      expect(summary.deferred).toBe(0);
      expect(summary.indeterminate).toBe(0);
    }

    expect(claimedPerTick).toEqual([
      ...Array.from({ length: 13 }, () => MAX_CLAIMS_PER_INVOCATION),
      240,
    ]);
    expect(stopReasons).toEqual([...Array.from({ length: 13 }, () => "claim_item_budget"), "idle"]);
    expect(consumedBarriers.get("0:1")).toBe(192);
    expect(consumedBarriers.get("0:2")).toBe(448);
    expect(ready).toHaveLength(0);
    expect(reservedIds.size).toBe(cohortSize);
    expect([...reservedIds].sort()).toEqual(expectedIds);
    expect(maxConcurrentReservations).toBe(1);
    expect(reservedByShard.every((count) => count > 0)).toBe(true);
    expect(reservedByPriority.every((count) => count > 0)).toBe(true);
    expect(reservedByShard.reduce((sum, count) => sum + count, 0)).toBe(cohortSize);
    expect(reservedByPriority.reduce((sum, count) => sum + count, 0)).toBe(cohortSize);
  });
});
