/** Proves provider-call fencing and lost-response reconciliation in the deletion saga. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AccountDeletionPhaseReceipt } from "../../db/schemas/account-deletion-phase-receipts";
import type { AccountDeletionRequest } from "../../db/schemas/account-deletion-requests";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";

const request = {
  id: "50000000-0000-4000-8000-000000000001",
  user_id: "20000000-0000-4000-8000-000000000001",
  organization_id: "10000000-0000-4000-8000-000000000001",
  steward_user_id: "steward-personal",
  request_digest: "a".repeat(64),
  lifecycle_revision: 2,
} as AccountDeletionRequest;

let phaseStatus = "pending";
let generation = 0;
const phase = () =>
  ({
    id: "60000000-0000-4000-8000-000000000001",
    request_id: request.id,
    phase: "stripe",
    phase_order: 10,
    status: phaseStatus,
    lease_generation: generation,
    idempotency_key_digest: "b".repeat(64),
    attempt_count: 0,
    max_attempts: 12,
  }) as AccountDeletionPhaseReceipt;

const repo = {
  findRunnableIrreversibleRequests: mock(async () => [request]),
  listPhaseReceipts: mock(async () => [phase()]),
  leasePhase: mock(async () => {
    generation++;
    const priorStatus = phaseStatus;
    phaseStatus =
      priorStatus === "calling" || priorStatus === "reconciling" ? "reconciling" : "leased";
    return { receipt: phase(), generation };
  }),
  markPhaseProviderCallStarted: mock(async () => {
    phaseStatus = "calling";
    return true;
  }),
  markPhaseForReconciliation: mock(async () => {
    phaseStatus = "reconciling";
    return true;
  }),
  deferPhaseReconciliation: mock(async () => true),
  markPhaseRetryable: mock(async () => true),
  markPhaseActionRequired: mock(async () => true),
  scheduleRequestReconciliation: mock(async () => undefined),
  completeProviderPhase: mock(async () => {
    phaseStatus = "completed";
    return true;
  }),
  completeStewardDeactivationPhase: mock(async () => true),
  finalizePersonalAccountDeletion: mock(async () => ({ outcome: "completed" as const, request })),
  findRecoveryPhaseCandidates: mock(async () => []),
};

mock.module("../../db/repositories/account-deletion-requests", () => ({
  accountDeletionRequestsRepository: repo,
}));

const { processIrreversibleAccountDeletionSaga } = await import("./account-deletion-saga");

const blob = {} as RuntimeR2Bucket;
const unusedAdapter = {
  inspect: mock(async () => ({ state: "complete" as const, receiptDigest: "c".repeat(64) })),
  execute: mock(async () => undefined),
};

function adapters(stripe: typeof unusedAdapter) {
  return {
    steward_deactivation: unusedAdapter,
    stripe,
    domains: unusedAdapter,
    secondary_backups: unusedAdapter,
    spools: unusedAdapter,
    compute_containers: unusedAdapter,
    github_repositories: unusedAdapter,
    connector_credentials: unusedAdapter,
    voice_credentials: unusedAdapter,
    primary_object_storage: unusedAdapter,
    vault_key_bindings: unusedAdapter,
    other_grants: unusedAdapter,
    steward_deletion: unusedAdapter,
  };
}

beforeEach(() => {
  phaseStatus = "pending";
  generation = 0;
  for (const value of Object.values(repo)) value.mockClear();
  unusedAdapter.inspect.mockClear();
  unusedAdapter.execute.mockClear();
});

describe("account deletion provider saga", () => {
  test("reconciles provider success with a lost response without repeating mutation", async () => {
    let providerDeleted = false;
    const stripe = {
      inspect: mock(async () =>
        providerDeleted
          ? { state: "complete" as const, receiptDigest: "d".repeat(64) }
          : { state: "needs_execution" as const },
      ),
      execute: mock(async () => {
        providerDeleted = true;
        throw new Error("response lost after provider commit");
      }),
    };

    const first = await processIrreversibleAccountDeletionSaga({
      limit: 1,
      blob,
      adapters: adapters(stripe),
      now: new Date("2026-08-22T12:00:00Z"),
    });
    expect(first).toMatchObject({ processed: 1, reconciling: 1, progressed: 0 });
    expect(stripe.execute).toHaveBeenCalledTimes(1);
    expect(repo.markPhaseForReconciliation).toHaveBeenCalledTimes(1);

    const second = await processIrreversibleAccountDeletionSaga({
      limit: 1,
      blob,
      adapters: adapters(stripe),
      now: new Date("2026-08-22T12:02:00Z"),
    });
    expect(second).toMatchObject({ processed: 1, reconciling: 0, progressed: 1 });
    expect(stripe.execute).toHaveBeenCalledTimes(1);
    expect(repo.completeProviderPhase).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2, providerReceiptDigest: "d".repeat(64) }),
    );
  });

  test("never executes while canonical inspection is unavailable", async () => {
    phaseStatus = "reconciling";
    const stripe = {
      inspect: mock(async () => {
        throw new Error("provider outage");
      }),
      execute: mock(async () => undefined),
    };
    const result = await processIrreversibleAccountDeletionSaga({
      limit: 1,
      blob,
      adapters: adapters(stripe),
      now: new Date("2026-08-22T12:00:00Z"),
    });
    expect(result).toMatchObject({ processed: 1, reconciling: 1 });
    expect(stripe.execute).not.toHaveBeenCalled();
    expect(repo.deferPhaseReconciliation).toHaveBeenCalledTimes(1);
    expect(repo.markPhaseRetryable).not.toHaveBeenCalled();
  });

  test("does not cross a provider boundary when the lease generation is stale", async () => {
    repo.markPhaseProviderCallStarted.mockResolvedValueOnce(false);
    const stripe = {
      inspect: mock(async () => ({ state: "needs_execution" as const })),
      execute: mock(async () => undefined),
    };
    const result = await processIrreversibleAccountDeletionSaga({
      limit: 1,
      blob,
      adapters: adapters(stripe),
      now: new Date("2026-08-22T12:00:00Z"),
    });
    expect(result).toMatchObject({ processed: 1, progressed: 0, reconciling: 0 });
    expect(stripe.execute).not.toHaveBeenCalled();
  });
});
