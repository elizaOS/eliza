/**
 * Verifies Steward login adopts the exact Telegram DM account before generic
 * sync can create or provision a second account.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { personalSharedAgentId } from "./services/shared-runtime/personal-shared-agent";

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
const phoneUser = {
  ...telegramUser,
  id: "phone-user-1",
  steward_user_id: "+phone-provisional",
  telegram_id: null,
  phone_number: "+14155552671",
  organization_id: "phone-org-1",
};
const phoneOrganization = {
  ...telegramOrganization,
  id: "phone-org-1",
  name: "Phone Workspace",
};
const convergedTelegramUser = {
  ...telegramUser,
  phone_number: "+14155552671",
  phone_verified: true,
  organization: telegramOrganization,
};
const sourceAgentId = personalSharedAgentId({
  userId: phoneUser.id,
  organizationId: phoneOrganization.id,
});
const targetAgentId = personalSharedAgentId({
  userId: telegramUser.id,
  organizationId: telegramOrganization.id,
});
const convergenceReceipt = {
  token: `phone-telegram:${phoneUser.id}:${telegramUser.id}`,
  source_user_id: phoneUser.id,
  source_organization_id: phoneOrganization.id,
  source_agent_id: sourceAgentId,
  target_user_id: telegramUser.id,
  target_organization_id: telegramOrganization.id,
  target_agent_id: targetAgentId,
  phone_number: phoneUser.phone_number,
  telegram_id: telegramUser.telegram_id,
  steward_user_id: telegramUser.steward_user_id,
  status: "pending_alias" as const,
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
const convergenceEvents: string[] = [];
const inspectPhoneTelegramPersonalAccountConvergence = mock(async () => ({
  status: "not_dual_account" as const,
}));
const findPendingPhoneTelegramPersonalAccountConvergence = mock(async () => ({
  status: "not_found" as const,
}));
const commitPhoneTelegramPersonalAccountConvergence = mock(async () => ({
  status: "committed" as const,
  receipt: convergenceReceipt,
  user: convergedTelegramUser,
  organization: telegramOrganization,
}));
const markPhoneTelegramPersonalAccountAliasComplete = mock(async () => ({
  ...convergenceReceipt,
  status: "complete" as const,
}));
const linkVerifiedPhone = mock(async () => convergedTelegramUser);
const preparePersonalProvisionalHistoryConvergence = mock(async () => {
  convergenceEvents.push("seal");
  return { alreadyAliased: false as const, history: [] };
});
const commitPersonalProvisionalHistoryConvergence = mock(async () => {
  convergenceEvents.push("history");
});
const releasePersonalProvisionalHistoryConvergence = mock(async () => {
  convergenceEvents.push("release");
});
const getByStewardId = mock(async () => undefined);
const findByTelegramIdWithOrganizationForWrite = mock(async () => undefined);
const getByStewardIdForWrite = mock(
  async (): Promise<typeof convergedTelegramUser | undefined> => undefined,
);
const linkTelegramIdentity = mock(async () => telegramUser);
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
    commitPhoneTelegramPersonalAccountConvergence,
    findByTelegramIdWithOrganizationForWrite,
    findPendingPhoneTelegramPersonalAccountConvergence,
    inspectPhoneTelegramPersonalAccountConvergence,
    linkTelegramIdentity,
    linkVerifiedPhone,
    markPhoneTelegramPersonalAccountAliasComplete,
    promoteTelegramPersonalAccountToSteward,
  },
}));

mock.module("./services/shared-runtime/conversation-coordinator", () => ({
  commitPersonalProvisionalHistoryConvergence,
  preparePersonalProvisionalHistoryConvergence,
  releasePersonalProvisionalHistoryConvergence,
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
    hasHealthyCloudCharacterMirror: mock(async () => false),
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

const { StewardPhoneAccountConflictError, StewardTelegramAccountClaimError, syncUserFromSteward } =
  await import("./steward-sync");

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
  convergenceEvents.length = 0;
  inspectPhoneTelegramPersonalAccountConvergence.mockReset();
  inspectPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
    status: "not_dual_account",
  });
  findPendingPhoneTelegramPersonalAccountConvergence.mockReset();
  findPendingPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
    status: "not_found",
  });
  commitPhoneTelegramPersonalAccountConvergence.mockClear();
  markPhoneTelegramPersonalAccountAliasComplete.mockClear();
  linkVerifiedPhone.mockClear();
  preparePersonalProvisionalHistoryConvergence.mockClear();
  commitPersonalProvisionalHistoryConvergence.mockClear();
  releasePersonalProvisionalHistoryConvergence.mockClear();
  getByStewardId.mockReset();
  getByStewardId.mockResolvedValue(undefined);
  findByTelegramIdWithOrganizationForWrite.mockReset();
  findByTelegramIdWithOrganizationForWrite.mockResolvedValue(undefined);
  getByStewardIdForWrite.mockClear();
  linkTelegramIdentity.mockReset();
  linkTelegramIdentity.mockResolvedValue(telegramUser);
  upsertStewardIdentity.mockClear();
  createUser.mockClear();
  createOrganization.mockClear();
  provisionDefaultApiKey.mockClear();
  createCharacter.mockClear();
  ensureStewardTenant.mockClear();
});

describe("syncUserFromSteward Telegram account convergence", () => {
  test("promotes a message-first account from the signed Telegram id without a continuation", async () => {
    const provisionalTelegramUser = {
      ...telegramUser,
      steward_user_id: "telegram:123456789",
      organization: telegramOrganization,
    };
    findByTelegramIdWithOrganizationForWrite.mockResolvedValue(provisionalTelegramUser);
    getByStewardId.mockResolvedValue(telegramUser);
    getByStewardIdForWrite
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(convergedTelegramUser);

    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      verifiedTelegramId: "123456789",
    });

    expect(promoteTelegramPersonalAccountToSteward).toHaveBeenCalledWith({
      telegramId: "123456789",
      stewardUserId: "steward-user-1",
      expectedUserId: "telegram-user-1",
      expectedOrganizationId: "telegram-org-1",
    });
    expect(linkTelegramIdentity).toHaveBeenCalledWith("telegram-user-1", {
      telegram_id: "123456789",
    });
    expect(result.telegram_id).toBe("123456789");
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  test("binds website-first Telegram login so a later bot message reuses the account", async () => {
    getByStewardIdForWrite.mockResolvedValue(convergedTelegramUser);
    getByStewardId.mockResolvedValue(telegramUser);

    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      verifiedTelegramId: "123456789",
    });

    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(linkTelegramIdentity).toHaveBeenCalledWith("telegram-user-1", {
      telegram_id: "123456789",
    });
    expect(result.telegram_id).toBe("123456789");
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  test("fails closed when the signed Telegram id belongs to another Steward account", async () => {
    findByTelegramIdWithOrganizationForWrite.mockResolvedValue({
      ...telegramUser,
      steward_user_id: "steward-user-other",
      organization: telegramOrganization,
    });
    getByStewardIdForWrite.mockResolvedValue({
      ...convergedTelegramUser,
      id: "steward-user-row",
      telegram_id: null,
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        verifiedTelegramId: "123456789",
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardTelegramAccountClaimError>>>({
      reason: "telegram_owned_by_other_cloud_account",
    });
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(linkTelegramIdentity).not.toHaveBeenCalled();
    expect(getByStewardId).not.toHaveBeenCalled();
  });

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

  test("converges separately proved phone and Telegram accounts before ordinary promotion", async () => {
    inspectPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "eligible",
      plan: {
        sourceUser: phoneUser,
        sourceOrganization: phoneOrganization,
        targetUser: telegramUser,
        targetOrganization: telegramOrganization,
      },
    });
    commitPhoneTelegramPersonalAccountConvergence.mockImplementation(async () => {
      convergenceEvents.push("database");
      return {
        status: "committed",
        receipt: convergenceReceipt,
        user: convergedTelegramUser,
        organization: telegramOrganization,
      };
    });
    markPhoneTelegramPersonalAccountAliasComplete.mockImplementation(async () => {
      convergenceEvents.push("receipt");
      return {
        ...convergenceReceipt,
        status: "complete",
      };
    });
    getByStewardIdForWrite.mockResolvedValue(convergedTelegramUser);

    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      verifiedPhone: "+1 (415) 555-2671",
      telegramContinuation: "opaque-telegram-claim-token",
      sharedRuntimeConversationNamespace: {} as never,
    });

    expect(result).toMatchObject({
      id: "telegram-user-1",
      organization_id: "telegram-org-1",
      telegram_id: "123456789",
      phone_number: "+14155552671",
    });
    expect(convergenceEvents).toEqual(["seal", "database", "history", "receipt"]);
    expect(preparePersonalProvisionalHistoryConvergence).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: "telegram-user-1",
        targetOrganizationId: "telegram-org-1",
      }),
      expect.anything(),
    );
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(releasePersonalProvisionalHistoryConvergence).not.toHaveBeenCalled();
    expect(linkVerifiedPhone).toHaveBeenCalledWith("telegram-user-1", "+14155552671");
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  test("resumes a database-committed convergence through import and alias without re-merging", async () => {
    inspectPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "resume_alias",
      receipt: convergenceReceipt,
      user: convergedTelegramUser,
      organization: telegramOrganization,
    });
    markPhoneTelegramPersonalAccountAliasComplete.mockImplementation(async () => {
      convergenceEvents.push("receipt");
      return {
        token: "phone-telegram:phone-user-1:telegram-user-1",
        status: "complete",
      };
    });
    getByStewardIdForWrite.mockResolvedValue(convergedTelegramUser);

    const result = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      verifiedPhone: "+14155552671",
      telegramContinuation: "opaque-telegram-claim-token",
      sharedRuntimeConversationNamespace: {} as never,
    });

    expect(result.id).toBe("telegram-user-1");
    expect(convergenceEvents).toEqual(["seal", "history", "receipt"]);
    expect(preparePersonalProvisionalHistoryConvergence).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: "telegram-user-1",
        targetOrganizationId: "telegram-org-1",
      }),
      expect.anything(),
    );
    expect(commitPhoneTelegramPersonalAccountConvergence).not.toHaveBeenCalled();
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  test("repairs a committed history alias on ordinary Steward login without the continuation or phone claim", async () => {
    inspectPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "eligible",
      plan: {
        sourceUser: phoneUser,
        sourceOrganization: phoneOrganization,
        targetUser: telegramUser,
        targetOrganization: telegramOrganization,
      },
    });
    commitPhoneTelegramPersonalAccountConvergence.mockImplementation(async () => {
      convergenceEvents.push("database");
      return {
        status: "committed",
        receipt: convergenceReceipt,
        user: convergedTelegramUser,
        organization: telegramOrganization,
      };
    });
    markPhoneTelegramPersonalAccountAliasComplete.mockImplementation(async () => {
      convergenceEvents.push("receipt");
      return { ...convergenceReceipt, status: "complete" };
    });
    const importOutage = new Error("target history import unavailable");
    commitPersonalProvisionalHistoryConvergence.mockImplementationOnce(async () => {
      convergenceEvents.push("history");
      throw importOutage;
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        name: "Nubs",
        verifiedPhone: "+14155552671",
        telegramContinuation: "opaque-telegram-claim-token",
        sharedRuntimeConversationNamespace: {} as never,
      }),
    ).rejects.toBe(importOutage);
    expect(markPhoneTelegramPersonalAccountAliasComplete).not.toHaveBeenCalled();

    findPendingPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "resume_alias",
      receipt: convergenceReceipt,
      user: convergedTelegramUser,
      organization: telegramOrganization,
    });

    const recovered = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      sharedRuntimeConversationNamespace: {} as never,
    });

    expect(recovered).toMatchObject({
      id: telegramUser.id,
      organization_id: telegramOrganization.id,
      telegram_id: telegramUser.telegram_id,
      phone_number: phoneUser.phone_number,
    });
    expect(findPendingPhoneTelegramPersonalAccountConvergence).toHaveBeenCalledWith({
      stewardUserId: telegramUser.steward_user_id,
    });
    expect(inspectTelegramPersonalAccountContinuation).toHaveBeenCalledTimes(1);
    expect(commitPhoneTelegramPersonalAccountConvergence).toHaveBeenCalledTimes(1);
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(markPhoneTelegramPersonalAccountAliasComplete).toHaveBeenCalledTimes(1);
    expect(convergenceEvents).toEqual([
      "seal",
      "database",
      "history",
      "seal",
      "history",
      "receipt",
    ]);
  });

  test("keeps a pending receipt blocked when the history namespace is unavailable", async () => {
    findPendingPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "resume_alias",
      receipt: convergenceReceipt,
      user: convergedTelegramUser,
      organization: telegramOrganization,
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardPhoneAccountConflictError>>>({
      reason: "history_coordinator_unavailable",
    });
    expect(markPhoneTelegramPersonalAccountAliasComplete).not.toHaveBeenCalled();
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
  });

  test("repairs a pending alias before validating a retained expired continuation", async () => {
    findPendingPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "resume_alias",
      receipt: convergenceReceipt,
      user: convergedTelegramUser,
      organization: telegramOrganization,
    });
    inspectTelegramPersonalAccountContinuation.mockRejectedValue(
      new ElizaError("expired continuation", {
        code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
      }),
    );

    const recovered = await syncUserFromSteward({
      stewardUserId: "steward-user-1",
      name: "Nubs",
      telegramContinuation: "expired-telegram-claim-token",
      sharedRuntimeConversationNamespace: {} as never,
    });

    expect(recovered).toMatchObject({
      id: telegramUser.id,
      organization_id: telegramOrganization.id,
      phone_number: phoneUser.phone_number,
    });
    expect(inspectTelegramPersonalAccountContinuation).not.toHaveBeenCalled();
    expect(promoteTelegramPersonalAccountToSteward).not.toHaveBeenCalled();
    expect(markPhoneTelegramPersonalAccountAliasComplete).toHaveBeenCalledTimes(1);
  });

  test("fails closed when an ordinary retry asserts a different verified phone", async () => {
    findPendingPhoneTelegramPersonalAccountConvergence.mockResolvedValue({
      status: "identity_projection_conflict",
    });

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-user-1",
        verifiedPhone: "+14155559999",
        sharedRuntimeConversationNamespace: {} as never,
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardTelegramAccountClaimError>>>({
      reason: "identity_projection_conflict",
    });
    expect(findPendingPhoneTelegramPersonalAccountConvergence).toHaveBeenCalledWith({
      stewardUserId: "steward-user-1",
      phoneNumber: "+14155559999",
    });
    expect(preparePersonalProvisionalHistoryConvergence).not.toHaveBeenCalled();
    expect(markPhoneTelegramPersonalAccountAliasComplete).not.toHaveBeenCalled();
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
