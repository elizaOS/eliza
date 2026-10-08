/** Exercises the owning non-stream Hono route rather than calling the adapter directly. */
import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

const calls: unknown[][] = [];
const accountState = {
  access: "shared_fallback",
  state: "shared_active",
  reason: "billing_suspended",
  dedicatedMemory: "unavailable",
  generation: 1,
  dedicatedRetainedUntil: null,
  recoveryAction: { kind: "add_credits", path: "/cloud/billing" },
};
const agent = {
  id: "agent-fixture",
  organization_id: "org-fixture",
  user_id: "user-fixture",
  execution_tier: "shared",
};
const executionCtx = { waitUntil(_promise: Promise<unknown>) {} };
const namespace = {
  getByName() {
    throw new Error("The route must use the mocked adapter");
  },
};
mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent",
  () => ({
    resolveSharedRuntimeWorkerRequestContext: () => ({
      namespace,
      executionCtx,
    }),
    resolveSharedAgent: async () => ({
      agent,
      agentId: agent.id,
      orgId: agent.organization_id,
      agentName: "Eliza",
      agentKind: "personal",
    }),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/personal-direct-chat-route",
  () => ({
    resolveSharedSurfaceTarget: async () => ({
      ok: true,
      roomId: "scoped-fallback-room",
      accountState,
    }),
    personalDirectChatRefusalResponse: () => {
      throw new Error("Unexpected refusal");
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/shared-rest-adapter",
  () => ({
    sharedRestMessageSend: async (...args: unknown[]) => {
      calls.push(args);
      return { text: "reply", agentName: "Eliza" };
    },
    sharedRestMessagesGet: async () => {
      throw new Error("Unexpected GET");
    },
  }),
);
mock.module("../v1/eliza/agents/[agentId]/api/_local-dedicated-proxy", () => ({
  proxyLocalDedicatedOrNext: async (
    _context: unknown,
    next: () => Promise<void>,
  ) => next(),
}));
const { default: messages } = await import(
  "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/route"
);

test("non-stream Shared POST keeps account state, server trace, and the actual request signal in their authority slots", async () => {
  const app = new Hono<{ Variables: { traceId: string } }>();
  let incomingSignal: AbortSignal | undefined;
  app.use("*", async (c, next) => {
    c.set("traceId", "server-owned-trace");
    incomingSignal = c.req.raw.signal;
    await next();
  });
  app.route(
    "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages",
    messages,
  );
  const controller = new AbortController();
  const response = await app.fetch(
    new Request(
      "http://localhost/api/v1/eliza/agents/agent-fixture/api/conversations/requested-room/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          traceId: "forged-client-trace",
          trustedAccountState: "forged",
        }),
        signal: controller.signal,
      },
    ),
  );
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0, 6)).toEqual([
    agent,
    "scoped-fallback-room",
    "hello",
    "Eliza",
    executionCtx,
    namespace,
  ]);
  expect(calls[0][11]).toBe(accountState);
  expect(calls[0][12]).toBe("server-owned-trace");
  expect(calls[0][13]).toBe(incomingSignal);
  expect((calls[0][13] as AbortSignal).aborted).toBe(false);
  const reason = new DOMException("Caller stopped", "AbortError");
  controller.abort(reason);
  expect((calls[0][13] as AbortSignal).aborted).toBe(true);
  expect((calls[0][13] as AbortSignal).reason).toBe(reason);
});
