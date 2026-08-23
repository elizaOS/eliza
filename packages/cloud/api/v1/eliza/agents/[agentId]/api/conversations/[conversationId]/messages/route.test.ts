/**
 * Exercises the standard app message route with a rowless personal identity,
 * proving it retains platform-funded admission instead of org credit billing.
 */

import { expect, mock, test } from "bun:test";

const personalAgent = {
  id: "personal:identity",
  organization_id: "org-1",
  user_id: "user-1",
  agent_name: "Eliza",
  execution_tier: "shared",
};
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const executionCtx = { waitUntil() {} };
const sharedRestMessageSend = mock(async () => ({
  text: "hello back",
  agentName: "Eliza",
}));

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedAgent: mock(async () => ({
    agent: personalAgent,
    agentId: personalAgent.id,
    orgId: personalAgent.organization_id,
    agentName: "Eliza",
    agentKind: "personal",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  })),
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx,
  }),
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessagesGet: mock(async () => ({ messages: [] })),
  sharedRestMessageSend,
}));
mock.module("@/lib/services/shared-runtime/shared-runtime-chat", () => ({
  sharedTurnClientMessageId: () => "client-1",
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: mock(() => undefined) },
}));

const { default: app } = await import("./route");

test("sends personal Shared turns through platform funding", async () => {
  const response = await app.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    },
    { SHARED_RUNTIME_CONVERSATIONS: namespace } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );

  expect(response.status).toBe(200);
  expect(sharedRestMessageSend).toHaveBeenCalledWith(
    personalAgent,
    personalAgent.id,
    "hello",
    "Eliza",
    executionCtx,
    namespace,
    "client-1",
    "platform",
    undefined,
    "hello",
  );
});
