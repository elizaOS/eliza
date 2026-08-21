/** Verifies Steward SMS login claims only the exact provisional phone account. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const provisionalUser = {
  id: "phone-user-1",
  steward_user_id: "steward-user-1",
  phone_number: "+14155552671",
  phone_verified: true,
  organization_id: "phone-org-1",
  role: "owner",
  is_active: true,
};
const provisionalOrganization = {
  id: "phone-org-1",
  name: "User ***2671's Workspace",
  credit_balance: "0.00",
};

const promotePhonePersonalAccountToSteward = mock(async () => ({
  status: "promoted" as const,
  user: provisionalUser,
  organization: provisionalOrganization,
}));
const findPendingPhoneTelegramPersonalAccountConvergence = mock(async () => ({
  status: "not_found" as const,
}));
const provisionDefaultApiKey = mock(async () => undefined);
const characterExists = mock(async () => true);
const ensureStewardTenant = mock(async () => undefined);

mock.module("../db/repositories/users", () => ({
  usersRepository: {
    findPendingPhoneTelegramPersonalAccountConvergence,
    promotePhonePersonalAccountToSteward,
  },
}));

mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: mock(async () => undefined),
  },
}));

mock.module("./services/api-keys", () => ({
  apiKeysService: { provisionDefaultApiKey },
}));

mock.module("./services/characters/characters", () => ({
  charactersService: {
    hasHealthyCloudCharacterMirror: characterExists,
    create: mock(async () => undefined),
  },
}));

mock.module("./services/steward-tenant-config", () => ({
  ensureStewardTenant,
}));

mock.module("./utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { StewardPhoneAccountConflictError, syncUserFromSteward } = await import("./steward-sync");

beforeEach(() => {
  findPendingPhoneTelegramPersonalAccountConvergence.mockReset();
  findPendingPhoneTelegramPersonalAccountConvergence.mockResolvedValue({ status: "not_found" });
  promotePhonePersonalAccountToSteward.mockReset();
  promotePhonePersonalAccountToSteward.mockResolvedValue({
    status: "promoted",
    user: provisionalUser,
    organization: provisionalOrganization,
  });
  provisionDefaultApiKey.mockClear();
  characterExists.mockClear();
  ensureStewardTenant.mockClear();
});

describe("syncUserFromSteward phone convergence", () => {
  test("returns the original provisional account after atomic promotion", async () => {
    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      verifiedPhone: "+1 (415) 555-2671",
    });

    expect(promotePhonePersonalAccountToSteward).toHaveBeenCalledWith({
      phoneNumber: "+14155552671",
      stewardUserId: "steward-user-1",
    });
    expect(result).toMatchObject({
      id: "phone-user-1",
      organization_id: "phone-org-1",
      organization: { id: "phone-org-1", credit_balance: "0.00" },
    });
    expect(provisionDefaultApiKey).toHaveBeenCalledWith("phone-user-1", "phone-org-1");
    expect(ensureStewardTenant).toHaveBeenCalledWith("phone-org-1");
  });

  test("fails closed when the phone belongs to a mature different account", async () => {
    promotePhonePersonalAccountToSteward.mockResolvedValue({
      status: "phone_owned_by_mature_account",
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        verifiedPhone: "+14155552671",
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardPhoneAccountConflictError>>>({
      reason: "phone_owned_by_mature_account",
    });
    expect(provisionDefaultApiKey).not.toHaveBeenCalled();
  });

  test("fails closed on a corrupt identity projection instead of creating a second org", async () => {
    promotePhonePersonalAccountToSteward.mockResolvedValue({
      status: "identity_projection_conflict",
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        verifiedPhone: "+14155552671",
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardPhoneAccountConflictError>>>({
      reason: "identity_projection_conflict",
    });
  });
});
