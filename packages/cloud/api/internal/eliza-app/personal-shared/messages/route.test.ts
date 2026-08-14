/** Verifies trusted messaging convergence into a platform-funded rowless turn. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OnboardingChatInput } from "@/lib/services/eliza-app/onboarding-chat";

const findOrCreateByTelegram = mock(async () => ({
  user: { id: "00000000-0000-4000-8000-000000000002" },
  organization: { id: "00000000-0000-4000-8000-000000000001" },
  isNew: true,
}));
const findOrCreateByPhone = mock(async () => ({
  user: { id: "00000000-0000-4000-8000-000000000012" },
  organization: { id: "00000000-0000-4000-8000-000000000011" },
  isNew: true,
}));
const sharedRestMessageSend = mock(async () => ({ text: "hello from Eliza" }));
const runOnboardingChat = mock(async (_input: OnboardingChatInput) => ({
  loginUrl:
    "https://cloud-staging.eliza.app/get-started?onboardingSession=claim-token",
}));
let activeTarget: {
  id: string;
  status: "running" | "stopped";
} | null = null;
const findActivePersonalDedicatedTarget = mock(async () => activeTarget);
type BridgeResponse =
  | {
      jsonrpc: "2.0";
      id: string;
      result: { text: string };
    }
  | {
      jsonrpc: "2.0";
      id: string;
      error: { code: number; message: string };
    };
const bridge = mock(
  async (): Promise<BridgeResponse> => ({
    jsonrpc: "2.0" as const,
    id: "telegram:eliza:42",
    result: { text: "hello from Dedicated" },
  }),
);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = { waitUntil() {} };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { findOrCreateByPhone, findOrCreateByTelegram },
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
}));
mock.module("@/lib/services/eliza-app/onboarding-chat", () => ({
  runOnboardingChat,
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { bridge },
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: runtimeExecutionCtx,
  }),
}));

const { default: app } = await import("./route");
const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

function request(body: unknown, authorization = "Bearer test-secret") {
  return app.request(
    "/",
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
    } as never,
    executionCtx as never,
  );
}

const valid = {
  platform: "telegram",
  telegramUserId: "123456789",
  telegramUsername: "nubs",
  displayName: "Nubs",
  messageId: "telegram:eliza:42",
  message: "hello",
};

const validPhone = {
  platform: "blooio",
  phoneNumber: "+15551234567",
  messageId: "blooio:eliza:message-42",
  message: "hello from Messages",
};

describe("personal Shared messaging deliveries", () => {
  beforeEach(() => {
    findOrCreateByPhone.mockClear();
    activeTarget = null;
    findOrCreateByTelegram.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
    sharedRestMessageSend.mockClear();
    runOnboardingChat.mockClear();
    bridge.mockClear();
  });

  test("requires internal gateway authentication", async () => {
    expect((await request(valid, "")).status).toBe(401);
    expect(findOrCreateByTelegram).not.toHaveBeenCalled();
  });

  test("uses one account-native identity and platform funding", async () => {
    const response = await request(valid);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string } };
    };
    expect(findOrCreateByTelegram).toHaveBeenCalledWith({
      telegramId: "123456789",
      username: "nubs",
      displayName: "Nubs",
    });
    expect(body.data.identity.id).toMatch(/^personal:/);
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.identity.id,
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
        execution_tier: "shared",
      }),
      body.data.identity.id,
      "hello",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "telegram:eliza:42",
      "platform",
    );
  });

  test("issues an account-bound Telegram claim without entering runtime or provisioning", async () => {
    const response = await request({ ...valid, message: "/connect" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        account: {
          userId: "00000000-0000-4000-8000-000000000002",
          organizationId: "00000000-0000-4000-8000-000000000001",
        },
        reply:
          "Sign in to connect this Telegram chat to your Eliza account: https://cloud-staging.eliza.app/get-started?onboardingSession=claim-token&accountClaim=telegram",
      },
    });
    expect(runOnboardingChat).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(
        /^platform:telegram-claim:[0-9a-f]{64}$/,
      ),
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "Nubs",
      authenticatedUser: {
        userId: "00000000-0000-4000-8000-000000000002",
        organizationId: "00000000-0000-4000-8000-000000000001",
        telegramId: "123456789",
      },
      trustedPlatformIdentity: true,
      statusOnly: true,
      idempotencyKey: "telegram-account-claim:telegram:eliza:42",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("accepts Telegram's bot-qualified /connect command idempotently", async () => {
    const response = await request({
      ...valid,
      message: "/connect@elizaisnotabot",
      messageId: "telegram:eliza:43",
    });

    expect(response.status).toBe(200);
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(
          /^platform:telegram-claim:[0-9a-f]{64}$/,
        ),
        idempotencyKey: "telegram-account-claim:telegram:eliza:43",
        statusOnly: true,
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("isolates each new /connect delivery without changing retry identity", async () => {
    await request({ ...valid, message: "/connect" });
    await request({ ...valid, message: "/connect" });
    await request({
      ...valid,
      message: "/connect",
      messageId: "telegram:eliza:44",
    });

    const firstSession = runOnboardingChat.mock.calls[0]?.[0].sessionId;
    const retrySession = runOnboardingChat.mock.calls[1]?.[0].sessionId;
    const renewedSession = runOnboardingChat.mock.calls[2]?.[0].sessionId;
    expect(firstSession).toBe(retrySession);
    expect(renewedSession).not.toBe(firstSession);
  });

  test("uses the phone account without provisioning an agent row", async () => {
    const response = await request(validPhone);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string }; account: { userId: string } };
    };
    expect(findOrCreateByPhone).toHaveBeenCalledWith("+15551234567");
    expect(findOrCreateByTelegram).not.toHaveBeenCalled();
    expect(body.data.identity.id).toMatch(/^personal:/);
    expect(body.data.account.userId).toBe(
      "00000000-0000-4000-8000-000000000012",
    );
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.identity.id,
        organization_id: "00000000-0000-4000-8000-000000000011",
        user_id: "00000000-0000-4000-8000-000000000012",
        execution_tier: "shared",
      }),
      body.data.identity.id,
      "hello from Messages",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "blooio:eliza:message-42",
      "platform",
    );
  });

  test("routes Telegram to the server-owned Dedicated primary after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };

    const response = await request(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
        },
        reply: "hello from Dedicated",
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        id: "telegram:eliza:42",
        method: "message.send",
        params: expect.objectContaining({
          text: "hello",
          clientMessageId: "telegram:eliza:42",
          platformName: "telegram",
        }),
      }),
    );
  });

  test("never falls back to Shared after Dedicated becomes authoritative", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "stopped",
    };

    const response = await request(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("surfaces a Dedicated bridge failure without reopening Shared", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };
    bridge.mockImplementationOnce(async () => ({
      jsonrpc: "2.0" as const,
      id: "telegram:eliza:42",
      error: { code: -32_603, message: "Dedicated unavailable" },
    }));

    const response = await request(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test.each([
    { ...validPhone, phoneNumber: "15551234567" },
    { ...valid, telegramUserId: "not-a-number" },
    { ...valid, message: "" },
  ])("rejects malformed deliveries before account creation", async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
    expect(findOrCreateByTelegram).not.toHaveBeenCalled();
  });
});
