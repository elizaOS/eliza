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
    expect(bridge).toHaveBeenCalledWith("agent-1", "org-1", rpcRequest);
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
    expect(bridgeStream).toHaveBeenCalledWith("agent-1", "org-1", rpcRequest);
    expect(bridge).not.toHaveBeenCalled();
  });
});
