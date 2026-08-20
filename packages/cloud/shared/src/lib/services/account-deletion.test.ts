import { beforeEach, describe, expect, mock, test } from "bun:test";

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
    requested_at: new Date("2026-08-19T00:00:00Z"),
    execute_after: new Date("2026-09-18T00:00:00Z"),
    identity_deactivated_at: null,
    completed_at: null,
    ...data,
  })),
  findOpenByUserId: mock(async () => undefined),
  claimDue: mock(async () => []),
  recoverStaleProcessing: mock(async () => 0),
  recordPurgeFailure: mock(async () => undefined),
};
const listByOrganization = mock(async () => [
  { id: "user-1", role: "owner", is_active: true, is_anonymous: false },
]);
const findByIdForWrite = mock(async () => ({ id: "user-1" }));
const deactivateSteward = mock(async () => ({ userId: "steward-1" }));
const deleteSteward = mock(async () => ({ userId: "steward-1" }));
const updateUser = mock(async () => undefined);
const deletePersonalAccount = mock(async () => undefined);
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
  usersRepository: { listByOrganization, findByIdForWrite },
}));
mock.module("./steward-platform-users", () => ({
  deactivateStewardPlatformUser: deactivateSteward,
  deleteStewardPlatformUser: deleteSteward,
}));
mock.module("./user-sessions", () => ({
  userSessionsService: { endAllUserSessions: mock(async () => undefined) },
}));
mock.module("./users", () => ({
  usersService: { update: updateUser, deletePersonalAccount },
}));
mock.module("./organizations", () => ({
  organizationsService: { update: updateOrg },
}));
mock.module("../utils/logger", () => ({
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const { processDueAccountDeletions, requestAccountDeletion } = await import("./account-deletion");

beforeEach(() => {
  requestRepo.update.mockClear();
  deactivateSteward.mockClear();
  deleteSteward.mockClear();
  updateUser.mockClear();
  deletePersonalAccount.mockClear();
  updateOrg.mockClear();
  purgeOrganizationResources.mockClear();
  recordPurgeFailure.mockClear();
  recordPurgeFailure.mockResolvedValue(undefined);
  requestRepo.claimDue.mockResolvedValue([]);
});

describe("account deletion lifecycle", () => {
  test("immediately deactivates identity, Cloud access, and the sole-user organization", async () => {
    const result = await requestAccountDeletion({
      userId: "user-1",
      organizationId: "org-1",
      stewardUserId: "steward-1",
      now: new Date("2026-08-19T00:00:00Z"),
    });
    expect(result.status).toBe("scheduled");
    expect(deactivateSteward).toHaveBeenCalledWith("steward-1");
    expect(updateUser).toHaveBeenCalledWith("user-1", {
      is_active: false,
      deleted_at: new Date("2026-08-19T00:00:00Z"),
    });
    expect(updateOrg).toHaveBeenCalledWith("org-1", { is_active: false });
  });

  test("purges a due Steward identity and Cloud user, then completes its durable receipt", async () => {
    requestRepo.claimDue.mockResolvedValue([
      {
        id: "request-1",
        user_id: "user-1",
        organization_id: "org-1",
        steward_user_id: "steward-1",
      },
    ]);
    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
    });
    expect(result).toEqual({ recovered: 0, processed: 1, completed: 1, actionRequired: 0 });
    expect(purgeOrganizationResources).toHaveBeenCalledWith({
      organizationId: "org-1",
      blob,
    });
    expect(deleteSteward).toHaveBeenCalledWith("steward-1");
    expect(deletePersonalAccount).toHaveBeenCalledWith("user-1", "org-1");
    expect(requestRepo.update).toHaveBeenLastCalledWith(
      "request-1",
      expect.objectContaining({
        status: "completed",
        user_id: null,
        organization_id: null,
        steward_user_id: null,
      }),
    );
  });

  test("fails closed before identity and database deletion when resource purge fails", async () => {
    requestRepo.claimDue.mockResolvedValue([
      {
        id: "request-1",
        user_id: "user-1",
        organization_id: "org-1",
        steward_user_id: "steward-1",
      },
    ]);
    purgeOrganizationResources.mockRejectedValueOnce(new Error("provider unavailable"));
    recordPurgeFailure.mockResolvedValueOnce({ status: "action_required" });

    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
    });

    expect(result).toEqual({ recovered: 0, processed: 1, completed: 0, actionRequired: 1 });
    expect(deleteSteward).not.toHaveBeenCalled();
    expect(deletePersonalAccount).not.toHaveBeenCalled();
    expect(recordPurgeFailure).toHaveBeenCalledWith("request-1", "purge_failed");
  });
});
