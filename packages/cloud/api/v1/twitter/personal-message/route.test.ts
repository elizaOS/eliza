/**
 * Exercises the authenticated X personal-DM boundary with mocked identity and
 * delivery services, including recipient-account spoof rejection.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-a",
  organization_id: "org-a",
}));
const getStoredConnectionIdentity = mock(async () => ({
  username: "elizamakesmagic",
  twitterUserId: "222",
}));
const findOrCreateXPersonalAccount = mock(async () => ({
  user: { id: "personal-user" },
  organization: { id: "personal-org" },
  isNew: false,
}));
const deliverPersonalTextMessage = mock(async () => ({
  success: true as const,
  identity: {
    id: "personal-shared-agent",
    runtime: "dedicated" as const,
    activeAgentId: "dedicated-agent",
  },
  account: { userId: "personal-user", organizationId: "personal-org" },
  reply: "Personal reply",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: { getStoredConnectionIdentity },
}));
mock.module("@/lib/services/eliza-app/x-personal-identity", () => ({
  findOrCreateXPersonalAccount,
}));
mock.module("@/lib/services/personal-message-delivery", () => ({
  deliverPersonalTextMessage,
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace: { getByName: mock(() => ({ fetch: mock() })) },
    executionCtx: { waitUntil: mock() },
  }),
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/twitter/personal-message", route);

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request(
    "https://api.example.test/api/v1/twitter/personal-message",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientTwitterUserId: "222",
        senderTwitterUserId: "111",
        senderUsername: "alice",
        displayName: "Alice",
        dmEventId: "501",
        message: "hello",
        ...overrides,
      }),
    },
  );
}

describe("POST /api/v1/twitter/personal-message", () => {
  beforeEach(() => {
    getStoredConnectionIdentity.mockClear();
    findOrCreateXPersonalAccount.mockClear();
    deliverPersonalTextMessage.mockClear();
  });

  test("routes a verified sender and preserves Dedicated identity", async () => {
    const response = await app.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        identity: { runtime: "dedicated", activeAgentId: "dedicated-agent" },
        reply: "Personal reply",
      },
    });
    expect(findOrCreateXPersonalAccount).toHaveBeenCalledWith({
      twitterUserId: "111",
      username: "alice",
      displayName: "Alice",
    });
    expect(deliverPersonalTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "x-dm:501",
        platform: "x",
      }),
    );
  });

  test("rejects a recipient not owned by the authenticated organization", async () => {
    const response = await app.fetch(
      request({ recipientTwitterUserId: "999" }),
    );

    expect(response.status).toBe(403);
    expect(findOrCreateXPersonalAccount).not.toHaveBeenCalled();
    expect(deliverPersonalTextMessage).not.toHaveBeenCalled();
  });
});
