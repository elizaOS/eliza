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
const deleteUser = mock(async () => undefined);
const updateOrg = mock(async () => undefined);

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
mock.module("./users", () => ({ usersService: { update: updateUser, delete: deleteUser } }));
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
  deleteUser.mockClear();
  updateOrg.mockClear();
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
    const result = await processDueAccountDeletions();
    expect(result).toEqual({ recovered: 0, processed: 1, completed: 1, actionRequired: 0 });
    expect(deleteSteward).toHaveBeenCalledWith("steward-1");
    expect(deleteUser).toHaveBeenCalledWith("user-1");
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
});
