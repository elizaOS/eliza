/**
 * Verifies owner-gated group reminder destinations on the trusted messaging
 * route: the owner's group turn receives a destination pinned to the binding's
 * live delivery authority, and every other participant or binding state gets
 * none. Mocked account, runtime, and repository boundaries.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  groupParticipantLabel,
  resolveGroupParticipantDisplayName,
} from "@/lib/services/shared-runtime/group-participant-labels";

const resolvePersonalDelivery = mock(async () => ({
  userId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  dedicatedTarget: null,
  isNew: false,
  resolution: "single-query-repeat" as const,
}));
const sharedRestMessageSend = mock(async (..._args: unknown[]) => ({
  text: "hello from Eliza",
}));
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const runOnboardingChat = mock(async () => ({
  loginUrl:
    "https://cloud-staging.eliza.app/get-started?onboardingSession=claim-token",
}));
const findActivePersonalDedicatedTarget = mock(async () => null);
const bridge = mock(async () => ({
  jsonrpc: "2.0" as const,
  id: "unused",
  result: { text: "hello from Dedicated" },
}));
const importCanonicalConversation = mock(async () => null);
const coordinateSharedHistory = mock(async () => []);
const issueGroupClaim = mock(async () => undefined);
const consumeGroupClaimAndBind = mock(
  async (): Promise<{ status: "invalid" }> => ({ status: "invalid" }),
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
const authorizeGroupDelivery = mock(async () => ({
  authorized: false,
  leaseToken: null,
  expiresAt: null,
}));
const commitGroupDelivery = mock(async () => false);
const recordGroupDeliveryReceipts = mock(async () => ({
  recorded: false,
  inserted: 0,
}));
const hasGroupDeliveryReceipt = mock(async () => true);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = { waitUntil: mock(() => undefined) };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { resolvePersonalDelivery },
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
  checkAgentCreditGate: async () => ({ allowed: true, balance: 10 }),
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => ({ ok: true, required: false }),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentResumeOnce: mock(async () => ({
      created: true,
      job: { id: "resume-job-1" },
    })),
    enqueueAgentWakeOnce: mock(async () => ({
      created: true,
      job: { id: "wake-job-1" },
    })),
    triggerImmediate: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { bridge, importCanonicalConversation },
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedHistory,
}));
// In-memory stand-in for the participant identity registry: ordinals are
// assigned per binding in first-seen order and names go through the real
// resolution rules, exactly as the repository does, so the label a turn
// produces is deterministic in tests.
type StubParticipant = {
  platformUserId: string;
  ordinal: number;
  displayName: string | null;
};
const groupParticipantOrdinals = new Map<
  string,
  Map<string, StubParticipant>
>();
const recordGroupParticipantTurn = mock(
  async ({
    bindingId,
    platformUserId,
    displayName,
  }: {
    bindingId: string;
    platformUserId: string;
    displayName?: string | null;
  }) => {
    let binding = groupParticipantOrdinals.get(bindingId);
    if (!binding) {
      binding = new Map<string, StubParticipant>();
      groupParticipantOrdinals.set(bindingId, binding);
    }
    const resolved = resolveGroupParticipantDisplayName({
      candidate: displayName,
      platformUserId,
      roster: [...binding.values()],
    });
    const existing = binding.get(platformUserId);
    binding.set(platformUserId, {
      platformUserId,
      ordinal: existing?.ordinal ?? binding.size + 1,
      displayName: resolved,
    });
    const roster = [...binding.values()];
    const actor = roster.find((p) => p.platformUserId === platformUserId);
    if (!actor) throw new Error("participant registry stub lost its actor");
    return { actor, roster };
  },
);
mock.module("@/db/repositories/personal-shared-groups", () => ({
  personalSharedGroupsRepository: {
    issueClaim: issueGroupClaim,
    consumeClaimAndBind: consumeGroupClaimAndBind,
    resolveBinding: resolveGroupBinding,
    setResponsePolicy: setGroupResponsePolicy,
    revokeBinding: revokeGroupBinding,
    applyMembershipChange: applyGroupMembershipChange,
    authorizeDelivery: authorizeGroupDelivery,
    commitDelivery: commitGroupDelivery,
    recordDeliveryReceipts: recordGroupDeliveryReceipts,
    hasDeliveryReceipt: hasGroupDeliveryReceipt,
  },
}));
mock.module("@/db/repositories/personal-shared-group-participants", () => ({
  personalSharedGroupParticipantsRepository: {
    recordTurn: recordGroupParticipantTurn,
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

function request(body: unknown) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
        "x-eliza-trace-id": "11111111-1111-4111-8111-111111111111",
      },
      body: JSON.stringify(body),
    },
    {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
    } as never,
    executionCtx as never,
  );
}

const blooioGroupBinding = {
  id: "00000000-0000-4000-8000-000000000031",
  organization_id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: "00000000-0000-4000-8000-000000000002",
  personal_agent_id: "personal:3e91680e-2611-5ff5-b759-c16b990967bd",
  platform: "blooio",
  project: "eliza-app",
  connector_account_id: "blooio:test-number",
  provider_chat_id: "chat_group_123",
  conversation_id: "group:00000000-0000-5000-8000-000000000031",
  state: "active",
  response_policy: "mention_only",
  created_by_platform_user_id: "+15551234567",
  authority_version: 3,
};
const blooioGroupAuthority = {
  bindingId: blooioGroupBinding.id,
  ownerUserId: blooioGroupBinding.owner_user_id,
  personalAgentId: blooioGroupBinding.personal_agent_id,
  version: blooioGroupBinding.authority_version,
};

const ownerBlooioGroupTurn = {
  platform: "blooio",
  chatType: "group",
  project: "eliza-app",
  connectorAccountId: "blooio:test-number",
  chatId: "chat_group_123",
  actor: {
    platformUserId: "+15551234567",
    displayName: "Nubs",
    role: "possessor",
  },
  messageId: "blooio:eliza:group-42",
  message: "Eliza remind us to pay rent in an hour",
  invocation: "mention",
};

describe("personal Shared group reminder destinations", () => {
  beforeEach(() => {
    groupParticipantOrdinals.clear();
    recordGroupParticipantTurn.mockClear();
    sharedRestMessageSend.mockClear();
    resolveGroupBinding.mockClear();
    resolveGroupBinding.mockImplementation(async () => blooioGroupBinding);
    hasGroupDeliveryReceipt.mockClear();
    hasGroupDeliveryReceipt.mockImplementation(async () => true);
  });

  test("grants the owner's group turn a trusted group reminder destination", async () => {
    const response = await request(ownerBlooioGroupTurn);

    expect(response.status).toBe(200);
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: blooioGroupBinding.personal_agent_id }),
      blooioGroupBinding.conversation_id,
      `${groupParticipantLabel({
        ordinal: 1,
        displayName: ownerBlooioGroupTurn.actor.displayName,
      })}: ${ownerBlooioGroupTurn.message}`,
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      ownerBlooioGroupTurn.messageId,
      "platform",
      {
        platform: "blooio",
        kind: "group",
        project: "eliza-app",
        connectorAccountId: "blooio:test-number",
        chatId: "chat_group_123",
        ownerLabel: "Nubs",
        authority: blooioGroupAuthority,
      },
      ownerBlooioGroupTurn.message,
      { type: "GROUP", source: "blooio" },
    );
    // The response's delivery authority and the stored reminder destination
    // must describe the same binding generation.
    await expect(response.json()).resolves.toMatchObject({
      data: {
        groupDelivery: { kind: "binding", authority: blooioGroupAuthority },
      },
    });
  });

  test("pins the reminder destination to the binding generation of the current turn", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...blooioGroupBinding,
      authority_version: 4,
    }));
    const response = await request(ownerBlooioGroupTurn);

    expect(response.status).toBe(200);
    expect(sharedRestMessageSend.mock.calls[0]?.[8]).toMatchObject({
      kind: "group",
      authority: { ...blooioGroupAuthority, version: 4 },
    });
  });

  test("labels an owner without a display name as the group owner", async () => {
    const response = await request({
      ...ownerBlooioGroupTurn,
      actor: { platformUserId: "+15551234567", role: "possessor" },
    });

    expect(response.status).toBe(200);
    expect(sharedRestMessageSend.mock.calls[0]?.[8]).toMatchObject({
      kind: "group",
      ownerLabel: "the group owner",
    });
  });

  test("withholds the reminder destination from a non-owner participant", async () => {
    const response = await request({
      ...ownerBlooioGroupTurn,
      actor: {
        platformUserId: "+15559990000",
        displayName: "Guest",
        role: "member",
      },
    });

    expect(response.status).toBe(200);
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend.mock.calls[0]?.[8]).toBeUndefined();
  });

  test("keeps owner-only control copy for a non-owner policy command", async () => {
    const response = await request({
      ...ownerBlooioGroupTurn,
      actor: {
        platformUserId: "+15559990000",
        displayName: "Guest",
        role: "member",
      },
      message: "Eliza ambient on",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_owner_required",
        reply:
          "Only the owner who linked Eliza can change this group's response policy.",
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("suspended bindings never reach inference or a reminder destination", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...blooioGroupBinding,
      state: "suspended",
    }));
    const response = await request(ownerBlooioGroupTurn);

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_binding_suspended" },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("mention-only groups still drop ambient turns before any capability", async () => {
    hasGroupDeliveryReceipt.mockImplementationOnce(async () => false);
    const response = await request({
      ...ownerBlooioGroupTurn,
      message: "unrelated ambient chatter",
      invocation: "ambient",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_silent", reply: "" },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });
});
