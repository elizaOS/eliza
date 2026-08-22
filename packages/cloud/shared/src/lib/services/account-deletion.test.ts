/** Verifies reserved deletion admission, opaque credentials, and fenced legacy claims. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const CLAIM_GENERATION = new Date("2026-09-18T00:00:01Z");
const REQUESTED_AT = new Date("2026-08-19T00:00:00Z");
const RECOVERY_AT = new Date("2026-09-18T00:00:00Z");

function reservedRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    steward_user_id: "steward-1",
    operation_kind: "personal_account_deletion",
    status: "reserved",
    lifecycle_revision: 1,
    lease_generation: 0,
    lease_expires_at: null,
    status_token_hash: "status-hash",
    status_token_expires_at: new Date("2026-12-17T00:00:00Z"),
    recovery_token_hash: "recovery-hash",
    recovery_token_expires_at: RECOVERY_AT,
    request_digest: "request-digest",
    restore_auto_top_up_enabled: false,
    restore_pay_as_you_go_from_earnings: true,
    requested_at: REQUESTED_AT,
    recovery_expires_at: RECOVERY_AT,
    execute_after: RECOVERY_AT,
    identity_deactivated_at: null,
    processing_started_at: null,
    irreversible_at: null,
    canceled_at: null,
    completed_at: null,
    completion_receipt_digest: null,
    last_error_code: null,
    failure_class: null,
    next_reconcile_at: null,
    attempts: 0,
    max_attempts: 5,
    updated_at: REQUESTED_AT,
    ...overrides,
  };
}

const reservePersonalAccountDeletion = mock(async () => ({
  outcome: "reserved" as const,
  request: reservedRequest(),
}));
const leasePhase = mock(async () => ({
  receipt: { id: "44444444-4444-4444-8444-444444444444" },
  generation: 1,
}));
const markPhaseProviderCallStarted = mock(async () => true);
const completeStewardDeactivationPhase = mock(async () => true);
const completeStewardReactivationPhase = mock(async () => true);
const markPhaseForReconciliation = mock(async () => true);
const deferPhaseReconciliation = mock(async () => true);
const markPhaseRetryable = mock(async () => true);
const markPhaseActionRequired = mock(async () => true);
const cancelDuringRecovery = mock(async () => ({
  outcome: "canceling" as const,
  request: reservedRequest({
    status: "canceling",
    canceled_at: REQUESTED_AT,
    recovery_token_hash: null,
    recovery_token_expires_at: null,
    identity_deactivated_at: REQUESTED_AT,
    last_error_code: "STEWARD_REACTIVATION_PENDING",
  }),
  stewardUserId: "steward-1",
}));
const requestRepo = {
  reservePersonalAccountDeletion,
  cancelDuringRecovery,
  leasePhase,
  markPhaseProviderCallStarted,
  completeStewardDeactivationPhase,
  completeStewardReactivationPhase,
  markPhaseForReconciliation,
  deferPhaseReconciliation,
  markPhaseRetryable,
  markPhaseActionRequired,
  findOpenByUserId: mock(async () => undefined),
  findById: mock(async () =>
    reservedRequest({
      status: "canceling",
      canceled_at: REQUESTED_AT,
      identity_deactivated_at: null,
      last_error_code: "CANCELLATION_CLEANUP_PENDING",
    }),
  ),
  findByStatusTokenHash: mock(async () => undefined),
  findCancelingRequestIds: mock(async () => []),
  finalizeCancellationIfComplete: mock(async () => false),
  findRecoveryPhaseCandidates: mock(async () => []),
  findCancellationPhaseCandidates: mock(async () => []),
  findExpiredRecoveryRequestIds: mock(async () => []),
  findRunnableIrreversibleRequests: mock(async () => []),
  listPhaseReceipts: mock(async () => []),
  activateExpiredPersonalAccountDeletion: mock(async () => ({ outcome: "not_due" as const })),
  markRecoveryActionRequired: mock(async () => false),
  claimDue: mock(async () => []),
  recoverStaleProcessing: mock(async () => 0),
  markActionRequired: mock(async () => true),
  recordPurgeFailure: mock(async () => undefined),
};
const deactivateSteward = mock(async () => ({ userId: "steward-1" }));
const reactivateSteward = mock(async () => ({ userId: "steward-1" }));
const inspectSteward = mock(async () => "deactivated" as const);
const deleteSteward = mock(async () => ({ userId: "steward-1" }));
const purgeOrganizationResources = mock(async () => undefined);
const reconcileAccountDeletionExportRevocations = mock(async () => ({
  scheduled: 0,
  completed: 0,
  pending: 0,
}));
const blob = {
  head: mock(async () => null),
  get: mock(async () => null),
  put: mock(async () => undefined),
  delete: mock(async () => undefined),
};

mock.module("../../db/repositories/account-deletion-requests", () => ({
  accountDeletionRequestsRepository: requestRepo,
}));
mock.module("./steward-platform-users", () => ({
  deactivateStewardPlatformUser: deactivateSteward,
  reactivateStewardPlatformUser: reactivateSteward,
  inspectStewardPlatformUser: inspectSteward,
  deleteStewardPlatformUser: deleteSteward,
}));
mock.module("./account-deletion-export", () => ({
  reconcileAccountDeletionExportRevocations,
}));
mock.module("../utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { cancelAccountDeletion, processDueAccountDeletions, requestAccountDeletion } = await import(
  "./account-deletion"
);

beforeEach(() => {
  reservePersonalAccountDeletion.mockReset();
  reservePersonalAccountDeletion.mockResolvedValue({
    outcome: "reserved",
    request: reservedRequest(),
  });
  leasePhase.mockReset();
  leasePhase.mockResolvedValue({
    receipt: { id: "44444444-4444-4444-8444-444444444444" },
    generation: 1,
  });
  markPhaseProviderCallStarted.mockReset();
  markPhaseProviderCallStarted.mockResolvedValue(true);
  completeStewardDeactivationPhase.mockReset();
  completeStewardDeactivationPhase.mockResolvedValue(true);
  completeStewardReactivationPhase.mockReset();
  completeStewardReactivationPhase.mockResolvedValue(true);
  markPhaseForReconciliation.mockReset();
  markPhaseForReconciliation.mockResolvedValue(true);
  deferPhaseReconciliation.mockReset();
  deferPhaseReconciliation.mockResolvedValue(true);
  markPhaseRetryable.mockReset();
  markPhaseRetryable.mockResolvedValue(true);
  markPhaseActionRequired.mockReset();
  markPhaseActionRequired.mockResolvedValue(true);
  cancelDuringRecovery.mockReset();
  cancelDuringRecovery.mockResolvedValue({
    outcome: "canceling",
    request: reservedRequest({
      status: "canceling",
      canceled_at: REQUESTED_AT,
      recovery_token_hash: null,
      recovery_token_expires_at: null,
      identity_deactivated_at: REQUESTED_AT,
      last_error_code: "STEWARD_REACTIVATION_PENDING",
    }),
    stewardUserId: "steward-1",
  });
  deactivateSteward.mockReset();
  deactivateSteward.mockResolvedValue({ userId: "steward-1" });
  reactivateSteward.mockReset();
  reactivateSteward.mockResolvedValue({ userId: "steward-1" });
  inspectSteward.mockReset();
  inspectSteward.mockResolvedValue("deactivated");
  requestRepo.findById.mockReset();
  requestRepo.findById.mockResolvedValue(
    reservedRequest({
      status: "canceling",
      canceled_at: REQUESTED_AT,
      identity_deactivated_at: null,
      last_error_code: "CANCELLATION_CLEANUP_PENDING",
    }),
  );
  requestRepo.claimDue.mockReset();
  requestRepo.claimDue.mockResolvedValue([]);
  requestRepo.recoverStaleProcessing.mockReset();
  requestRepo.recoverStaleProcessing.mockResolvedValue(0);
  requestRepo.markActionRequired.mockReset();
  requestRepo.markActionRequired.mockResolvedValue(true);
  requestRepo.recordPurgeFailure.mockReset();
  requestRepo.recordPurgeFailure.mockResolvedValue(undefined);
  requestRepo.findRecoveryPhaseCandidates.mockReset();
  requestRepo.findRecoveryPhaseCandidates.mockResolvedValue([]);
  requestRepo.findExpiredRecoveryRequestIds.mockReset();
  requestRepo.findExpiredRecoveryRequestIds.mockResolvedValue([]);
  requestRepo.findRunnableIrreversibleRequests.mockReset();
  requestRepo.findRunnableIrreversibleRequests.mockResolvedValue([]);
  requestRepo.findCancellationPhaseCandidates.mockReset();
  requestRepo.findCancellationPhaseCandidates.mockResolvedValue([]);
  requestRepo.findCancelingRequestIds.mockReset();
  requestRepo.findCancelingRequestIds.mockResolvedValue([]);
  purgeOrganizationResources.mockClear();
  reconcileAccountDeletionExportRevocations.mockClear();
});

describe("account deletion lifecycle", () => {
  test("atomically reserves authority and returns separate opaque capabilities", async () => {
    const accepted = await requestAccountDeletion({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      stewardUserId: "steward-1",
      now: REQUESTED_AT,
    });

    expect(reservePersonalAccountDeletion).toHaveBeenCalledTimes(1);
    const reservation = reservePersonalAccountDeletion.mock.calls[0]?.[0];
    expect(reservation?.phases).toHaveLength(16);
    expect(reservation?.phases[0]).toMatchObject({
      phase: "account_authority",
      completed: true,
    });
    expect(accepted.request).toMatchObject({
      requestId: "33333333-3333-4333-8333-333333333333",
      status: "reserved",
      canCancel: true,
      nextAction: "wait_for_export",
    });
    expect(accepted.statusCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accepted.recoveryCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accepted.statusCredential).not.toBe(accepted.recoveryCredential);
    expect(deactivateSteward).toHaveBeenCalledWith("steward-1");
    expect(completeStewardDeactivationPhase).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["account_unavailable", "ACCOUNT_UNAVAILABLE"],
    ["anonymous_account", "ANONYMOUS_ACCOUNT"],
  ] as const)("returns %s without crossing a provider boundary", async (outcome, code) => {
    reservePersonalAccountDeletion.mockResolvedValueOnce({ outcome });
    await expect(
      requestAccountDeletion({
        userId: "user-1",
        organizationId: "org-1",
        stewardUserId: "steward-1",
      }),
    ).rejects.toMatchObject({ code });
    expect(deactivateSteward).not.toHaveBeenCalled();
  });

  test("rejects a replay without rotating capabilities or crossing a provider boundary", async () => {
    reservePersonalAccountDeletion.mockResolvedValueOnce({
      outcome: "existing",
      request: reservedRequest(),
    });
    await expect(
      requestAccountDeletion({
        userId: "user-1",
        organizationId: "org-1",
        stewardUserId: "steward-1",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_REPLAYED" });
    expect(deactivateSteward).not.toHaveBeenCalled();
  });

  test("returns actionable shared-owner state without mutating Steward", async () => {
    reservePersonalAccountDeletion.mockResolvedValueOnce({
      outcome: "transfer_required",
      activeOwnerCount: 1,
    });
    await expect(
      requestAccountDeletion({
        userId: "user-1",
        organizationId: "org-1",
        stewardUserId: "steward-1",
      }),
    ).rejects.toMatchObject({
      code: "TRANSFER_REQUIRED",
      details: { successorOwnerRequired: true, activeOwnerCount: 1 },
    });
    expect(deactivateSteward).not.toHaveBeenCalled();
  });

  test("records an ambiguous Steward response for reconciliation rather than replay", async () => {
    deactivateSteward.mockRejectedValueOnce(new Error("response lost"));
    await requestAccountDeletion({
      userId: "user-1",
      organizationId: "org-1",
      stewardUserId: "steward-1",
    });
    expect(markPhaseForReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseReceiptId: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        errorCode: "STEWARD_DEACTIVATION_AMBIGUOUS",
      }),
    );
    expect(completeStewardDeactivationPhase).not.toHaveBeenCalled();
  });

  test("uses only the recovery capability to undo and reconciles Steward reactivation", async () => {
    const recoveryCredential = "r".repeat(43);
    const canceled = await cancelAccountDeletion(recoveryCredential);

    expect(cancelDuringRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reactivationIdempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(reactivateSteward).toHaveBeenCalledWith("steward-1");
    expect(completeStewardReactivationPhase).toHaveBeenCalledTimes(1);
    expect(canceled).toMatchObject({
      status: "canceling",
      identityDeactivated: false,
      accessState: "fenced",
      nextAction: "wait_for_reconciliation",
    });
  });

  test("records ambiguous Steward reactivation without restoring provider evidence", async () => {
    reactivateSteward.mockRejectedValueOnce(new Error("response lost"));
    requestRepo.findById.mockResolvedValueOnce(
      reservedRequest({
        status: "canceling",
        canceled_at: REQUESTED_AT,
        identity_deactivated_at: REQUESTED_AT,
        last_error_code: "STEWARD_REACTIVATION_AMBIGUOUS",
      }),
    );
    const canceled = await cancelAccountDeletion("r".repeat(43));

    expect(markPhaseForReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "STEWARD_REACTIVATION_AMBIGUOUS",
      }),
    );
    expect(completeStewardReactivationPhase).not.toHaveBeenCalled();
    expect(canceled).toMatchObject({
      status: "canceling",
      identityDeactivated: true,
      accessState: "fenced",
      nextAction: "wait_for_reconciliation",
    });
  });

  test("reconciles a lost Steward reactivation response after restart without replay", async () => {
    requestRepo.findCancellationPhaseCandidates.mockResolvedValueOnce([
      reservedRequest({ status: "canceling" }),
    ]);
    leasePhase.mockResolvedValueOnce({
      receipt: { id: "44444444-4444-4444-8444-444444444444", status: "reconciling" },
      generation: 2,
    });
    inspectSteward.mockResolvedValueOnce("active");

    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
    });

    expect(result.stewardReactivationReconciliations).toBe(1);
    expect(reactivateSteward).not.toHaveBeenCalled();
    expect(completeStewardReactivationPhase).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
    );
  });

  test("requires a later generation after ambiguous reactivation confirms no effect", async () => {
    requestRepo.findCancellationPhaseCandidates.mockResolvedValueOnce([
      reservedRequest({ status: "canceling" }),
    ]);
    leasePhase.mockResolvedValueOnce({
      receipt: { id: "44444444-4444-4444-8444-444444444444", status: "reconciling" },
      generation: 2,
    });
    inspectSteward.mockResolvedValueOnce("deactivated");

    await processDueAccountDeletions(10, { blob, purgeOrganizationResources });

    expect(markPhaseRetryable).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 2,
        retryClass: "provider_absence_confirmed",
      }),
    );
    expect(reactivateSteward).not.toHaveBeenCalled();
  });

  test("rejects missing object storage before claiming legacy receipts", async () => {
    await expect(processDueAccountDeletions()).rejects.toThrow(
      "Account deletion requires a valid Cloud object-storage binding",
    );
    expect(requestRepo.claimDue).not.toHaveBeenCalled();
  });

  test("parks a legacy due receipt without crossing an irreversible boundary", async () => {
    requestRepo.claimDue.mockResolvedValueOnce([
      {
        id: "request-1",
        user_id: "user-1",
        organization_id: "org-1",
        steward_user_id: "steward-1",
        processing_started_at: CLAIM_GENERATION,
      },
    ]);
    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
    });
    expect(result).toEqual({
      exportRevocations: { scheduled: 0, completed: 0, pending: 0 },
      stewardReactivationReconciliations: 0,
      cancellationsFinalized: 0,
      stewardDeactivationReconciliations: 0,
      activated: 0,
      recovered: 0,
      processed: 1,
      completed: 0,
      progressed: 0,
      reconciling: 0,
      actionRequired: 1,
    });
    expect(requestRepo.markActionRequired).toHaveBeenCalledWith(
      "request-1",
      CLAIM_GENERATION,
      "LIFECYCLE_RESERVATION_REQUIRED",
    );
    expect(purgeOrganizationResources).not.toHaveBeenCalled();
    expect(deleteSteward).not.toHaveBeenCalled();
  });

  test("a stale legacy worker cannot overwrite a newer request state", async () => {
    requestRepo.claimDue.mockResolvedValueOnce([
      {
        id: "request-1",
        user_id: "user-1",
        organization_id: "org-1",
        steward_user_id: "steward-1",
        processing_started_at: CLAIM_GENERATION,
      },
    ]);
    requestRepo.markActionRequired.mockResolvedValueOnce(false);
    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
    });
    expect(result.actionRequired).toBe(0);
    expect(requestRepo.recordPurgeFailure).not.toHaveBeenCalled();
  });
});
