/** Verifies fail-closed deletion admission and generation-fenced worker behavior with mocks. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const CLAIM_GENERATION = new Date("2026-09-18T00:00:01Z");

const requestRepo = {
  createIdempotent: mock(async (data: Record<string, unknown>) => ({
    id: "request-1",
    ...data,
    identity_deactivated_at: null,
    completed_at: null,
  })),
  update: mock(async (id: string, data: Record<string, unknown>) => ({
    id,
    user_id: "user-1",
    organization_id: "org-1",
    steward_user_id: "steward-1",
    processing_started_at: CLAIM_GENERATION,
    requested_at: new Date("2026-08-19T00:00:00Z"),
    execute_after: new Date("2026-09-18T00:00:00Z"),
    identity_deactivated_at: null,
    completed_at: null,
    ...data,
  })),
  findOpenByUserId: mock(async () => undefined),
  findOpenByUserAndOrganization: mock(async () => undefined),
  claimDue: mock(async () => []),
  recoverStaleProcessing: mock(async () => 0),
  markActionRequired: mock(async () => true),
  recordPurgeFailure: mock(async () => undefined),
};
const listByOrganization = mock(async () => [
  {
    id: "user-1",
    organization_id: "org-1",
    role: "owner",
    is_active: true,
    is_anonymous: false,
    deleted_at: null,
  },
]);
const findByIdForWrite = mock(async () => ({ id: "user-1" }));
const deactivateSteward = mock(async () => ({ userId: "steward-1" }));
const deleteSteward = mock(async () => ({ userId: "steward-1" }));
const updateUser = mock(async () => undefined);
const deletePersonalAccount = mock(async () => undefined);
const deleteSharedOrganizationUser = mock(async () => undefined);
const updateOrg = mock(async () => undefined);
const purgeOrganizationResources = mock(async () => undefined);
const recordPurgeFailure = requestRepo.recordPurgeFailure;
const blob = {
  get: mock(async () => null),
  put: mock(async () => undefined),
  delete: mock(async () => undefined),
};

mock.module("../../db/repositories/account-deletion-requests", () => ({
  accountDeletionRequestsRepository: requestRepo,
}));
mock.module("../../db/repositories/api-keys", () => ({
  apiKeysRepository: { deactivateByUserAndOrganization: mock(async () => undefined) },
}));
mock.module("../../db/repositories/users", () => ({
  usersRepository: {
    listByOrganization,
    listByOrganizationForWrite: listByOrganization,
    findByIdForWrite,
  },
}));
mock.module("./steward-platform-users", () => ({
  deactivateStewardPlatformUser: deactivateSteward,
  deleteStewardPlatformUser: deleteSteward,
}));
mock.module("./user-sessions", () => ({
  userSessionsService: { endAllUserSessions: mock(async () => undefined) },
}));
mock.module("./users", () => ({
  usersService: { update: updateUser, deletePersonalAccount, delete: deleteSharedOrganizationUser },
}));
mock.module("./organizations", () => ({
  organizationsService: { update: updateOrg },
}));
mock.module("../utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const {
  AccountDeletionConflictError,
  getAccountDeletionAvailability,
  processDueAccountDeletions,
  requestAccountDeletion,
} = await import("./account-deletion");

beforeEach(() => {
  requestRepo.update.mockClear();
  requestRepo.findOpenByUserAndOrganization.mockClear();
  requestRepo.findOpenByUserAndOrganization.mockResolvedValue(undefined);
  requestRepo.claimDue.mockClear();
  requestRepo.recoverStaleProcessing.mockClear();
  requestRepo.markActionRequired.mockClear();
  requestRepo.markActionRequired.mockResolvedValue(true);
  listByOrganization.mockClear();
  listByOrganization.mockResolvedValue([
    {
      id: "user-1",
      organization_id: "org-1",
      role: "owner",
      is_active: true,
      is_anonymous: false,
      deleted_at: null,
    },
  ]);
  deactivateSteward.mockClear();
  deleteSteward.mockClear();
  updateUser.mockClear();
  deletePersonalAccount.mockClear();
  deleteSharedOrganizationUser.mockClear();
  updateOrg.mockClear();
  purgeOrganizationResources.mockClear();
  recordPurgeFailure.mockClear();
  recordPurgeFailure.mockResolvedValue(undefined);
  requestRepo.claimDue.mockResolvedValue([]);
});

describe("account deletion lifecycle", () => {
  test("projects the personal-account lifecycle fence without mutating account state", async () => {
    await expect(
      getAccountDeletionAvailability({ userId: "user-1", organizationId: "org-1" }),
    ).resolves.toEqual({
      status: "lifecycle_unavailable",
      request: null,
      support: {
        email: "support@eliza.cloud",
        href: "mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request",
      },
    });
    expect(requestRepo.findOpenByUserAndOrganization).toHaveBeenCalledWith("user-1", "org-1", true);
    expect(requestRepo.createIdempotent).not.toHaveBeenCalled();
    expect(deactivateSteward).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    expect(updateOrg).not.toHaveBeenCalled();
  });

  test("projects transfer-required for active shared membership", async () => {
    listByOrganization.mockResolvedValueOnce([
      {
        id: "user-1",
        organization_id: "org-1",
        role: "member",
        is_active: true,
        is_anonymous: false,
        deleted_at: null,
      },
      {
        id: "user-2",
        organization_id: "org-1",
        role: "owner",
        is_active: true,
        is_anonymous: false,
        deleted_at: null,
      },
    ]);

    const projection = await getAccountDeletionAvailability({
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(projection.status).toBe("transfer_required");
    expect(projection.request).toBeNull();
    expect(projection.support?.href).toStartWith("mailto:");
  });

  test("returns only a real tenant-scoped open receipt", async () => {
    requestRepo.findOpenByUserAndOrganization.mockResolvedValueOnce({
      id: "request-1",
      status: "scheduled",
      requested_at: new Date("2026-08-19T00:00:00Z"),
      execute_after: new Date("2026-09-18T00:00:00Z"),
      identity_deactivated_at: null,
      completed_at: null,
    });

    await expect(
      getAccountDeletionAvailability({ userId: "user-1", organizationId: "org-1" }),
    ).resolves.toEqual({
      status: "existing_receipt",
      request: {
        requestId: "request-1",
        status: "scheduled",
        requestedAt: "2026-08-19T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
        identityDeactivated: false,
        completedAt: null,
      },
      support: null,
    });
    expect(listByOrganization).not.toHaveBeenCalled();
  });

  test("rejects a new personal deletion before deactivation when no reservation exists", async () => {
    const rejection = requestAccountDeletion({
      userId: "user-1",
      organizationId: "org-1",
      stewardUserId: "steward-1",
    });
    await expect(rejection).rejects.toEqual(
      new AccountDeletionConflictError(
        "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
        "LIFECYCLE_RESERVATION_REQUIRED",
      ),
    );
    expect(requestRepo.createIdempotent).not.toHaveBeenCalled();
    expect(deactivateSteward).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    expect(updateOrg).not.toHaveBeenCalled();
  });

  test("rejects an inactive account before creating a deletion receipt", async () => {
    listByOrganization.mockResolvedValueOnce([
      { id: "user-1", role: "owner", is_active: false, is_anonymous: false },
    ]);

    await expect(
      requestAccountDeletion({
        userId: "user-1",
        organizationId: "org-1",
        stewardUserId: "steward-1",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    expect(requestRepo.createIdempotent).not.toHaveBeenCalled();
  });

  test("does not treat a revoked former member as active shared authority", async () => {
    listByOrganization.mockResolvedValueOnce([
      { id: "user-1", role: "owner", is_active: true, is_anonymous: false },
      { id: "user-2", role: "member", is_active: false, is_anonymous: false },
    ]);

    await expect(
      requestAccountDeletion({
        userId: "user-1",
        organizationId: "org-1",
        stewardUserId: "steward-1",
      }),
    ).rejects.toMatchObject({ code: "LIFECYCLE_RESERVATION_REQUIRED" });
    expect(requestRepo.createIdempotent).not.toHaveBeenCalled();
  });

  for (const role of ["member", "owner"] as const) {
    test(`rejects a shared-organization ${role} before any mutation`, async () => {
      listByOrganization.mockResolvedValueOnce([
        { id: "user-1", role, is_active: true, is_anonymous: false },
        { id: "user-2", role: "owner", is_active: true, is_anonymous: false },
      ]);

      const rejection = requestAccountDeletion({
        userId: "user-1",
        organizationId: "org-1",
        stewardUserId: "steward-1",
      });
      await expect(rejection).rejects.toMatchObject({ code: "TRANSFER_REQUIRED" });
      expect(requestRepo.createIdempotent).not.toHaveBeenCalled();
      expect(deactivateSteward).not.toHaveBeenCalled();
      expect(updateUser).not.toHaveBeenCalled();
      expect(updateOrg).not.toHaveBeenCalled();
    });
  }

  test("rejects missing object storage before recovering or claiming requests", async () => {
    await expect(processDueAccountDeletions()).rejects.toThrow(
      "Account deletion requires a valid Cloud object-storage binding",
    );
    expect(requestRepo.recoverStaleProcessing).not.toHaveBeenCalled();
    expect(requestRepo.claimDue).not.toHaveBeenCalled();
    expect(recordPurgeFailure).not.toHaveBeenCalled();
  });

  test("requires object listing before any claim when using the default purge", async () => {
    await expect(processDueAccountDeletions(10, { blob })).rejects.toThrow(
      "Account deletion's default resource purge requires Cloud object listing",
    );
    expect(requestRepo.recoverStaleProcessing).not.toHaveBeenCalled();
    expect(requestRepo.claimDue).not.toHaveBeenCalled();
  });

  test("parks a personal organization until a lifecycle reservation exists", async () => {
    requestRepo.claimDue.mockResolvedValue([
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
    expect(result).toEqual({ recovered: 0, processed: 1, completed: 0, actionRequired: 1 });
    expect(requestRepo.markActionRequired).toHaveBeenCalledWith(
      "request-1",
      CLAIM_GENERATION,
      "LIFECYCLE_RESERVATION_REQUIRED",
    );
    expect(purgeOrganizationResources).not.toHaveBeenCalled();
    expect(deleteSteward).not.toHaveBeenCalled();
    expect(deletePersonalAccount).not.toHaveBeenCalled();
    expect(recordPurgeFailure).not.toHaveBeenCalled();
  });

  test("a stale worker cannot overwrite a newer request state", async () => {
    requestRepo.claimDue.mockResolvedValue([
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

    expect(result).toEqual({ recovered: 0, processed: 1, completed: 0, actionRequired: 0 });
    expect(recordPurgeFailure).not.toHaveBeenCalled();
    expect(purgeOrganizationResources).not.toHaveBeenCalled();
    expect(deleteSteward).not.toHaveBeenCalled();
    expect(deletePersonalAccount).not.toHaveBeenCalled();
  });

  test("retry failure is fenced to the same processing generation", async () => {
    requestRepo.claimDue.mockResolvedValue([
      {
        id: "request-1",
        user_id: "user-1",
        organization_id: "org-1",
        steward_user_id: "steward-1",
        processing_started_at: CLAIM_GENERATION,
      },
    ]);
    requestRepo.markActionRequired.mockRejectedValueOnce(new Error("write unavailable"));

    await processDueAccountDeletions(10, { blob, purgeOrganizationResources });

    expect(recordPurgeFailure).toHaveBeenCalledWith("request-1", CLAIM_GENERATION, "purge_failed");
  });

  for (const role of ["member", "owner"] as const) {
    test(`parks a shared-organization ${role} without deleting anything`, async () => {
      listByOrganization.mockResolvedValueOnce([
        { id: "user-1", role, is_active: false, is_anonymous: false },
        { id: "user-2", role: "owner", is_active: true, is_anonymous: false },
      ]);
      requestRepo.claimDue.mockResolvedValue([
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

      expect(result).toEqual({ recovered: 0, processed: 1, completed: 0, actionRequired: 1 });
      expect(requestRepo.markActionRequired).toHaveBeenCalledWith(
        "request-1",
        CLAIM_GENERATION,
        "LIFECYCLE_RESERVATION_REQUIRED",
      );
      expect(recordPurgeFailure).not.toHaveBeenCalled();
      expect(purgeOrganizationResources).not.toHaveBeenCalled();
      expect(deleteSteward).not.toHaveBeenCalled();
      expect(deletePersonalAccount).not.toHaveBeenCalled();
      expect(deleteSharedOrganizationUser).not.toHaveBeenCalled();
    });
  }
});
