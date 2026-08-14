/** Proves phone and signed-in app traffic converge on one rowless personal Eliza transcript. */

import { beforeEach, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

const transcripts = new Map<string, StoredMessage[]>();
const addressedAgentIds: string[] = [];

const findOrCreateByPhone = mock(async () => ({
  user: { id: USER_ID },
  organization: { id: ORGANIZATION_ID },
  isNew: true,
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORGANIZATION_ID,
  organization: { id: ORGANIZATION_ID },
}));
const sharedRestMessageSend = mock(
  async (agent: { id: string }, roomId: string, text: string) => {
    expect(roomId).toBe(agent.id);
    addressedAgentIds.push(agent.id);
    const messages = transcripts.get(agent.id) ?? [];
    const sequence = messages.length;
    messages.push(
      {
        id: `user-${sequence}`,
        role: "user",
        text,
        timestamp: sequence + 1,
      },
      {
        id: `assistant-${sequence}`,
        role: "assistant",
        text: `Eliza remembers: ${text}`,
        timestamp: sequence + 2,
      },
    );
    transcripts.set(agent.id, messages);
    return { text: `Eliza remembers: ${text}`, agentName: "Eliza" };
  },
);
const sharedRestMessagesGet = mock(async (agentId: string, roomId: string) => {
  expect(roomId).toBe(agentId);
  addressedAgentIds.push(agentId);
  return { messages: transcripts.get(agentId) ?? [] };
});
const findActivePersonalDedicatedTarget = mock(async () => null);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = { waitUntil() {} };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { findOrCreateByPhone },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
  sharedRestMessagesGet,
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

const { default: phoneMessagesApp } = await import(
  "../internal/eliza-app/personal-shared/messages/route"
);
const { default: accountMessagesApp } = await import(
  "../v1/eliza/shared/messages/route"
);

const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function phoneRequest(message: string, messageId: string) {
  return phoneMessagesApp.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer internal-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "twilio",
        phoneNumber: "+15551234567",
        messageId,
        message,
      }),
    },
    {
      INTERNAL_SECRET: "internal-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
    } as never,
    executionCtx as never,
  );
}

function accountRequest(method: "GET" | "POST", body?: unknown) {
  return accountMessagesApp.request(
    "/",
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.test",
    } as never,
    executionCtx as never,
  );
}

beforeEach(() => {
  transcripts.clear();
  addressedAgentIds.length = 0;
  findOrCreateByPhone.mockClear();
  requireUserOrApiKeyWithOrg.mockClear();
  sharedRestMessageSend.mockClear();
  sharedRestMessagesGet.mockClear();
});

test("a first phone turn is immediately visible and continues in the signed-in app", async () => {
  const phoneResponse = await phoneRequest(
    "Remember that I prefer aisle seats",
    "SM-first",
  );
  expect(phoneResponse.status).toBe(200);
  const phoneBody = (await phoneResponse.json()) as {
    data: { identity: { id: string }; reply: string };
  };

  const historyResponse = await accountRequest("GET");
  expect(historyResponse.status).toBe(200);
  const historyBody = (await historyResponse.json()) as {
    data: { identity: { id: string }; messages: StoredMessage[] };
  };
  expect(historyBody.data.identity.id).toBe(phoneBody.data.identity.id);
  expect(
    historyBody.data.messages.map(({ role, text }) => ({ role, text })),
  ).toEqual([
    { role: "user", text: "Remember that I prefer aisle seats" },
    {
      role: "assistant",
      text: "Eliza remembers: Remember that I prefer aisle seats",
    },
  ]);

  const appResponse = await accountRequest("POST", {
    text: "What seat do I prefer?",
    clientMessageId: "app-1",
  });
  expect(appResponse.status).toBe(200);
  const appBody = (await appResponse.json()) as {
    data: { identity: { id: string }; reply: { text: string } };
  };
  expect(appBody.data.identity.id).toBe(phoneBody.data.identity.id);
  expect(appBody.data.reply.text).toBe(
    "Eliza remembers: What seat do I prefer?",
  );
  expect(new Set(addressedAgentIds)).toEqual(
    new Set([phoneBody.data.identity.id]),
  );
});
