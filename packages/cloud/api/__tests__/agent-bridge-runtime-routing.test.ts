// Exercises cloud API tests agent bridge runtime routing.test behavior with deterministic Worker route fixtures.
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

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
let canonicalStreamRoute: typeof import("../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream/route");

const originalFetch = globalThis.fetch;
const deadControlPlaneFetch = mock(async (input: RequestInfo | URL) => {
  throw new Error(`unexpected control-plane fetch: ${String(input)}`);
});

beforeAll(async () => {
  bridgeRoute = await import("../v1/eliza/agents/[agentId]/bridge/route");
  streamRoute = await import("../v1/eliza/agents/[agentId]/stream/route");
  canonicalStreamRoute = await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream/route"
  );
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
  };
}

const sharedAgent = {
  id: "agent-1",
  organization_id: "org-1",
  user_id: "user-1",
  execution_tier: "shared",
} as never;
const executionCtx = {
  waitUntil() {},
};
const TRACE_ID = "11111111-1111-4111-8111-111111111111";

describe("agent bridge runtime routing", () => {
  test("records an allow-listed bridge method and first logical attempt on early warming", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await bridgeRoute.default.request(
        "/",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ElizaOS-Turn-Correlation":
              "123e4567-e89b-42d3-a456-426614174000",
            "X-ElizaOS-Turn-Attempt": "1",
            "X-Eliza-Trace-Id": TRACE_ID,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "rpc-1",
            method: "message.send",
            params: { text: "not logged" },
          }),
        },
        staleControlPlaneContext().env,
        executionCtx as never,
      );

      expect(response.status).toBe(503);
      expect(warn).toHaveBeenCalledWith(
        "[shared-turn baseline] request completed",
        expect.objectContaining({
          traceId: TRACE_ID,
          durationMs: expect.any(Number),
          surface: "bridge",
          rpcMethod: "message.send",
          runtimeKind: "unresolved",
          status: 503,
          outcome: "other_error",
          logicalTurn: "123e4567-e89b-42d3-a456-426614174000",
          attempt: 1,
          attemptKind: "first",
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("not logged");
    } finally {
      warn.mockRestore();
    }
  });

  test("records a joinable stream trace and bounded retry attempt on early warming", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await canonicalStreamRoute.default.request(
        "/",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Trace-Id": TRACE_ID,
            "X-ElizaOS-Turn-Correlation":
              "123e4567-e89b-42d3-a456-426614174000",
            "X-ElizaOS-Turn-Attempt": "2",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "rpc-stream-1",
            method: "message.send",
            params: { text: "not logged", roomId: "room-1" },
          }),
        },
        staleControlPlaneContext().env,
        executionCtx as never,
      );

      expect(response.status).toBe(503);
      expect(warn).toHaveBeenCalledWith(
        "[shared-turn baseline] request completed",
        expect.objectContaining({
          traceId: TRACE_ID,
          durationMs: expect.any(Number),
          surface: "stream",
          rpcMethod: "message.send",
          runtimeKind: "unresolved",
          status: 503,
          outcome: "other_error",
          logicalTurn: "123e4567-e89b-42d3-a456-426614174000",
          attempt: 2,
          attemptKind: "retry",
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("not logged");
    } finally {
      warn.mockRestore();
    }
  });

  test("bridge fails closed without the conversation coordinator", async () => {
    globalThis.fetch = deadControlPlaneFetch as unknown as typeof fetch;

    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "heartbeat",
      params: {},
    };
    const response = await bridgeRoute.default.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcRequest),
      },
      staleControlPlaneContext().env,
      executionCtx as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "shared_runtime_context_unavailable",
      retryable: true,
    });
    expect(deadControlPlaneFetch).not.toHaveBeenCalled();
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("stream fails closed without the conversation coordinator", async () => {
    globalThis.fetch = deadControlPlaneFetch as unknown as typeof fetch;

    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-2",
      method: "message.send",
      params: { text: "say hello", roomId: "room-1" },
    };
    const response = await streamRoute.default.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcRequest),
      },
      staleControlPlaneContext().env,
      executionCtx as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "shared_runtime_context_unavailable",
      retryable: true,
    });
    expect(deadControlPlaneFetch).not.toHaveBeenCalled();
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
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
      {
        agent: sharedAgent,
        namespace: { getByName } as never,
        executionCtx,
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

  test("resolved Worker bridge forwards only authenticated message text as capability input", async () => {
    let coordinatorEnvelope: Record<string, unknown> | undefined;
    const fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        coordinatorEnvelope = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return Response.json({
          jsonrpc: "2.0",
          id: "rpc-grounding",
          result: { text: "grounded" },
        });
      },
    );
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-grounding",
      method: "message.send",
      params: { text: "what is the latest BTC price?" },
    };

    const response = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/bridge", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      {
        agent: sharedAgent,
        namespace: { getByName: () => ({ fetch }) } as never,
        executionCtx,
      },
    );

    expect(response.status).toBe(200);
    expect(coordinatorEnvelope).toMatchObject({
      rpc: rpcRequest,
      trustedUserUtterance: "what is the latest BTC price?",
    });
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
      {
        agent: sharedAgent,
        namespace: { getByName: () => ({ fetch }) } as never,
        executionCtx,
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
      {
        agent: sharedAgent,
        namespace: {
          getByName: () => ({
            fetch: async () => {
              throw new Error("invalid input must not dispatch");
            },
          }),
        },
        executionCtx,
      },
    );
    const invalid = await bridgeRoute.__agentBridgeTestHooks.handlePost(
      makeJsonRequest("/bridge", { jsonrpc: "1.0", method: "" }),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      {
        agent: sharedAgent,
        namespace: {
          getByName: () => ({
            fetch: async () => {
              throw new Error("invalid input must not dispatch");
            },
          }),
        },
        executionCtx,
      },
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
      {
        agent: sharedAgent,
        namespace: { getByName } as never,
        executionCtx,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("cached");
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    expect(getByName).toHaveBeenCalledWith("agent-1:room-1");
  });

  test("stream never synthesizes a legacy heartbeat fallback", async () => {
    const fetch = mock(async () => new Response(null));
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
      {
        agent: sharedAgent,
        namespace: { getByName: () => ({ fetch }) },
        executionCtx,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: error");
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("stream preserves coordinator warming as a retryable 503", async () => {
    const fetch = mock(async () =>
      Response.json(
        { error: "Conversation cache is warming. Retry shortly." },
        { status: 503 },
      ),
    );
    const rpcRequest = {
      jsonrpc: "2.0",
      id: "rpc-unavailable",
      method: "message.send",
      params: { text: "hello", roomId: "room-1" },
    };

    const response = await streamRoute.__agentStreamTestHooks.handlePost(
      makeJsonRequest("/api/v1/eliza/agents/agent-1/stream", rpcRequest),
      { params: Promise.resolve({ agentId: "agent-1" }) },
      {
        agent: sharedAgent,
        namespace: { getByName: () => ({ fetch }) },
        executionCtx,
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      retryable: true,
      error: "Conversation cache is warming. Retry shortly.",
    });
    expect(bridgeStream).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });
});
