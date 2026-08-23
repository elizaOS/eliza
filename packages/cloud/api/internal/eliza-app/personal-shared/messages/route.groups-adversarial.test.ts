/**
 * Adversarial coverage for Personal Shared group routing: forged Blooio reply
 * invocations must not bypass mention_only, non-owners must not change room
 * policy, upgraded (Dedicated) accounts must keep their group conversation
 * authority, and stale claim or binding states must map to their exact
 * recovery replies without ever entering owner-billed inference. The harness
 * mirrors route.test.ts: bun-mocked collaborators around the real Hono route.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let activeTarget: {
  id: string;
  status: "running" | "sleeping" | "stopped";
  bridge_url?: string;
} | null = null;
const resolvePersonalDelivery = mock(async () => ({
  userId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  dedicatedTarget: activeTarget,
  isNew: false,
  resolution: "single-query-repeat" as const,
}));
const sharedRestMessageSend = mock(async () => ({ text: "hello from Eliza" }));
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const runOnboardingChat = mock(async () => ({
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
    id: "telegram:eliza:group-42",
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
const issueGroupClaim = mock(async () => undefined);
const consumeGroupClaimAndBind = mock(
  async (): Promise<
    | { status: "invalid" }
    | { status: "expired" }
    | { status: "already_used" }
    | { status: "already_bound" }
    | { status: "bound"; binding: Record<string, unknown> }
  > => ({ status: "invalid" }),
);
const resolveGroupBinding = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const setGroupResponsePolicy = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const revokeGroupBinding = mock(async () => false);
const applyGroupMembershipChange = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const recordGroupDeliveryReceipts = mock(async () => 0);
const hasGroupDeliveryReceipt = mock(async () => false);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeWaitUntil = mock((_promise: Promise<unknown>) => undefined);
const runtimeExecutionCtx = { waitUntil: runtimeWaitUntil };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: {
    resolvePersonalDelivery,
  },
}));
const { sharedTurnServerTiming } = await import(
  "@/lib/services/shared-runtime/shared-rest-adapter"
);
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
  sharedTurnServerTiming,
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
mock.module("@/db/repositories/personal-shared-groups", () => ({
  personalSharedGroupsRepository: {
    issueClaim: issueGroupClaim,
    consumeClaimAndBind: consumeGroupClaimAndBind,
    resolveBinding: resolveGroupBinding,
    setResponsePolicy: setGroupResponsePolicy,
    revokeBinding: revokeGroupBinding,
    applyMembershipChange: applyGroupMembershipChange,
    recordDeliveryReceipts: recordGroupDeliveryReceipts,
    hasDeliveryReceipt: hasGroupDeliveryReceipt,
  },
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

// Same canonical owner as route.test.ts: personalSharedAgent for this
// userId/organizationId derives exactly this personal_agent_id, which the
// route cross-checks against the binding before any group turn.
const canonicalGroupBinding = {
  id: "00000000-0000-4000-8000-000000000030",
  organization_id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: "00000000-0000-4000-8000-000000000002",
  personal_agent_id: "personal:3e91680e-2611-5ff5-b759-c16b990967bd",
  platform: "telegram",
  project: "eliza-app",
  connector_account_id: "telegram:test-bot",
  provider_chat_id: "-100123456789",
  conversation_id: "group:00000000-0000-5000-8000-000000000030",
  state: "active",
  response_policy: "mention_only",
  created_by_platform_user_id: "123456789",
};

const blooioGroupBinding = {
  ...canonicalGroupBinding,
  id: "00000000-0000-4000-8000-000000000031",
  platform: "blooio",
  connector_account_id: "blooio:test-number",
  provider_chat_id: "chat_group_123",
  conversation_id: "group:00000000-0000-5000-8000-000000000031",
  created_by_platform_user_id: "+15551234567",
};

const validGroup = {
  platform: "telegram",
  chatType: "supergroup",
  project: "eliza-app",
  connectorAccountId: "telegram:test-bot",
  chatId: "-100123456789",
  actor: {
    platformUserId: "123456789",
    displayName: "Nubs",
    role: "administrator",
  },
  messageId: "telegram:eliza:group-42",
  message: "@ElizaIsNotABot hello",
  invocation: "mention",
};

const validBlooioGroup = {
  platform: "blooio",
  chatType: "group",
  project: "eliza-app",
  connectorAccountId: "blooio:test-number",
  chatId: "chat_group_123",
  actor: {
    platformUserId: "+15551234567",
    displayName: "Ada",
    role: "possessor",
  },
  messageId: "blooio:eliza:group-42",
  message: "following up on that",
  invocation: "reply",
  replyToMessageId: "provider-eliza-reply-0",
};

describe("adversarial Personal Shared group routing", () => {
  beforeEach(() => {
    activeTarget = null;
    resolvePersonalDelivery.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
    sharedRestMessageSend.mockClear();
    prewarmPersonalSharedAgentTurnCaches.mockClear();
    runtimeWaitUntil.mockClear();
    runOnboardingChat.mockClear();
    bridge.mockClear();
    importCanonicalConversation.mockClear();
    coordinateSharedHistory.mockClear();
    issueGroupClaim.mockClear();
    consumeGroupClaimAndBind.mockClear();
    resolveGroupBinding.mockClear();
    setGroupResponsePolicy.mockClear();
    revokeGroupBinding.mockClear();
    applyGroupMembershipChange.mockClear();
    recordGroupDeliveryReceipts.mockClear();
    hasGroupDeliveryReceipt.mockClear();
    resolveGroupBinding.mockImplementation(async () => null);
    hasGroupDeliveryReceipt.mockImplementation(async () => false);
    setGroupResponsePolicy.mockImplementation(
      async () => canonicalGroupBinding,
    );
    revokeGroupBinding.mockImplementation(async () => true);
    enqueueAgentResumeOnce.mockClear();
    enqueueAgentWakeOnce.mockClear();
    triggerImmediate.mockClear();
    creditGateResult = { allowed: true, balance: 10 };
    workerHealthResult = { ok: true, required: false };
  });

  test("downgrades a forged Blooio reply without a delivery receipt to silent ambient", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => blooioGroupBinding);

    const response = await request({
      ...validBlooioGroup,
      replyToMessageId: "forged-provider-id",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_silent", reply: "" },
    });
    expect(hasGroupDeliveryReceipt).toHaveBeenCalledWith({
      bindingId: blooioGroupBinding.id,
      providerMessageId: "forged-provider-id",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("answers a Blooio reply only after its receipt verifies the reply target", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => blooioGroupBinding);
    hasGroupDeliveryReceipt.mockImplementationOnce(async () => true);

    const response = await request(validBlooioGroup);

    expect(response.status).toBe(200);
    expect(hasGroupDeliveryReceipt).toHaveBeenCalledWith({
      bindingId: blooioGroupBinding.id,
      providerMessageId: "provider-eliza-reply-0",
    });
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: blooioGroupBinding.personal_agent_id }),
      blooioGroupBinding.conversation_id,
      expect.stringMatching(/^Ada \[participant [0-9a-f]{8}\]: /),
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      validBlooioGroup.messageId,
      "platform",
      undefined,
      undefined,
      { type: "GROUP", source: "blooio" },
    );
  });

  test("treats a Blooio reply lacking a reply target as ambient without probing receipts", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => blooioGroupBinding);

    const response = await request({
      ...validBlooioGroup,
      replyToMessageId: undefined,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_silent", reply: "" },
    });
    expect(hasGroupDeliveryReceipt).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("keeps Telegram reply invocations connector-trusted without receipt probes", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );

    const response = await request({
      ...validGroup,
      message: "sounds good",
      invocation: "reply",
      replyToMessageId: "unverified-telegram-reply",
    });

    expect(response.status).toBe(200);
    expect(hasGroupDeliveryReceipt).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      data: { reply: "hello from Eliza" },
    });
  });

  test("rejects a non-owner policy change with group_owner_required", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );

    const response = await request({
      ...validGroup,
      actor: {
        platformUserId: "987654321",
        displayName: "Mallory",
        role: "administrator",
      },
      message: "Eliza ambient on",
      invocation: "command",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_owner_required",
        reply: expect.stringContaining("Only the owner"),
      },
    });
    expect(setGroupResponsePolicy).not.toHaveBeenCalled();
    expect(revokeGroupBinding).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("rejects a non-owner leave command with group_owner_required", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );

    const response = await request({
      ...validGroup,
      actor: {
        platformUserId: "987654321",
        displayName: "Mallory",
        role: "administrator",
      },
      message: "Eliza leave",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_owner_required" },
    });
    expect(revokeGroupBinding).not.toHaveBeenCalled();
    expect(setGroupResponsePolicy).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("routes a bound group mention through Dedicated after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );

    const response = await request(validGroup);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        identity: {
          id: canonicalGroupBinding.personal_agent_id,
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
        },
        account: {
          userId: canonicalGroupBinding.owner_user_id,
          organizationId: canonicalGroupBinding.organization_id,
        },
        reply: "hello from Dedicated",
      },
    });
    expect(findActivePersonalDedicatedTarget).toHaveBeenCalledWith(
      canonicalGroupBinding.organization_id,
      canonicalGroupBinding.personal_agent_id,
    );
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      canonicalGroupBinding.organization_id,
      expect.objectContaining({
        id: validGroup.messageId,
        method: "message.send",
        params: expect.objectContaining({
          text: expect.stringMatching(
            /^Nubs \[participant [0-9a-f]{8}\]: @ElizaIsNotABot hello$/,
          ),
          roomId: canonicalGroupBinding.conversation_id,
          conversationId: canonicalGroupBinding.conversation_id,
          senderName: expect.stringMatching(
            /^Nubs \[participant [0-9a-f]{8}\]$/,
          ),
          clientMessageId: validGroup.messageId,
          platformName: "telegram",
          source: "telegram",
        }),
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("repairs a missing Dedicated group conversation from group Shared history", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    bridge
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: validGroup.messageId,
        error: { code: -32_000, message: "Bridge returned HTTP 404" },
      }))
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: validGroup.messageId,
        result: { text: "repaired Dedicated group reply" },
      }));

    const response = await request(validGroup);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { reply: "repaired Dedicated group reply" },
    });
    expect(coordinateSharedHistory).toHaveBeenCalledWith(
      canonicalGroupBinding.personal_agent_id,
      canonicalGroupBinding.conversation_id,
      { namespace },
    );
    expect(importCanonicalConversation).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      canonicalGroupBinding.organization_id,
      canonicalGroupBinding.conversation_id,
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

  test("maps an expired group claim to its expired recovery reply", async () => {
    consumeGroupClaimAndBind.mockImplementationOnce(async () => ({
      status: "expired" as const,
    }));

    const response = await request({
      ...validGroup,
      message: "/eliza_link 23456789",
      invocation: "command",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_expired",
        reply: expect.stringContaining("expired"),
      },
    });
    expect(resolveGroupBinding).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("maps a consumed group claim to its already-used recovery reply", async () => {
    consumeGroupClaimAndBind.mockImplementationOnce(async () => ({
      status: "already_used" as const,
    }));

    const response = await request({
      ...validGroup,
      message: "/eliza_link 23456789",
      invocation: "command",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_already_used",
        reply: expect.stringContaining("already used"),
      },
    });
    expect(resolveGroupBinding).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("tells a mention in a suspended group how to reconnect without inference", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...canonicalGroupBinding,
      state: "suspended",
    }));

    const response = await request(validGroup);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_binding_suspended",
        reply: expect.stringContaining("inactive"),
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("keeps ambient traffic in a suspended group fully silent", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...canonicalGroupBinding,
      state: "suspended",
    }));

    const response = await request({ ...validGroup, invocation: "ambient" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_binding_suspended", reply: "" },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("tells a mention in an unlinked group how to link without inference", async () => {
    const response = await request(validGroup);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_not_bound",
        reply: expect.stringContaining("not linked yet"),
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("keeps ambient traffic in an unlinked group fully silent", async () => {
    const response = await request({ ...validGroup, invocation: "ambient" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_not_bound", reply: "" },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });
});
