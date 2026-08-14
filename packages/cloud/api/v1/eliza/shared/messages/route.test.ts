/** Verifies account-native Shared chat routing without a sandbox lookup or credit admission. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
  organization: { id: "00000000-0000-4000-8000-000000000001" },
}));
type TestMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};
const sharedRestMessagesGet = mock(
  async (): Promise<{ messages: TestMessage[] }> => ({ messages: [] }),
);
const sharedRestMessageSend = mock(async () => ({
  text: "hello back",
  agentName: "Eliza",
}));
type ActiveDedicatedTarget = {
  id: string;
  agent_name: string;
  bridge_url: string;
  headscale_ip: null;
};
const findActivePersonalDedicatedTarget = mock(
  async (): Promise<ActiveDedicatedTarget | null> => null,
);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = { waitUntil() {} };

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessagesGet,
  sharedRestMessageSend,
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: runtimeExecutionCtx,
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: mock(() => undefined) },
}));

const { default: app } = await import("./route");

const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function request(method: "GET" | "POST", body?: unknown) {
  return app.request(
    "/",
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.test",
    } as never,
    executionCtx as never,
  );
}

describe("personal Shared messages route", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    sharedRestMessagesGet.mockClear();
    sharedRestMessageSend.mockClear();
    findActivePersonalDedicatedTarget.mockReset();
    findActivePersonalDedicatedTarget.mockResolvedValue(null);
  });

  test("returns one deterministic account identity and its durable history", async () => {
    sharedRestMessagesGet.mockResolvedValueOnce({
      messages: [
        { id: "m1", role: "assistant", text: "welcome back", timestamp: 1 },
      ],
    });

    const response = await request("GET");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string }; messages: unknown[] };
    };
    expect(body.data.identity).toMatchObject({
      displayName: "Eliza",
      runtime: "shared",
    });
    expect(body.data.messages).toHaveLength(1);
    expect(sharedRestMessagesGet).toHaveBeenCalledWith(
      body.data.identity.id,
      body.data.identity.id,
      namespace,
    );
  });

  test("sends through the personal envelope with platform funding", async () => {
    const response = await request("POST", {
      text: "hello",
      clientMessageId: "client-1",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string }; reply: { text: string } };
    };
    expect(body.data.reply.text).toBe("hello back");
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.identity.id,
        agent_name: "Eliza",
        execution_tier: "shared",
      }),
      body.data.identity.id,
      "hello",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "client-1",
      "platform",
    );
  });

  test("rejects malformed messages before the runtime", async () => {
    const response = await request("POST", { text: " " });
    expect(response.status).toBe(400);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("returns the active Dedicated identity and refuses to split a new turn into Shared", async () => {
    findActivePersonalDedicatedTarget.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      agent_name: "Eliza",
      bridge_url: "https://personal.cloud.test/chat",
      headscale_ip: null,
    });

    const history = await request("GET");
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      data: {
        identity: {
          runtime: "dedicated",
          activeAgentId: "11111111-1111-4111-8111-111111111111",
          apiBase: "https://11111111-1111-4111-8111-111111111111.cloud.test",
        },
      },
    });

    const send = await request("POST", { text: "continue here" });
    expect(send.status).toBe(409);
    expect(await send.json()).toMatchObject({
      code: "personal_eliza_dedicated",
      data: { identity: { runtime: "dedicated" } },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });
});
