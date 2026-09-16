/** Red/green route proof for the explicit all-adults owner claim command. */

import { beforeEach, expect, mock, test } from "bun:test";

const issueGroupClaim = mock(async () => undefined);
const resolvePersonalDelivery = mock(async () => ({
  userId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  dedicatedTarget: null,
  isNew: false,
  resolution: "synthetic-parent-a" as const,
}));
const findActivePersonalDedicatedTarget = mock(async () => null);
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const sharedRestMessageSend = mock(async () => ({ text: "unexpected" }));
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const { sharedTurnServerTiming } = await import(
  "@/lib/services/shared-runtime/shared-rest-adapter"
);
class StubPersonalSharedGroupDeliveryPendingError extends Error {}

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { resolvePersonalDelivery },
}));
mock.module("@/db/repositories/personal-shared-groups", () => ({
  PersonalSharedGroupDeliveryPendingError:
    StubPersonalSharedGroupDeliveryPendingError,
  personalSharedGroupsRepository: { issueClaim: issueGroupClaim },
}));
mock.module("@/db/repositories/personal-shared-group-consent", () => ({
  personalSharedGroupConsentRepository: {},
}));
mock.module("@/db/repositories/personal-shared-group-participants", () => ({
  personalSharedGroupParticipantsRepository: {},
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
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: { waitUntil() {} },
  }),
}));

const { default: app } = await import("./route");

function request(
  message: string,
  messageId: string,
  allAdultsEnabled = "true",
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "telegram",
        project: "eliza-app",
        connectorAccountId: "telegram:parent-a-bot",
        chatId: "100000000001",
        telegramUserId: "100000000001",
        displayName: "Parent A",
        messageId,
        message,
      }),
    },
    {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      ELIZA_APP_PERSONAL_SHARED_ALL_ADULTS_ENABLED: allAdultsEnabled,
      ELIZA_APP_PERSONAL_SHARED_JOIN_CODE_SECRET:
        "synthetic-personal-shared-join-code-secret-v1",
    } as never,
    { waitUntil() {}, passThroughOnException() {}, props: {} } as never,
  );
}

beforeEach(() => {
  issueGroupClaim.mockClear();
  resolvePersonalDelivery.mockClear();
  findActivePersonalDedicatedTarget.mockClear();
  prewarmPersonalSharedAgentTurnCaches.mockClear();
  sharedRestMessageSend.mockClear();
});

test("binds an omitted all-adults count as two without entering a runtime", async () => {
  const response = await request(
    "/group all-adults",
    "telegram:parent-a:all-adults-default",
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    success: true,
    data: {
      code: "group_claim_issued",
      reply: expect.stringMatching(
        /all-adults consent for 2 independently authenticated participants[\s\S]*plaintext messages and attachments transit the configured relay provider/i,
      ),
    },
  });
  expect(issueGroupClaim).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerUserId: "00000000-0000-4000-8000-000000000002",
      issuedToPlatformUserId: "100000000001",
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
      codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }),
  );
  expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
  expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  expect(sharedRestMessageSend).not.toHaveBeenCalled();
});

test("passes an explicit natural-language all-adults count through the claim", async () => {
  const response = await request(
    "Eliza group all adults 3",
    "telegram:parent-a:all-adults-three",
  );

  expect(response.status).toBe(200);
  expect(issueGroupClaim).toHaveBeenCalledWith(
    expect.objectContaining({
      consentMode: "all_adults",
      requiredPrincipalCount: 3,
    }),
  );
  expect(sharedRestMessageSend).not.toHaveBeenCalled();
});

test("fails closed while all-adults issuance is not explicitly enabled", async () => {
  const response = await request(
    "/group all-adults 2",
    "telegram:parent-a:all-adults-disabled",
    "false",
  );

  await expect(response.json()).resolves.toMatchObject({
    success: true,
    data: {
      code: "group_all_adults_unavailable",
      reply: expect.stringMatching(
        /not enabled[\s\S]*no group link was created/i,
      ),
    },
  });
  expect(issueGroupClaim).not.toHaveBeenCalled();
  expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
  expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  expect(sharedRestMessageSend).not.toHaveBeenCalled();
});

test("asks a provisional owner to authenticate without issuing a claim", async () => {
  issueGroupClaim.mockImplementationOnce(async () => {
    throw Object.assign(new Error("synthetic independent-auth boundary"), {
      code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
    });
  });

  const response = await request(
    "/group all-adults",
    "telegram:parent-a:all-adults-auth-required",
  );

  await expect(response.json()).resolves.toMatchObject({
    success: true,
    data: {
      code: "group_claim_authentication_required",
      reply: expect.stringMatching(
        /finish signing in to your own Eliza account/i,
      ),
    },
  });
  expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
  expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
  expect(sharedRestMessageSend).not.toHaveBeenCalled();
});
