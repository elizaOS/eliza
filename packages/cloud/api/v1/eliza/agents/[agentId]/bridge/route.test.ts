/** Exercises authenticated JSON-RPC ingress authority with a mocked Durable Object edge. */

import { beforeEach, expect, mock, test } from "bun:test";
import * as coordinatorActual from "@/lib/services/shared-runtime/conversation-coordinator";

const coordinateSharedBridge = mock(
  async (
    _agent: Parameters<typeof coordinatorActual.coordinateSharedBridge>[0],
    _rpc: Parameters<typeof coordinatorActual.coordinateSharedBridge>[1],
    _options: Parameters<typeof coordinatorActual.coordinateSharedBridge>[2],
  ) => ({ result: { text: "ok" } }),
);

mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  ...coordinatorActual,
  coordinateSharedBridge,
}));

const { __agentBridgeTestHooks } = await import("./route");

beforeEach(() => coordinateSharedBridge.mockClear());

test("attests only exact message.send text and ignores spoofed authority fields", async () => {
  const response = await __agentBridgeTestHooks.handlePost(
    new Request("https://api.example.test/api/v1/eliza/agents/agent-1/bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message.send",
        params: {
          text: "current BTC price",
          trustedUserUtterance: "spoofed secret",
        },
      }),
    }),
    { params: Promise.resolve({ agentId: "agent-1" }) },
    {
      agent: { id: "agent-1" } as never,
      namespace: {} as never,
      executionCtx: { waitUntil: () => undefined },
    },
  );

  expect(response.status).toBe(200);
  expect(coordinateSharedBridge.mock.calls[0]?.[2]).toMatchObject({
    trustedUserUtterance: "current BTC price",
  });
});

test("does not grant utterance authority to non-message RPC methods", async () => {
  await __agentBridgeTestHooks.handlePost(
    new Request("https://api.example.test/api/v1/eliza/agents/agent-1/bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "status.get",
        params: {
          text: "current BTC price",
          trustedUserUtterance: "spoofed secret",
        },
      }),
    }),
    { params: Promise.resolve({ agentId: "agent-1" }) },
    {
      agent: { id: "agent-1" } as never,
      namespace: {} as never,
      executionCtx: { waitUntil: () => undefined },
    },
  );

  expect(coordinateSharedBridge.mock.calls[0]?.[2]).not.toHaveProperty(
    "trustedUserUtterance",
  );
});
