/**
 * Exercises the real shared-agent route handler with a bodyless coordinator
 * response, proving its boundary fallback is a canonical typed SSE error.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import * as coordinatorActual from "@/lib/services/shared-runtime/conversation-coordinator";

const coordinateSharedStream = mock(
  async (
    ..._args: Parameters<typeof coordinatorActual.coordinateSharedStream>
  ) => new Response(null, { headers: { "Content-Type": "text/event-stream" } }),
);

mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  ...coordinatorActual,
  coordinateSharedStream,
}));

const { __agentStreamTestHooks } = await import("./route");

beforeEach(() => {
  coordinateSharedStream.mockClear();
});

test("bodyless coordinator responses carry the canonical error type", async () => {
  const response = await __agentStreamTestHooks.handlePost(
    new Request("https://api.example.test/api/v1/eliza/agents/agent-1/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message.send",
        params: { text: "hello" },
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
  const body = await response.text();
  expect(body).toContain("event: error");
  const data = JSON.parse(
    body.split("data: ")[1]?.split("\n")[0] ?? "{}",
  ) as Record<string, unknown>;
  expect(data).toEqual({
    message: "Sandbox is not running or unreachable",
    type: "error",
  });
});

test("forwards the rowless personal envelope to the coordinator", async () => {
  await __agentStreamTestHooks.handlePost(
    new Request(
      "https://api.example.test/api/v1/eliza/agents/personal%3Aidentity/stream",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message.send",
          params: { text: "hello" },
        }),
      },
    ),
    { params: Promise.resolve({ agentId: "personal:identity" }) },
    {
      agent: { id: "personal:identity" } as never,
      agentKind: "personal",
      namespace: {} as never,
      executionCtx: { waitUntil: () => undefined },
    },
  );

  expect(coordinateSharedStream).toHaveBeenCalledTimes(1);
  expect(coordinateSharedStream.mock.calls[0]?.[2]).toMatchObject({
    agentKind: "personal",
    trustedUserUtterance: "hello",
  });
});
