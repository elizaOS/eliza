// Pins fail-closed identity-linking behavior in ElizaAppUserService. Real tenant-identity
// write failures propagate, combined Telegram/phone links use one atomic update, and only
// cosmetic Discord profile-refresh failures degrade to success. Deterministic fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const findByDiscordIdWithOrganization = mock();
const findByPhoneNumberWithOrganization = mock();
const update = mock();

mock.module("../../../db/repositories/users", () => ({
  usersRepository: {
    findByDiscordIdWithOrganization,
    findByPhoneNumberWithOrganization,
    findByTelegramIdWithOrganization: mock(),
    findByEmailWithOrganization: mock(),
    findByWhatsAppIdWithOrganization: mock(),
    findWithOrganization: mock(),
    update,
    create: mock(),
  },
}));

mock.module("../../../db/repositories/organizations", () => ({
  organizationsRepository: {
    findBySlug: mock(async () => undefined),
    create: mock(),
  },
}));

mock.module("../../utils/email-validation", () => ({
  isValidEmail: mock(() => true),
  maskEmailForLogging: mock((email: string) => email),
}));

mock.module("../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

mock.module("../../utils/phone-normalization", () => ({
  normalizePhoneNumber: mock((phone: string) => phone),
}));

mock.module("../api-keys", () => ({ apiKeysService: { create: mock() } }));
mock.module("../credits", () => ({
  creditsService: { addCredits: mock() },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
mock.module("../signup-code", () => ({ redeemSignupCode: mock() }));

const { elizaAppUserService } = await import(
  `./user-service.ts?test=user-service-error-policy-${Date.now()}`
);

function uniqueConstraintError(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
}

describe("ElizaAppUserService.findOrCreateByDiscordId error policy", () => {
  beforeEach(() => {
    findByDiscordIdWithOrganization.mockReset();
    findByPhoneNumberWithOrganization.mockReset();
    update.mockReset();
    // Phone is unowned by default so the phone-link branch is reachable.
    findByPhoneNumberWithOrganization.mockResolvedValue(undefined);
  });

  test("propagates a real DB failure while linking a phone (fail closed)", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-1",
      discord_id: "d1",
      discord_username: "olduser",
      phone_number: null,
      organization: { id: "org-1" },
    });
    update.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await expect(
      elizaAppUserService.findOrCreateByDiscordId("d1", { username: "newuser" }, "+15551234567"),
    ).rejects.toThrow("connection terminated unexpectedly");

    expect(update).toHaveBeenCalledTimes(1);
  });

  test("maps a unique-constraint collision on the phone link to PHONE_ALREADY_LINKED", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-1",
      discord_id: "d1",
      discord_username: "olduser",
      phone_number: null,
      organization: { id: "org-1" },
    });
    update.mockRejectedValue(uniqueConstraintError());

    await expect(
      elizaAppUserService.findOrCreateByDiscordId("d1", { username: "newuser" }, "+15551234567"),
    ).rejects.toThrow("PHONE_ALREADY_LINKED");
  });

  test("degrades a cosmetic-only profile-refresh failure to success (distinguishable)", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-2",
      discord_id: "d2",
      discord_username: "old-name",
      phone_number: "+15550000000",
      organization: { id: "org-2" },
    });
    update.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const result = await elizaAppUserService.findOrCreateByDiscordId("d2", {
      username: "new-name",
    });

    expect(result.isNew).toBe(false);
    expect(result.user.id).toBe("user-2");
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("ElizaAppUserService.linkTelegramAndPhoneToUser", () => {
  beforeEach(() => {
    update.mockReset();
  });

  test("writes the Telegram and phone identity pair in one update", async () => {
    update.mockResolvedValue({ id: "user-1" });

    const result = await elizaAppUserService.linkTelegramAndPhoneToUser(
      "user-1",
      {
        id: 123456789,
        first_name: "Sam",
        username: "sam",
        auth_date: 1_786_224_000,
        hash: "a".repeat(64),
      },
      "+14155550123",
    );

    expect(result).toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        telegram_id: "123456789",
        telegram_username: "sam",
        phone_number: "+14155550123",
        phone_verified: true,
      }),
    );
  });

  test("reports a uniqueness race without issuing a compensating write", async () => {
    update.mockRejectedValue(uniqueConstraintError());

    const result = await elizaAppUserService.linkTelegramAndPhoneToUser(
      "user-1",
      {
        id: 123456789,
        first_name: "Sam",
        auth_date: 1_786_224_000,
        hash: "a".repeat(64),
      },
      "+14155550123",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("already linked");
    expect(update).toHaveBeenCalledTimes(1);
  });
});
