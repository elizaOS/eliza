/** Verifies trusted messaging convergence into a platform-funded rowless turn. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OnboardingChatInput } from "@/lib/services/eliza-app/onboarding-chat";
import { logger } from "@/lib/utils/logger";
import { markPreverifiedPersonalSharedRequest } from "../preverified-auth";

let activeTarget: {
  id: string;
  status: "running" | "sleeping" | "stopped";
  bridge_url?: string;
} | null = null;
let personalDeliveryIsNew = false;
const resolvePersonalDelivery = mock(async () => ({
  userId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  dedicatedTarget: activeTarget,
  isNew: personalDeliveryIsNew,
  resolution: "single-query-repeat" as const,
}));
const findOrCreateByPhone = mock(async () => ({
  user: { id: "00000000-0000-4000-8000-000000000012" },
  organization: { id: "00000000-0000-4000-8000-000000000011" },
  isNew: true,
}));
const sharedRestMessageSend = mock(async () => ({ text: "hello from Eliza" }));
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const runOnboardingChat = mock(async (_input: OnboardingChatInput) => ({
  loginUrl:
    "https://cloud-staging.eliza.app/get-started?onboardingSession=claim-token",
}));
const findActivePersonalDedicatedTarget = mock(async () => activeTarget);
let creditGateResult: { allowed: boolean; balance: number; error?: string } = {
  allowed: true,
  balance: 10,
};
let workerHealthResult:
  | { ok: true; required: false }
  | {
      ok: false;
      required: true;
      status: 503;
      code: "PROVISIONING_WORKER_UNHEALTHY";
      error: string;
    } = { ok: true, required: false };
const enqueueAgentResumeOnce = mock(async () => ({
  created: true,
  job: { id: "resume-job-1" },
}));
const enqueueAgentWakeOnce = mock(async () => ({
  created: true,
  job: { id: "wake-job-1" },
  appliedRestoreBackupId: null,
  appliedForceFreshBoot: false,
}));
const triggerImmediate = mock(async () => undefined);
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
type ImportReceipt = {
  complete: true;
  sourceMessageCount: number;
  inserted: number;
  skipped: number;
};
const importCanonicalConversation = mock(
  async (
    _agentId: string,
    _orgId: string,
    _conversationId: string,
    _messages: Array<{
      sourceId: string;
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
    }>,
  ): Promise<ImportReceipt | null> => ({
    complete: true,
    sourceMessageCount: 2,
    inserted: 2,
    skipped: 0,
  }),
);
const coordinateSharedHistory = mock(async () => [
  { id: "source-1", role: "user" as const, content: "before", createdAt: 100 },
  {
    id: "source-2",
    role: "assistant" as const,
    content: "after",
    createdAt: 101,
  },
]);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeWaitUntil = mock((_promise: Promise<unknown>) => undefined);
const runtimeExecutionCtx = { waitUntil: runtimeWaitUntil };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: {
    findOrCreateByPhone,
    resolvePersonalDelivery,
  },
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
}));
mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmPersonalSharedAgentTurnCaches,
}));
mock.module("@/lib/services/eliza-app/onboarding-chat", () => ({
  runOnboardingChat,
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate: async () => creditGateResult,
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => workerHealthResult,
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentResumeOnce,
    enqueueAgentWakeOnce,
    triggerImmediate,
  },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { bridge, importCanonicalConversation },
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedHistory,
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: runtimeExecutionCtx,
  }),
}));

const { default: app } = await import("./route");
const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

function request(
  body: unknown,
  authorization = "Bearer test-secret",
  traceId = "11111111-1111-4111-8111-111111111111",
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-eliza-trace-id": traceId,
      },
      body: JSON.stringify(body),
    },
    {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      WHISPER_STT_URL: "https://whisper.test",
    } as never,
    executionCtx as never,
  );
}

const valid = {
  platform: "telegram",
  project: "eliza-app",
  chatId: "123456789",
  telegramUserId: "123456789",
  telegramUsername: "nubs",
  displayName: "Nubs",
  messageId: "telegram:eliza:42",
  message: "hello",
};

const validPhone = {
  platform: "blooio",
  project: "eliza-app",
  phoneNumber: "+15551234567",
  messageId: "blooio:eliza:message-42",
  message: "hello from Messages",
};

describe("personal Shared messaging deliveries", () => {
  beforeEach(() => {
    findOrCreateByPhone.mockClear();
    activeTarget = null;
    personalDeliveryIsNew = false;
    resolvePersonalDelivery.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
    sharedRestMessageSend.mockClear();
    prewarmPersonalSharedAgentTurnCaches.mockClear();
    runtimeWaitUntil.mockClear();
    runOnboardingChat.mockClear();
    bridge.mockClear();
    importCanonicalConversation.mockClear();
    coordinateSharedHistory.mockClear();
    enqueueAgentResumeOnce.mockClear();
    enqueueAgentWakeOnce.mockClear();
    triggerImmediate.mockClear();
    creditGateResult = { allowed: true, balance: 10 };
    workerHealthResult = { ok: true, required: false };
  });

  test("requires internal gateway authentication", async () => {
    expect((await request(valid, "")).status).toBe(401);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  test("accepts an in-isolate preverified identity at the real route boundary", async () => {
    const preverifiedRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    markPreverifiedPersonalSharedRequest(preverifiedRequest, {
      podName: "gateway-1",
      service: "discord-gateway",
    });
    const env = {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      WHISPER_STT_URL: "https://whisper.test",
    } as never;

    expect(
      (
        await app.request(
          preverifiedRequest,
          undefined,
          env,
          executionCtx as never,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          new Request("http://localhost/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(valid),
          }),
          undefined,
          env,
          executionCtx as never,
        )
      ).status,
    ).toBe(401);
  });

  test("keeps the caller allowlist fail-closed for a preverified identity", async () => {
    const preverifiedRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    markPreverifiedPersonalSharedRequest(preverifiedRequest, {
      podName: "agent-server-1",
      service: "agent-server",
    });

    const response = await app.request(
      preverifiedRequest,
      undefined,
      {
        INTERNAL_SECRET: "test-secret",
        SHARED_RUNTIME_CONVERSATIONS: namespace,
        WHISPER_STT_URL: "https://whisper.test",
      } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(403);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  test("uses one account-native identity and platform funding", async () => {
    const response = await request(valid);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string } };
    };
    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "telegram",
      telegramId: "123456789",
      username: "nubs",
      displayName: "Nubs",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="single-query-repeat", prewarm;dur=\d+\.\d, shared;dur=\d+\.\d$/,
    );
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
      {
        platform: "telegram",
        project: "eliza-app",
        chatId: "123456789",
      },
      undefined,
      undefined,
      { preferredName: "Nubs" },
    );
  });

  test("warms a newly auto-registered personal account before its first turn", async () => {
    personalDeliveryIsNew = true;
    const order: string[] = [];
    prewarmPersonalSharedAgentTurnCaches.mockImplementationOnce(async () => {
      order.push("prewarm");
    });
    sharedRestMessageSend.mockImplementationOnce(async () => {
      order.push("turn");
      return { text: "hello from Eliza" };
    });

    const response = await request({
      ...valid,
      telegramUserId: "99008152237",
      chatId: "99008152237",
      messageId: "QA815-LAT8-COLD",
    });

    expect(response.status).toBe(200);
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
      }),
      namespace,
      { warmConversation: true },
    );
    expect(order).toEqual(["prewarm", "turn"]);
    expect(runtimeWaitUntil).toHaveBeenCalledTimes(1);
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="[^"]+", prewarm;dur=\d+\.\d, shared;dur=\d+\.\d$/,
    );
  });

  test("prewarms established personal turns before inference admission", async () => {
    const response = await request(valid);

    expect(response.status).toBe(200);
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
      }),
      namespace,
      { warmConversation: false },
    );
    expect(runtimeWaitUntil).toHaveBeenCalledTimes(1);
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="[^"]+", prewarm;dur=\d+\.\d, shared;dur=\d+\.\d$/,
    );
  });

  test("correlates a Shared failure without logging its sensitive message", async () => {
    const errorLog = mock(() => undefined);
    const originalError = logger.error;
    logger.error = errorLog;
    const failure = new TypeError("provider body must remain private");
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw failure;
    });

    try {
      const response = await request(
        valid,
        "Bearer test-secret",
        "22222222-2222-4222-8222-222222222222",
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("x-eliza-failure-stage")).toBe(
        "shared_runtime",
      );
      expect(response.headers.get("x-eliza-failure-name")).toBe("TypeError");
      expect(errorLog).toHaveBeenCalledWith(
        "[personal-shared-messaging] delivery failed",
        {
          traceId: "22222222-2222-4222-8222-222222222222",
          stage: "shared_runtime",
          errorName: "TypeError",
        },
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "provider body must remain private",
      );
    } finally {
      logger.error = originalError;
    }
  });

  test("preserves cache warming as a retryable 503 at the internal boundary", async () => {
    const { SharedRuntimeCacheWarmingError } = await import(
      "@/lib/services/shared-runtime/shared-runtime-errors"
    );
    const warming = new SharedRuntimeCacheWarmingError(
      "private cold-gate detail",
    );
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw warming;
    });

    const response = await request(valid);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("x-eliza-failure-stage")).toBe(
      "shared_runtime",
    );
    expect(response.headers.get("x-eliza-failure-name")).toBe(
      "SharedRuntimeCacheWarmingError",
    );
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Shared Eliza is warming. Retry this turn shortly.",
      code: "service_unavailable",
      retryable: true,
    });
  });

  test("redacts an unrecognized error name from headers and logs", async () => {
    const errorLog = mock(() => undefined);
    const originalError = logger.error;
    logger.error = errorLog;
    const failure = new Error("private");
    failure.name = "CallerSelectedSecretName";
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw failure;
    });

    try {
      const response = await request(valid);
      expect(response.status).toBe(500);
      expect(response.headers.get("x-eliza-failure-name")).toBe("OtherError");
      expect(errorLog).toHaveBeenCalledWith(
        "[personal-shared-messaging] delivery failed",
        expect.objectContaining({ errorName: "OtherError" }),
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "CallerSelectedSecretName",
      );
    } finally {
      logger.error = originalError;
    }
  });

  test("transcribes a Telegram voice note before the Shared turn", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input, init) => {
      const outbound = new Request(input, init);
      expect(outbound.url).toBe("https://whisper.test/v1/audio/transcriptions");
      const form = await outbound.formData();
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).type).toBe("audio/ogg");
      return Response.json({ text: "remember the red bicycle" });
    }) as unknown as typeof fetch;
    const bytes = Buffer.from("OggSvoice-note");
    try {
      const response = await request({
        ...valid,
        message: undefined,
        voiceNote: {
          bytesBase64: bytes.toString("base64"),
          mimeType: "audio/ogg",
          filename: "telegram-42.ogg",
          sizeBytes: bytes.length,
          durationSeconds: 4,
        },
      });

      expect(response.status).toBe(200);
      expect(sharedRestMessageSend).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^personal:/),
        "remember the red bicycle",
        "Eliza",
        runtimeExecutionCtx,
        namespace,
        "telegram:eliza:42",
        "platform",
        {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
        undefined,
        undefined,
        { preferredName: "Nubs" },
      );
      await expect(response.json()).resolves.toMatchObject({
        data: { reply: "hello from Eliza" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("overlaps new-account prewarm with Telegram voice transcription", async () => {
    personalDeliveryIsNew = true;
    const order: string[] = [];
    prewarmPersonalSharedAgentTurnCaches.mockImplementationOnce(async () => {
      order.push("prewarm");
    });
    sharedRestMessageSend.mockImplementationOnce(async () => {
      order.push("turn");
      return { text: "hello from Eliza" };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      order.push("transcription");
      return Response.json({ text: "remember the red bicycle" });
    }) as unknown as typeof fetch;
    const bytes = Buffer.from("OggSvoice-note");

    try {
      const response = await request({
        ...valid,
        message: undefined,
        voiceNote: {
          bytesBase64: bytes.toString("base64"),
          mimeType: "audio/ogg",
          filename: "telegram-42.ogg",
          sizeBytes: bytes.length,
          durationSeconds: 4,
        },
      });

      expect(response.status).toBe(200);
      expect(order).toEqual(["prewarm", "transcription", "turn"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a forged voice payload before identity, storage, or inference", async () => {
    const response = await request({
      ...valid,
      message: undefined,
      voiceNote: {
        bytesBase64: Buffer.from("not ogg").toString("base64"),
        mimeType: "audio/ogg",
        filename: "telegram-42.ogg",
        sizeBytes: 7,
        durationSeconds: 4,
      },
    });

    expect(response.status).toBe(400);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
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
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
    expect(findActivePersonalDedicatedTarget).toHaveBeenCalledTimes(1);
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
      {
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "+15551234567",
      },
      undefined,
      undefined,
      undefined,
    );
  });

  test("routes a linked Discord DM through the same personal room", async () => {
    const discordUserId = ["123456789", "012345678"].join("");
    const response = await request({
      platform: "discord",
      discordUserId,
      discordUsername: "shaw",
      displayName: "Shaw",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      messageId: "discord:message-42",
      message: "continue our conversation",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string } };
    };
    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "discord",
      discordId: discordUserId,
      username: "shaw",
      globalName: "Shaw",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.data.identity.id }),
      body.data.identity.id,
      "continue our conversation",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "discord:message-42",
      "platform",
      {
        platform: "discord",
        discordUserId: "123456789012345678",
      },
      undefined,
      undefined,
      { preferredName: "Shaw" },
    );
  });

  test("routes Telegram to the server-owned Dedicated primary after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
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
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="single-query-repeat", dedicated;dur=\d+\.\d$/,
    );
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        id: "telegram:eliza:42",
        method: "message.send",
        params: expect.objectContaining({
          text: "hello",
          roomId: expect.stringMatching(/^personal:/),
          conversationId: expect.stringMatching(/^personal:/),
          canonicalBridgeBase:
            "http://127.0.0.1:9876/api/compat/agents/sandbox",
          clientMessageId: "telegram:eliza:42",
          platformName: "telegram",
          source: "telegram",
        }),
      }),
    );
  });

  test("idempotently resumes stopped Dedicated and asks the gateway to retry", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "stopped",
    };

    const response = await request(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "dedicated_starting",
      retryable: true,
      data: {
        action: "resume",
        activeAgentId: "00000000-0000-4000-8000-000000000020",
        alreadyInProgress: false,
        jobId: "resume-job-1",
      },
    });
    expect(response.headers.get("retry-after")).toBe("5");
    expect(enqueueAgentResumeOnce).toHaveBeenCalledWith({
      agentId: "00000000-0000-4000-8000-000000000020",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("wakes sleeping Dedicated without reopening Shared", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "sleeping",
    };
    enqueueAgentWakeOnce.mockImplementationOnce(async () => ({
      created: false,
      job: { id: "wake-job-existing" },
      appliedRestoreBackupId: null,
      appliedForceFreshBoot: false,
    }));

    const response = await request(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "dedicated_starting",
      retryable: true,
      data: {
        action: "wake",
        alreadyInProgress: true,
        jobId: "wake-job-existing",
      },
    });
    expect(enqueueAgentWakeOnce).toHaveBeenCalledTimes(1);
    expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("keeps paid-compute wake fail-closed when the account is unfunded", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "stopped",
    };
    creditGateResult = {
      allowed: false,
      balance: 0,
      error: "Add funds before resuming Dedicated.",
    };

    const response = await request(valid);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "insufficient_credits",
      retryable: false,
      currentBalance: 0,
    });
    expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
    expect(enqueueAgentWakeOnce).not.toHaveBeenCalled();
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

  test("repairs a missing cutover conversation from authoritative Shared history", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };
    bridge
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        error: { code: -32_000, message: "Bridge returned HTTP 404" },
      }))
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        result: { text: "repaired Dedicated reply" },
      }));

    const response = await request(valid);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { reply: "repaired Dedicated reply" },
    });
    expect(coordinateSharedHistory).toHaveBeenCalledWith(
      expect.stringMatching(/^personal:/),
      expect.stringMatching(/^personal:/),
      { namespace },
    );
    expect(importCanonicalConversation).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.stringMatching(/^personal:/),
      [
        { sourceId: "source-1", role: "user", text: "before", timestamp: 100 },
        {
          sourceId: "source-2",
          role: "assistant",
          text: "after",
          timestamp: 101,
        },
      ],
    );
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("recreates an empty canonical conversation when history import is unavailable", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };
    bridge
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        error: { code: -32_000, message: "Bridge returned HTTP 404" },
      }))
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        result: { text: "available Dedicated reply" },
      }));
    importCanonicalConversation
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({
        complete: true as const,
        sourceMessageCount: 0,
        inserted: 0,
        skipped: 0,
      }));

    const response = await request(valid);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { reply: "available Dedicated reply" },
    });
    expect(importCanonicalConversation).toHaveBeenCalledTimes(2);
    expect(importCanonicalConversation.mock.calls[1]?.[3]).toEqual([]);
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  test.each([
    { ...validPhone, phoneNumber: "15551234567" },
    { ...valid, telegramUserId: "not-a-number" },
    {
      platform: "discord",
      discordUserId: "not-a-snowflake",
      discordUsername: "shaw",
      messageId: "discord:invalid",
      message: "hello",
    },
    { ...valid, message: "" },
  ])("rejects malformed deliveries before account creation", async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });
});
