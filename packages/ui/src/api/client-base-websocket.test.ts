import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";

function stubWebSocket(): string[] {
  const createdUrls: string[] = [];
  class WebSocketStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly readyState = WebSocketStub.CONNECTING;

    constructor(url: string) {
      createdUrls.push(url);
    }

    send(): void {}
  }
  vi.stubGlobal("WebSocket", WebSocketStub);
  return createdUrls;
}

describe("ElizaClient websocket connection policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats shared-runtime REST adapter bases as connected without opening a websocket", () => {
    const createdUrls = stubWebSocket();

    const client = new ElizaClient(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123",
      "cloud-token",
    );

    client.connectWs();

    expect(createdUrls).toEqual([]);
    expect(client.getConnectionState()).toEqual({
      state: "connected",
      reconnectAttempt: 0,
      maxReconnectAttempts: 15,
      disconnectedAt: null,
    });
  });

  it("also skips websocket setup for the legacy shared-runtime bridge base", () => {
    const createdUrls = stubWebSocket();

    const client = new ElizaClient(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123/bridge",
      "cloud-token",
    );

    client.connectWs();

    expect(createdUrls).toEqual([]);
    expect(client.getConnectionState().state).toBe("connected");
  });

  it("still opens a websocket for regular HTTP agent bases", () => {
    const createdUrls = stubWebSocket();

    const client = new ElizaClient("https://agent.example.test", "agent-token");

    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("wss://agent.example.test/ws?");
    expect(createdUrls[0]).toContain("token=agent-token");
  });
});
