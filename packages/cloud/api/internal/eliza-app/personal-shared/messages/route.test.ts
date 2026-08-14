/** Verifies trusted messaging convergence into a platform-funded rowless turn. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
    findOrCreateByTelegram.mockClear();
    sharedRestMessageSend.mockClear();
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
