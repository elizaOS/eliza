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

interface FakeWs {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

// Stub that captures each created socket so a test can drive its lifecycle
// events (e.g. simulate the WS never staying open through all reconnects).
function stubWebSocketWithInstances(): FakeWs[] {
  const instances: FakeWs[] = [];
  class WebSocketStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = WebSocketStub.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(_url: string) {
      instances.push(this);
    }
    send(): void {}
    close(): void {}
  }
  vi.stubGlobal("WebSocket", WebSocketStub);
  return instances;
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

  it("treats a dedicated cloud agent base as connected without opening a websocket (its /ws is not proxied)", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient(
      "https://abc123def456.elizacloud.ai",
      "cloud-token",
    );
    client.connectWs();
    // The dedicated agent's /ws upgrade is NOT proxied by the agent-router (it
    // 404s), so we don't attempt a websocket at all — no "Reconnecting… (N/15)"
    // header churn — and report connected-over-REST immediately. (Revisit once
    // /ws is proxied + advertised via /api/config.)
    expect(instances).toHaveLength(0);
    expect(client.getConnectionState().state).toBe("connected");
  });

  it("still goes failed for a non-cloud agent base after WS exhaustion (overlay preserved)", () => {
    vi.useFakeTimers();
    try {
      const instances = stubWebSocketWithInstances();
      const client = new ElizaClient(
        "https://agent.example.test",
        "agent-token",
      );
      client.connectWs();
      for (let i = 0; i < 15; i++) {
        instances[instances.length - 1].onclose?.();
      }
      expect(client.getConnectionState().state).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
