// Exercises cloud API tests agent bridge runtime routing.test behavior with deterministic Worker route fixtures.
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const requireAuthOrApiKeyWithOrg =
  mock<
    () => Promise<{
      user: { id: string; organization_id: string };
    }>
  >();
const bridge =
  mock<(agentId: string, orgId: string, body: unknown) => Promise<unknown>>();
const bridgeStream =
  mock<(agentId: string, orgId: string, body: unknown) => Promise<Response>>();

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    bridge,
    bridgeStream,
  },
}));

mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));

let bridgeRoute: typeof import("../v1/eliza/agents/[agentId]/bridge/route");
let streamRoute: typeof import("../v1/eliza/agents/[agentId]/stream/route");

const originalFetch = globalThis.fetch;
const deadControlPlaneFetch = mock(async (input: RequestInfo | URL) => {
  throw new Error(`unexpected control-plane fetch: ${String(input)}`);
});

beforeAll(async () => {
  bridgeRoute = await import("../v1/eliza/agents/[agentId]/bridge/route");
  streamRoute = await import("../v1/eliza/agents/[agentId]/stream/route");
});

afterEach(() => {
  requireAuthOrApiKeyWithOrg.mockReset();
  bridge.mockReset();
  bridgeStream.mockReset();
  deadControlPlaneFetch.mockClear();
  globalThis.fetch = originalFetch;
});

function makeJsonRequest(path: string, body: unknown) {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer user-api-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function staleControlPlaneContext() {
  return {
    env: {
      CONTAINER_CONTROL_PLANE_URL: "https://dead-control-plane.test",
      CONTAINER_SIDECAR_URL: "https://dead-sidecar.test",
      HETZNER_CONTAINER_CONTROL_PLANE_URL: "https://dead-hetzner.test",
      CONTAINER_CONTROL_PLANE_TOKEN: "stale-token",
      DATABASE_URL: "postgres://stale-db",
    },
  } as never;
}

const sharedAgent = {
  id: "agent-1",
  organization_id: "org-1",
  user_id: "user-1",
  execution_tier: "shared",
} as never;

describe("agent bridge runtime routing", () => {
  test("bridge ignores stale control-plane env and uses sandbox service", async () => {
    globalThis.fetch = deadControlPlaneFetch as unknown as typeof fetch;
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
    });
    bridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { text: "pong" },
    });

    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "heartbeat",
      params: {},
    };
    const response = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/bridge", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      staleControlPlaneContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { text: "pong" },
    });
    expect(deadControlPlaneFetch).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(
      "agent-1",
      "org-1",
      rpcRequest,
      undefined,
    );
  });

  test("stream ignores stale control-plane env and uses sandbox service", async () => {
    globalThis.fetch = deadControlPlaneFetch as unknown as typeof fetch;
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
    });
    bridgeStream.mockResolvedValue(
      new Response(
        'event: done\ndata: {"messageId":"msg-1","text":"hello"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-2",
      method: "message.send",
      params: { text: "say hello", roomId: "room-1" },
    };
    const response = await streamRoute.__agentStreamTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/stream", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      staleControlPlaneContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("event: done");
    expect(deadControlPlaneFetch).not.toHaveBeenCalled();
    // 4th arg: the Workers executionCtx that defers the shared-turn billing
    // tail — this fixture has none, so the route degrades to undefined
    // (inline settlement). Mirrors the bridge (non-stream) assertion above.
    expect(bridgeStream).toHaveBeenCalledWith(
      "agent-1",
      "org-1",
      rpcRequest,
      undefined,
    );
    expect(bridge).not.toHaveBeenCalled();
  });

  test("resolved Worker bridge uses the conversation cache without a second auth lookup", async () => {
    const fetch = mock(async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "rpc-cache",
        result: { text: "cached" },
      }),
    );
    const getByName = mock(() => ({ fetch }));
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-cache",
      method: "heartbeat",
      params: {},
    };

    const response = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/bridge", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      staleControlPlaneContext(),
      {
        agent: sharedAgent,
        namespace: { getByName } as never,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { text: "cached" },
    });
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
    expect(getByName).toHaveBeenCalledWith("agent-1:default");
  });

  test("resolved Worker bridge preserves cache warming as a retryable 503", async () => {
    const fetch = mock(async () =>
      Response.json(
        {
          error: "Conversation cache is warming. Retry shortly.",
        },
        { status: 503 },
      ),
    );
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-warming",
      method: "heartbeat",
      params: {},
    };

    const response = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/bridge", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      staleControlPlaneContext(),
      {
        agent: sharedAgent,
        namespace: { getByName: () => ({ fetch }) } as never,
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      retryable: true,
      error: "Conversation cache is warming. Retry shortly.",
    });
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("bridge rejects malformed and invalid JSON-RPC input before dispatch", async () => {
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
    });
    const malformed = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      new Request("https://api.test/bridge", {
        method: "POST",
        body: "{",
      }),
      { params: Promise.resolve({ agentId: "agent-1" }) },
    );
    const invalid = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      makeJsonRequest("/bridge", { jsonrpc: "1.0", method: "" }),
      { params: Promise.resolve({ agentId: "agent-1" }) },
    );

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(bridge).not.toHaveBeenCalled();
  });

  test("resolved Worker stream uses the conversation cache without a second auth lookup", async () => {
    const fetch = mock(
      async () =>
        new Response('event: done\ndata: {"text":"cached"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const getByName = mock(() => ({ fetch }));
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-stream-cache",
      method: "message.send",
      params: { text: "say hello", roomId: "room-1" },
    };

    const response = await streamRoute.__agentStreamTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/stream", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      staleControlPlaneContext(),
      {
        agent: sharedAgent,
        namespace: { getByName } as never,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("cached");
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    expect(getByName).toHaveBeenCalledWith("agent-1:room-1");
  });

  test("stream synthesizes a deterministic fallback only after a healthy heartbeat", async () => {
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
    });
    bridgeStream.mockResolvedValue(new Response(null));
    bridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "rpc-fallback",
      result: { status: "ok" },
    });
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-fallback",
      method: "message.send",
      params: {
        text: 'Reply briefly with "fallback ok"',
        roomId: "room-1",
      },
    };

    const response = await streamRoute.__agentStreamTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/stream", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fallback ok");
    expect(bridge).toHaveBeenCalledWith(
      "agent-1",
      "org-1",
      expect.objectContaining({ method: "heartbeat" }),
    );
  });

  test("stream emits an SSE error when both the turn and heartbeat are unavailable", async () => {
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
    });
    bridgeStream.mockResolvedValue(new Response(null));
    bridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "rpc-unavailable",
      error: { code: -32000, message: "offline" },
    });
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-unavailable",
      method: "message.send",
      params: { text: "hello", roomId: "room-1" },
    };

    const response = await streamRoute.__agentStreamTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/stream", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: error");
  });
});
