/** Focused route coverage for the synthetic Parent A/B/Child C consent handshake. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PersonalSharedGroupConsentStatus } from "@/db/repositories/personal-shared-group-consent";

const PARENT_A_USER_ID = "00000000-0000-4000-8000-00000000000a";
const PARENT_B_USER_ID = "00000000-0000-4000-8000-00000000000b";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const BINDING_ID = "00000000-0000-4000-8000-000000000030";
const PROVIDER_THREAD_ID = "909";

const restrictedConsent = {
  mode: "all_adults" as const,
  gate: "restricted" as const,
  requiredPrincipalCount: 2,
  registeredParticipantCount: 2,
  linkedParticipantCount: 1,
  consentedParticipantCount: 1,
  participants: [
    {
      ordinal: 1,
      isOwner: true,
      linked: true,
      consented: true,
      revoked: false,
    },
    {
      ordinal: 2,
      isOwner: false,
      linked: false,
      consented: false,
      revoked: false,
    },
  ],
};

const enabledConsent = {
  ...restrictedConsent,
  gate: "enabled" as const,
  linkedParticipantCount: 2,
  consentedParticipantCount: 2,
  participants: restrictedConsent.participants.map((participant) => ({
    ...participant,
    linked: true,
    consented: true,
  })),
};

const enabledConsentWithChildC = {
  ...enabledConsent,
  registeredParticipantCount: 3,
  participants: [
    ...enabledConsent.participants,
    {
      ordinal: 3,
      isOwner: false,
      linked: false,
      consented: false,
      revoked: false,
    },
  ],
};

const consentAfterParentBLeaves = {
  ...restrictedConsent,
  participants: [
    restrictedConsent.participants[0],
    {
      ordinal: 2,
      isOwner: false,
      linked: false,
      consented: false,
      revoked: true,
    },
  ],
};

const binding = {
  id: BINDING_ID,
  organization_id: ORGANIZATION_ID,
  owner_user_id: PARENT_A_USER_ID,
  personal_agent_id: "personal:0885455d-7126-52e2-a9b7-ef2a19c66fea",
  platform: "telegram",
  project: "eliza-app",
  connector_account_id: "telegram:parent-a-bot",
  provider_chat_id: "-100000000001",
  conversation_id: "group:00000000-0000-5000-8000-000000000030",
  state: "active",
  response_policy: "mention_only",
  consent_mode: "all_adults",
  required_principal_count: 2,
  consent_version: 4,
  created_by_platform_user_id: "100000000001",
  authority_version: 7,
};

const resolveGroupBinding = mock(async () => binding);
const revokeGroupBinding = mock(async () => true);
const consumeGroupClaim = mock(async () => ({ status: "invalid" as const }));
const issueJoinAuthenticateChallenge = mock(async () => ({
  status: "issued" as const,
  consentVersion: 4,
}));
const consumeJoinAuthenticateChallenge = mock(async () => ({
  status: "confirm_issued" as const,
  bindingId: BINDING_ID,
  consentVersion: 4,
}));
const consumeJoinConfirmChallenge = mock(async () => ({
  status: "consented" as const,
  consent: enabledConsent,
}));
const deriveConsentStatus = mock(
  async (): Promise<PersonalSharedGroupConsentStatus> => restrictedConsent,
);
const selfRevoke = mock(async () => ({
  status: "revoked" as const,
  consent: consentAfterParentBLeaves,
}));
const hasDeliveryReceipt = mock(async () => false);
const recordGroupParticipantTurn = mock(
  async ({ platformUserId }: { platformUserId: string }) => {
    const ordinal =
      platformUserId === "100000000001"
        ? 1
        : platformUserId === "200000000002"
          ? 2
          : 3;
    const actor = {
      platformUserId,
      ordinal,
      displayName:
        ordinal === 3
          ? "Child C"
          : `Parent ${String.fromCharCode(64 + ordinal)}`,
    };
    return { actor, roster: [actor] };
  },
);
const resolvePersonalDelivery = mock(async () => ({
  userId: PARENT_B_USER_ID,
  organizationId: ORGANIZATION_ID,
  dedicatedTarget: null,
  isNew: false,
  resolution: "authenticated-parent-b" as const,
}));
const findActivePersonalDedicatedTarget = mock(async () => null);
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const sharedRestMessageSend = mock(async () => ({ text: "unexpected" }));
const enrichInboundImageMedia = mock(async () => ({
  kind: "skipped" as const,
}));
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const { sharedTurnServerTiming } = await import(
  "@/lib/services/shared-runtime/shared-rest-adapter"
);
class StubPersonalSharedGroupDeliveryPendingError extends Error {}

mock.module("@/db/repositories/personal-shared-groups", () => ({
  PersonalSharedGroupDeliveryPendingError:
    StubPersonalSharedGroupDeliveryPendingError,
  personalSharedGroupsRepository: {
    resolveBinding: resolveGroupBinding,
    revokeBinding: revokeGroupBinding,
    consumeClaimAndBind: consumeGroupClaim,
    setResponsePolicy: mock(async () => binding),
    hasDeliveryReceipt,
  },
}));
mock.module("@/db/repositories/personal-shared-group-consent", () => ({
  personalSharedGroupConsentRepository: {
    issueJoinAuthenticateChallenge,
    consumeJoinAuthenticateChallenge,
    consumeJoinConfirmChallenge,
    deriveConsentStatus,
    selfRevoke,
  },
}));
mock.module("@/db/repositories/personal-shared-group-participants", () => ({
  personalSharedGroupParticipantsRepository: {
    recordTurn: recordGroupParticipantTurn,
  },
}));
mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { resolvePersonalDelivery },
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
  isAuthoritativePersonalDedicatedTarget: () => false,
}));
mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmPersonalSharedAgentTurnCaches,
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
  sharedTurnServerTiming,
}));
mock.module("@/lib/services/eliza-app/inbound-media-enrichment", () => ({
  enrichInboundImageMedia,
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: { waitUntil() {} },
  }),
}));

const { default: app } = await import("./route");
const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function groupRequest(input: {
  actor: "Parent A" | "Parent B" | "Child C";
  message: string;
  invocation?: "mention" | "command" | "reply" | "ambient";
}) {
  const ordinal =
    input.actor === "Parent A" ? 1 : input.actor === "Parent B" ? 2 : 3;
  return request({
    platform: "telegram",
    chatType: "supergroup",
    project: "eliza-app",
    connectorAccountId: "telegram:parent-a-bot",
    chatId: "-100000000001",
    providerThreadId: PROVIDER_THREAD_ID,
    actor: {
      platformUserId: `${ordinal}0000000000${ordinal}`,
      displayName: input.actor,
      role: input.actor === "Parent A" ? "administrator" : "member",
    },
    messageId: `telegram:group:${input.actor.toLowerCase().replace(" ", "-")}`,
    message: input.message,
    invocation: input.invocation ?? "command",
  });
}

function parentBDirectRequest(message: string) {
  return request({
    platform: "telegram",
    project: "eliza-app",
    connectorAccountId: "telegram:parent-a-bot",
    chatId: "200000000002",
    telegramUserId: "200000000002",
    displayName: "Parent B",
    messageId: "telegram:dm:parent-b",
    message,
  });
}

function request(body: unknown) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      INTERNAL_SECRET: "test-secret",
      ELIZA_APP_PERSONAL_SHARED_JOIN_CODE_SECRET:
        "synthetic-personal-shared-join-code-secret-v1",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
    } as never,
    executionCtx as never,
  );
}

describe("all-adults Personal Shared route consent", () => {
  beforeEach(() => {
    resolveGroupBinding.mockClear();
    resolveGroupBinding.mockImplementation(async () => binding);
    revokeGroupBinding.mockClear();
    consumeGroupClaim.mockClear();
    issueJoinAuthenticateChallenge.mockClear();
    consumeJoinAuthenticateChallenge.mockClear();
    consumeJoinConfirmChallenge.mockClear();
    deriveConsentStatus.mockClear();
    deriveConsentStatus.mockImplementation(async () => restrictedConsent);
    selfRevoke.mockClear();
    hasDeliveryReceipt.mockClear();
    recordGroupParticipantTurn.mockClear();
    resolvePersonalDelivery.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
    prewarmPersonalSharedAgentTurnCaches.mockClear();
    sharedRestMessageSend.mockClear();
    enrichInboundImageMedia.mockClear();
  });

  test("issues Parent B an actor-bound authenticate challenge in the group", async () => {
    const response = await groupRequest({
      actor: "Parent B",
      message: "Eliza join",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        groupDelivery: { authority: Record<string, unknown> };
      };
    };
    expect(body).toMatchObject({
      data: {
        code: "group_join_authenticate_issued",
        reply: expect.stringMatching(
          /exact participant[\s\S]*direct chat[\s\S]*Eliza join [2-9A-HJ-NP-Z]{12}[\s\S]*plaintext messages and attachments transit/i,
        ),
        consentStatus: restrictedConsent,
        groupDelivery: { kind: "binding" },
      },
    });
    expect(body.data.groupDelivery.authority).toMatchObject({
      requiresAllAdultsConsent: false,
    });
    expect(recordGroupParticipantTurn).toHaveBeenCalledWith({
      bindingId: BINDING_ID,
      platformUserId: "200000000002",
      displayName: "Parent B",
    });
    expect(issueJoinAuthenticateChallenge).toHaveBeenCalledWith({
      codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceMessageId: "telegram:group:parent-b",
      bindingId: BINDING_ID,
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:parent-a-bot",
      providerChatId: "-100000000001",
      providerThreadId: PROVIDER_THREAD_ID,
      actorPlatformUserId: "200000000002",
      expiresAt: expect.any(Date),
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("keeps an unauthenticated all-adults owner claim unbound", async () => {
    consumeGroupClaim.mockImplementationOnce(async () => {
      throw Object.assign(new Error("synthetic independent-auth boundary"), {
        code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
      });
    });

    const response = await groupRequest({
      actor: "Parent A",
      message: "Eliza link ABCD2345",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_authentication_required",
        reply: expect.stringMatching(/owner to finish signing in/i),
        groupDelivery: { kind: "control" },
      },
    });
    expect(resolveGroupBinding).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("authenticates Parent B in DM and returns only a distinct group confirm code", async () => {
    const response = await parentBDirectRequest("Eliza join ABCD2345EFGH");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { code: string; reply: string; consentStatus: unknown };
    };
    expect(body.data).toMatchObject({
      code: "group_join_confirm_issued",
      consentStatus: restrictedConsent,
    });
    expect(body.data.reply).toMatch(
      /original group[\s\S]*Eliza join [2-9A-HJ-NP-Z]{12}[\s\S]*plaintext messages and attachments transit/i,
    );
    expect(body.data.reply).not.toContain("Eliza join ABCD2345EFGH");
    expect(consumeJoinAuthenticateChallenge).toHaveBeenCalledWith({
      codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      confirmCodeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceMessageId: "telegram:dm:parent-b",
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:parent-a-bot",
      actorPlatformUserId: "200000000002",
      linkedUserId: PARENT_B_USER_ID,
      linkedOrganizationId: ORGANIZATION_ID,
      expiresAt: expect.any(Date),
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("consumes Parent B's confirm before owner-link handling and returns redacted status", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => binding);
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...binding,
      authority_version: 8,
    }));
    const response = await groupRequest({
      actor: "Parent B",
      message: "Eliza join WXYZ2345ABCD",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_join_consented",
        consentStatus: enabledConsent,
        groupDelivery: {
          kind: "binding",
          authority: { version: 8, requiresAllAdultsConsent: false },
        },
      },
    });
    expect(consumeJoinConfirmChallenge).toHaveBeenCalledWith({
      codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceMessageId: "telegram:group:parent-b",
      bindingId: BINDING_ID,
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:parent-a-bot",
      providerChatId: "-100000000001",
      providerThreadId: PROVIDER_THREAD_ID,
      actorPlatformUserId: "200000000002",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("attests Child C and blocks a restricted ordinary turn before capabilities", async () => {
    const order: string[] = [];
    recordGroupParticipantTurn.mockImplementationOnce(async () => {
      order.push("record");
      const actor = {
        platformUserId: "300000000003",
        ordinal: 3,
        displayName: "Child C",
      };
      return { actor, roster: [actor] };
    });
    deriveConsentStatus.mockImplementationOnce(async () => {
      order.push("derive");
      return {
        ...restrictedConsent,
        registeredParticipantCount: 3,
        participants: [
          ...restrictedConsent.participants,
          {
            ordinal: 3,
            isOwner: false,
            linked: false,
            consented: false,
            revoked: false,
          },
        ],
      };
    });

    const response = await groupRequest({
      actor: "Child C",
      message: "Eliza plan dinner",
      invocation: "mention",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_consent_restricted",
        consentStatus: {
          registeredParticipantCount: 3,
          participants: expect.arrayContaining([
            expect.objectContaining({ ordinal: 3, linked: false }),
          ]),
        },
        groupDelivery: {
          kind: "binding",
          authority: { requiresAllAdultsConsent: false },
        },
      },
    });
    expect(order).toEqual(["record", "derive"]);
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(enrichInboundImageMedia).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("silences an all-adults Blooio forged reply before restricted-gate disclosure", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...binding,
      platform: "blooio",
      connector_account_id: "blooio:test-number",
      provider_chat_id: "synthetic-family-group",
      created_by_platform_user_id: "+15550100001",
    }));

    const response = await request({
      platform: "blooio",
      chatType: "group",
      project: "eliza-app",
      connectorAccountId: "blooio:test-number",
      chatId: "synthetic-family-group",
      actor: {
        platformUserId: "+15550100003",
        displayName: "Child C",
        role: "member",
      },
      messageId: "blooio:group:forged-reply",
      message: "following up",
      invocation: "reply",
      replyToMessageId: "unreceipted-provider-message",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_silent", reply: "" },
    });
    expect(hasDeliveryReceipt).toHaveBeenCalledWith({
      bindingId: BINDING_ID,
      providerMessageId: "unreceipted-provider-message",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("returns only redacted consent status to Parent B", async () => {
    const response = await groupRequest({
      actor: "Parent B",
      message: "Eliza consent status",
    });

    const body = (await response.json()) as {
      data: {
        code: string;
        consentStatus: unknown;
        groupDelivery: { authority: Record<string, unknown> };
      };
    };
    expect(body.data).toMatchObject({
      code: "group_consent_status",
      consentStatus: restrictedConsent,
      groupDelivery: {
        authority: { requiresAllAdultsConsent: false },
      },
    });
    const serializedStatus = JSON.stringify(body.data.consentStatus);
    expect(serializedStatus).not.toContain(PARENT_A_USER_ID);
    expect(serializedStatus).not.toContain(PARENT_B_USER_ID);
    expect(serializedStatus).not.toContain("100000000001");
    expect(serializedStatus).not.toContain("200000000002");
    expect(serializedStatus).not.toContain("Parent A");
    expect(serializedStatus).not.toContain("Parent B");
    expect(recordGroupParticipantTurn).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("records Child C without re-restricting an enabled two-adult group", async () => {
    const order: string[] = [];
    recordGroupParticipantTurn.mockImplementationOnce(async () => {
      order.push("record");
      const actor = {
        platformUserId: "300000000003",
        ordinal: 3,
        displayName: "Child C",
      };
      return { actor, roster: [actor] };
    });
    deriveConsentStatus.mockImplementationOnce(async () => {
      order.push("derive");
      return enabledConsentWithChildC;
    });
    findActivePersonalDedicatedTarget.mockImplementationOnce(async () => {
      order.push("dedicated_lookup");
      return null;
    });
    prewarmPersonalSharedAgentTurnCaches.mockImplementationOnce(async () => {
      order.push("prewarm");
    });
    sharedRestMessageSend.mockImplementationOnce(async () => {
      order.push("capability");
      return { text: "Dinner planning is ready." };
    });

    const response = await groupRequest({
      actor: "Child C",
      message: "Eliza plan dinner",
      invocation: "mention",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        reply: "Dinner planning is ready.",
        groupDelivery: {
          kind: "binding",
          authority: { requiresAllAdultsConsent: true },
        },
      },
    });
    expect(deriveConsentStatus).toHaveBeenCalledWith({ bindingId: BINDING_ID });
    expect(order).toEqual([
      "record",
      "derive",
      "dedicated_lookup",
      "prewarm",
      "capability",
    ]);
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
  });

  test("leaves consent-status text on the existing single-owner runtime path", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...binding,
      consent_mode: "single_owner",
      required_principal_count: 1,
    }));
    sharedRestMessageSend.mockImplementationOnce(async () => ({
      text: "Existing single-owner reply.",
    }));

    const response = await groupRequest({
      actor: "Parent A",
      message: "Eliza consent status",
      invocation: "mention",
    });

    const body = (await response.json()) as {
      data: {
        groupDelivery: { authority: Record<string, unknown> };
      };
    };
    expect(body).toMatchObject({
      data: {
        reply: "Existing single-owner reply.",
        groupDelivery: { kind: "binding" },
      },
    });
    expect(body.data.groupDelivery.authority).not.toHaveProperty(
      "requiresAllAdultsConsent",
    );
    expect(deriveConsentStatus).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
  });

  test("does not reserve join-code-shaped text in a single-owner group", async () => {
    resolveGroupBinding.mockImplementation(async () => ({
      ...binding,
      consent_mode: "single_owner",
      required_principal_count: 1,
    }));
    sharedRestMessageSend.mockImplementationOnce(async () => ({
      text: "Existing single-owner join reply.",
    }));

    const response = await groupRequest({
      actor: "Parent B",
      message: "Eliza join WXYZ2345ABCD",
      invocation: "mention",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        reply: "Existing single-owner join reply.",
        groupDelivery: { kind: "binding" },
      },
    });
    expect(consumeJoinConfirmChallenge).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
  });

  test("self-revokes only Parent B while retaining Parent A's binding", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => binding);
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...binding,
      authority_version: 8,
    }));
    const response = await groupRequest({
      actor: "Parent B",
      message: "Eliza leave",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_participant_revoked",
        consentStatus: consentAfterParentBLeaves,
        groupDelivery: {
          kind: "binding",
          authority: { version: 8 },
        },
      },
    });
    expect(selfRevoke).toHaveBeenCalledWith({
      bindingId: BINDING_ID,
      actorPlatformUserId: "200000000002",
    });
    expect(revokeGroupBinding).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("keeps Parent A's whole-binding leave authority unchanged", async () => {
    const response = await groupRequest({
      actor: "Parent A",
      message: "Eliza leave",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_binding_revoked",
        groupDelivery: { kind: "control" },
      },
    });
    expect(revokeGroupBinding).toHaveBeenCalledWith({
      bindingId: BINDING_ID,
      ownerUserId: PARENT_A_USER_ID,
    });
    expect(selfRevoke).not.toHaveBeenCalled();
  });
});
