/**
 * Verifies Steward login adopts the exact Telegram DM account before generic
 * sync can create or provision a second account.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

const telegramUser = {
  id: "telegram-user-1",
  steward_user_id: "steward-user-1",
  telegram_id: "123456789",
  organization_id: "telegram-org-1",
  name: "Nubs",
  email: undefined,
  wallet_address: undefined,
  email_verified: false,
  wallet_verified: false,
  role: "owner",
  is_active: true,
};
const telegramOrganization = {
  id: "telegram-org-1",
  name: "Nubs's Workspace",
  credit_balance: "0.000000",
};

const inspectTelegramPersonalAccountContinuation = mock(async () => ({
  telegramId: "123456789",
  userId: "telegram-user-1",
  organizationId: "telegram-org-1",
}));
type TelegramPromotion =
  | {
      status: "promoted" | "already_promoted";
      user: typeof telegramUser;
      organization: typeof telegramOrganization;
    }
  | { status: "steward_subject_owned_by_other_user" };
const promoteTelegramPersonalAccountToSteward = mock(
  async (): Promise<TelegramPromotion> => ({
    status: "promoted",
    user: telegramUser,
    organization: telegramOrganization,
  }),
);
const getByStewardId = mock(async () => undefined);
const getByStewardIdForWrite = mock(async () => undefined);
const upsertStewardIdentity = mock(async () => undefined);
const createUser = mock(async () => undefined);
const createOrganization = mock(async () => undefined);
const provisionDefaultApiKey = mock(async () => undefined);
const createCharacter = mock(async () => undefined);
const ensureStewardTenant = mock(async () => undefined);

mock.module("./services/eliza-app/onboarding-chat", () => ({
  inspectTelegramPersonalAccountContinuation,
}));

mock.module("../db/repositories/users", () => ({
  usersRepository: {
    promoteTelegramPersonalAccountToSteward,
  },
}));

mock.module("./services/users", () => ({
  usersService: {
    getByStewardId,
    getByStewardIdForWrite,
    upsertStewardIdentity,
    create: createUser,
  },
}));

mock.module("./services/organizations", () => ({
  organizationsService: { create: createOrganization },
}));

mock.module("./services/api-keys", () => ({
  apiKeysService: { provisionDefaultApiKey },
}));

mock.module("./services/characters/characters", () => ({
  charactersService: {
    existsForOrganization: mock(async () => false),
    create: createCharacter,
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

const { StewardTelegramAccountClaimError, syncUserFromSteward } = await import("./steward-sync");

beforeEach(() => {
  inspectTelegramPersonalAccountContinuation.mockReset();
  inspectTelegramPersonalAccountContinuation.mockResolvedValue({
    telegramId: "123456789",
    userId: "telegram-user-1",
    organizationId: "telegram-org-1",
  });
  promoteTelegramPersonalAccountToSteward.mockReset();
  promoteTelegramPersonalAccountToSteward.mockResolvedValue({
    status: "promoted",
    user: telegramUser,
    organization: telegramOrganization,
  });
  getByStewardId.mockClear();
  getByStewardIdForWrite.mockClear();
  upsertStewardIdentity.mockClear();
  createUser.mockClear();
  createOrganization.mockClear();
  provisionDefaultApiKey.mockClear();
  createCharacter.mockClear();
  ensureStewardTenant.mockClear();
});

describe("syncUserFromSteward Telegram account convergence", () => {
  test("returns the original account and performs no provisioning", async () => {
    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      telegramContinuation: "opaque-telegram-claim-token",
    });

    expect(inspectTelegramPersonalAccountContinuation).toHaveBeenCalledWith(
      "opaque-telegram-claim-token",
    );
    expect(promoteTelegramPersonalAccountToSteward).toHaveBeenCalledWith({
      telegramId: "123456789",
      stewardUserId: "steward-user-1",
      expectedUserId: "telegram-user-1",
      expectedOrganizationId: "telegram-org-1",
    });
    expect(result).toMatchObject({
      id: "telegram-user-1",
      organization_id: "telegram-org-1",
      organization: { id: "telegram-org-1", credit_balance: "0.000000" },
    });
    expect(getByStewardId).not.toHaveBeenCalled();
    expect(upsertStewardIdentity).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
    expect(provisionDefaultApiKey).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(ensureStewardTenant).not.toHaveBeenCalled();
  });

  test("accepts an idempotent already-promoted retry without creating anything", async () => {
    promoteTelegramPersonalAccountToSteward.mockResolvedValue({
      status: "already_promoted",
      user: telegramUser,
      organization: telegramOrganization,
    });

    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      telegramContinuation: "opaque-telegram-claim-token",
    });

    expect(result.id).toBe("telegram-user-1");
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  test("fails closed on expired authority before account lookup or creation", async () => {
    inspectTelegramPersonalAccountContinuation.mockRejectedValue(
      new ElizaError("expired continuation", {
        code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
      }),
    );

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        telegramContinuation: "expired-telegram-claim-token",
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardTelegramAccountClaimError>>>({
      reason: "invalid_continuation",
    });
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(getByStewardId).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  test("surfaces continuation-store outages instead of fabricating a conflict", async () => {
    const outage = new Error("continuation coordinator unavailable");
    inspectTelegramPersonalAccountContinuation.mockRejectedValue(outage);

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        telegramContinuation: "opaque-telegram-claim-token",
      }),
    ).rejects.toBe(outage);
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(getByStewardId).not.toHaveBeenCalled();
  });

  test("fails closed on ownership conflict before generic sync", async () => {
    promoteTelegramPersonalAccountToSteward.mockResolvedValue({
      status: "steward_subject_owned_by_other_user",
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        telegramContinuation: "opaque-telegram-claim-token",
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardTelegramAccountClaimError>>>({
      reason: "steward_subject_owned_by_other_user",
    });
    expect(getByStewardId).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
    expect(provisionDefaultApiKey).not.toHaveBeenCalled();
  });
});
