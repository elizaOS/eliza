/**
 * Regression coverage for the signed Telegram auth + bot-continuation boundary.
 * The route runs for real; identity, session, and onboarding collaborators are
 * replaced so assertions can prove mutation ordering without a database.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  handleTelegramAuth,
  type TelegramAuthDependencies,
} from "../eliza-app/auth/telegram/route";

const verifyAuth = mock((_data: unknown) => true);
const validateAuthHeader = mock(
  async (): Promise<{ userId: string; organizationId: string } | null> => ({
    userId: "user-1",
    organizationId: "org-1",
  }),
);
const createSession = mock(async () => ({
  token: "new-session-token",
  expiresAt: new Date("2026-08-09T00:00:00.000Z"),
}));
const linkTelegramToUser = mock(async () => ({ success: true }));
const linkPhoneToUser = mock(
  async (): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  }),
);
const USER = {
  id: "user-1",
  organization_id: "org-1",
  telegram_id: "123456789",
  telegram_username: "sam",
  phone_number: "+14155550123" as string | null,
  name: "Sam",
  discord_id: null,
  whatsapp_id: null,
  organization: { id: "org-1", name: "Org 1" },
};
const getById = mock(async () => ({ ...USER }));
const getByTelegramId = mock(
  async (): Promise<Awaited<ReturnType<typeof getById>> | undefined> =>
    undefined,
);
const getByPhoneNumber = mock(
  async (): Promise<Awaited<ReturnType<typeof getById>> | undefined> =>
    undefined,
);
const findOrCreateByTelegramWithPhone = mock(
  async (): Promise<{
    user: Awaited<ReturnType<typeof getById>>;
    organization: { id: string; name: string };
    isNew: boolean;
  }> => {
    throw new Error("unexpected standard auth flow");
  },
);
const claimTelegramOnboardingContinuation = mock(
  async (
    _input: unknown,
  ): Promise<{
    status: "acquired" | "completed";
    sessionId: string;
    userId?: string;
    organizationId?: string;
  }> => ({
    status: "acquired",
    sessionId: "platform:telegram:123456789",
  }),
);
const completeTelegramOnboardingContinuationClaim = mock(async () => undefined);
const runOnboardingChat = mock(async () => ({
  session: {
    id: "platform:telegram:123456789",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    platform: "telegram",
    platformUserId: "123456789",
    platformIdentityTrusted: true,
    userId: "user-1",
    organizationId: "org-1",
    history: [],
  },
  reply: "connected",
  requiresLogin: false,
  loginUrl: "https://eliza.app/get-started",
  controlPanelUrl: "https://app.elizacloud.ai/dashboard/agents",
  launchUrl: null,
  provisioning: {
    status: "pending",
    agentId: null,
    bridgeUrl: null,
    sandbox: null,
  },
  handoffComplete: false,
}));

const dependencies = {
  verifyAuth,
  validateAuthHeader,
  createSession,
  linkTelegramToUser,
  linkPhoneToUser,
  getById,
  getByTelegramId,
  getByPhoneNumber,
  findOrCreateByTelegramWithPhone,
  claimContinuation: claimTelegramOnboardingContinuation,
  completeContinuationClaim: completeTelegramOnboardingContinuationClaim,
  redeemContinuation: runOnboardingChat,
} as unknown as TelegramAuthDependencies;

const AUTH_BODY = {
  phone_number: "+14155550123",
  id: 123456789,
  first_name: "Sam",
  username: "sam",
  auth_date: 1_786_224_000,
  hash: "a".repeat(64),
};

async function post(
  body: Record<string, unknown>,
  authorization = "Bearer existing-session-token",
): Promise<Response> {
  return handleTelegramAuth(
    new Request("https://eliza.test/api/eliza-app/auth/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization && { authorization }),
      },
      body: JSON.stringify(body),
    }),
    dependencies,
  );
}

describe("Telegram auth bot continuation", () => {
  beforeEach(() => {
    verifyAuth.mockClear();
    validateAuthHeader.mockReset();
    createSession.mockClear();
    linkTelegramToUser.mockReset();
    linkPhoneToUser.mockReset();
    getById.mockReset();
    getByTelegramId.mockReset();
    getByPhoneNumber.mockReset();
    findOrCreateByTelegramWithPhone.mockReset();
    validateAuthHeader.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
    });
    getByTelegramId.mockResolvedValue(undefined);
    getByPhoneNumber.mockResolvedValue(undefined);
    getById.mockImplementation(async () => ({ ...USER }));
    linkTelegramToUser.mockImplementation(async () => ({ success: true }));
    linkPhoneToUser.mockImplementation(async () => ({ success: true }));
    findOrCreateByTelegramWithPhone.mockImplementation(async () => {
      throw new Error("unexpected standard auth flow");
    });
    claimTelegramOnboardingContinuation.mockReset();
    completeTelegramOnboardingContinuationClaim.mockClear();
    runOnboardingChat.mockClear();
    claimTelegramOnboardingContinuation.mockResolvedValue({
      status: "acquired",
      sessionId: "platform:telegram:123456789",
    });
  });

  test("rejects an invalid continuation before linking Telegram or phone", async () => {
    claimTelegramOnboardingContinuation.mockRejectedValueOnce(
      new Error("Invalid trusted Telegram onboarding continuation"),
    );

    const response = await post({
      ...AUTH_BODY,
      onboarding_session: "invalid-opaque-continuation",
    });

    expect(response.status).toBe(403);
    expect(claimTelegramOnboardingContinuation).toHaveBeenCalledWith({
      continuationToken: "invalid-opaque-continuation",
      claimId: expect.any(String),
      telegramId: "123456789",
      phoneNumber: AUTH_BODY.phone_number,
      authenticatedAccount: {
        userId: "user-1",
        organizationId: "org-1",
      },
    });
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(linkPhoneToUser).not.toHaveBeenCalled();
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });

  test("rejects a malformed successful claim response before identity mutation", async () => {
    claimTelegramOnboardingContinuation.mockResolvedValueOnce({
      status: "unexpected",
      sessionId: "platform:telegram:123456789",
    } as never);

    const response = await post({
      ...AUTH_BODY,
      onboarding_session: "malformed-claim-continuation",
    });

    expect(response.status).toBe(403);
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(linkPhoneToUser).not.toHaveBeenCalled();
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });

  test("redeems a validated continuation server-side with stable idempotency", async () => {
    const response = await post({
      ...AUTH_BODY,
      onboarding_session: "valid-opaque-continuation",
    });
    const body = (await response.json()) as {
      success: boolean;
      continuation_redeemed?: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.continuation_redeemed).toBe(true);
    expect(verifyAuth.mock.calls[0]?.[0]).not.toHaveProperty(
      "onboarding_session",
    );
    expect(linkTelegramToUser).toHaveBeenCalledTimes(1);
    expect(runOnboardingChat).toHaveBeenCalledWith({
      sessionId: "valid-opaque-continuation",
      platform: "telegram",
      continuationMode: "trusted-telegram",
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
        telegramId: "123456789",
      },
      trustedPlatformIdentity: false,
      idempotencyKey:
        "telegram-auth-continuation:123456789:valid-opaque-continuation",
    });
  });

  test("resolves the prospective Telegram account before validating an anonymous retry", async () => {
    validateAuthHeader.mockResolvedValueOnce(null);
    const existingUser = await getById();
    getByTelegramId.mockResolvedValueOnce(existingUser);
    findOrCreateByTelegramWithPhone.mockResolvedValueOnce({
      user: existingUser,
      organization: existingUser.organization,
      isNew: false,
    });

    const response = await post(
      { ...AUTH_BODY, onboarding_session: "bound-retry-continuation" },
      "",
    );

    expect(response.status).toBe(200);
    expect(claimTelegramOnboardingContinuation).toHaveBeenCalledWith({
      continuationToken: "bound-retry-continuation",
      claimId: expect.any(String),
      telegramId: "123456789",
      phoneNumber: AUTH_BODY.phone_number,
      authenticatedAccount: { userId: "user-1", organizationId: "org-1" },
    });
  });

  test("a completed replay does not mutate Telegram or phone identity again", async () => {
    claimTelegramOnboardingContinuation.mockResolvedValueOnce({
      status: "completed",
      sessionId: "platform:telegram:123456789",
      userId: "user-1",
      organizationId: "org-1",
    });

    const response = await post({
      ...AUTH_BODY,
      onboarding_session: "completed-continuation",
    });

    expect(response.status).toBe(200);
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(linkPhoneToUser).not.toHaveBeenCalled();
    expect(findOrCreateByTelegramWithPhone).not.toHaveBeenCalled();
    expect(runOnboardingChat).not.toHaveBeenCalled();
    expect(completeTelegramOnboardingContinuationClaim).not.toHaveBeenCalled();
  });

  test("an invalid anonymous continuation cannot create or link an account", async () => {
    validateAuthHeader.mockResolvedValueOnce(null);
    claimTelegramOnboardingContinuation.mockRejectedValueOnce(
      new Error("Invalid trusted Telegram onboarding continuation"),
    );

    const response = await post(
      { ...AUTH_BODY, onboarding_session: "invalid-anonymous-continuation" },
      "",
    );

    expect(response.status).toBe(403);
    expect(findOrCreateByTelegramWithPhone).not.toHaveBeenCalled();
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  test("rejects a completed replay when the claimed phone is not bound", async () => {
    claimTelegramOnboardingContinuation.mockResolvedValueOnce({
      status: "completed",
      sessionId: "platform:telegram:123456789",
      userId: "user-1",
      organizationId: "org-1",
    });
    getById.mockImplementation(async () => ({
      ...USER,
      phone_number: "+14155550999",
    }));

    const response = await post(
      {
        ...AUTH_BODY,
        onboarding_session: "completed-continuation",
      },
      "",
    );

    expect(response.status).toBe(409);
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(runOnboardingChat).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  test("fails closed when phone linking fails", async () => {
    const userWithoutPhone = { ...USER, phone_number: null };
    getById.mockImplementation(async () => userWithoutPhone);
    linkPhoneToUser.mockResolvedValueOnce({
      success: false,
      error: "PHONE_ALREADY_LINKED",
    });

    const response = await post({
      ...AUTH_BODY,
      onboarding_session: "phone-conflict-continuation",
    });

    expect(response.status).toBe(409);
    expect(runOnboardingChat).not.toHaveBeenCalled();
    expect(completeTelegramOnboardingContinuationClaim).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  test("session-based linking rejects a mismatched phone before any durable link", async () => {
    getById.mockImplementation(async () => ({
      ...USER,
      phone_number: "+14155550999",
    }));

    const response = await post({ ...AUTH_BODY });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "PHONE_ALREADY_LINKED",
    );
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(linkPhoneToUser).not.toHaveBeenCalled();
  });

  test("session-based linking rejects a phone owned by another account before any durable link", async () => {
    getById.mockImplementation(async () => ({ ...USER, phone_number: null }));
    getByPhoneNumber.mockResolvedValueOnce({ ...USER, id: "user-2" });

    const response = await post({ ...AUTH_BODY });

    expect(response.status).toBe(409);
    expect(linkTelegramToUser).not.toHaveBeenCalled();
    expect(linkPhoneToUser).not.toHaveBeenCalled();
  });

  test("uses a stable claim id for an identical signed retry", async () => {
    await post({ ...AUTH_BODY, onboarding_session: "stable-claim-token" });
    await post({ ...AUTH_BODY, onboarding_session: "stable-claim-token" });

    const firstClaimId = (
      claimTelegramOnboardingContinuation.mock.calls[0]?.[0] as
        | { claimId: string }
        | undefined
    )?.claimId;
    const secondClaimId = (
      claimTelegramOnboardingContinuation.mock.calls[1]?.[0] as
        | { claimId: string }
        | undefined
    )?.claimId;
    expect(firstClaimId).toBe(secondClaimId);
  });
});
