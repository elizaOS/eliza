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

  it("degrades a dedicated cloud agent to connected-over-REST after WS exhaustion (no disconnect overlay)", () => {
    vi.useFakeTimers();
    try {
      const instances = stubWebSocketWithInstances();
      const client = new ElizaClient(
        "https://abc123def456.elizacloud.ai",
        "cloud-token",
      );
      client.connectWs();
      // It DID attempt a websocket (dedicated agents have a usable /ws).
      expect(instances).toHaveLength(1);
      // Simulate the socket never staying open through every reconnect attempt.
      for (let i = 0; i < 15; i++) {
        instances[instances.length - 1].onclose?.();
      }
      const state = client.getConnectionState();
      expect(state.reconnectAttempt).toBeGreaterThanOrEqual(15);
      // Instead of "failed" (which drives the full-screen "Lost backend
      // connection" overlay) it degrades to a non-fatal connected state so REST
      // chat keeps working and the WS keeps probing in the background.
      expect(state.state).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
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
