/** Exercises trusted phone account convergence into the rowless personal Shared runtime. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const findOrCreateByPhone = mock(async () => ({
  user: { id: "00000000-0000-4000-8000-000000000002" },
  organization: { id: "00000000-0000-4000-8000-000000000001" },
  isNew: true,
}));
const sharedRestMessageSend = mock(async () => ({
  text: "hello from your personal Eliza",
  agentName: "Eliza",
}));
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = { waitUntil() {} };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { findOrCreateByPhone },
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

const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function request(body: unknown, authorization = "Bearer test-secret") {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
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

describe("trusted phone personal Shared messages", () => {
  beforeEach(() => {
    findOrCreateByPhone.mockClear();
    sharedRestMessageSend.mockClear();
  });

  test("requires internal gateway authentication", async () => {
    const response = await request(
      {
        platform: "twilio",
        phoneNumber: "+15551234567",
        messageId: "SM123",
        message: "hello",
      },
      "",
    );
    expect(response.status).toBe(401);
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
  });

  test("converges the phone account before one platform-funded rowless turn", async () => {
    const response = await request({
      platform: "twilio",
      phoneNumber: "+15551234567",
      messageId: "SM123",
      message: "hello",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string; runtime: string }; reply: string };
    };
    expect(findOrCreateByPhone).toHaveBeenCalledWith("+15551234567");
    expect(body.data.identity).toMatchObject({
      id: expect.stringMatching(/^personal:/),
      runtime: "shared",
    });
    expect(body.data.reply).toBe("hello from your personal Eliza");
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.identity.id,
        user_id: "00000000-0000-4000-8000-000000000002",
        organization_id: "00000000-0000-4000-8000-000000000001",
        execution_tier: "shared",
      }),
      body.data.identity.id,
      "hello",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "twilio:SM123",
      "platform",
    );
  });

  test("rejects non-phone platforms and malformed phone numbers before account creation", async () => {
    for (const body of [
      {
        platform: "telegram",
        phoneNumber: "+15551234567",
        messageId: "message-1",
        message: "hello",
      },
      {
        platform: "blooio",
        phoneNumber: "5551234567",
        messageId: "message-2",
        message: "hello",
      },
    ]) {
      expect((await request(body)).status).toBe(400);
    }
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
  });
});
