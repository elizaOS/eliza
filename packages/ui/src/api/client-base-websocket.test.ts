// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}

/**
 * Unit coverage for the base client's WebSocket lifecycle and the
 * network-status-change event it emits. WebSocket stubbed, no live server.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_STATUS_CHANGE_EVENT } from "../events";
import { __resetNetworkStatusForTests, ElizaClient } from "./client-base";

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

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("ElizaClient websocket connection policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNetworkStatusForTests();
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

  it("does not open mixed-content ws from an https origin", () => {
    const createdUrls = stubWebSocket();

    const client = new ElizaClient("http://127.0.0.1:31338", "agent-token");

    client.connectWs();

    expect(window.location.protocol).toBe("https:");
    expect(createdUrls).toEqual([]);
    expect(client.getConnectionState()).toEqual({
      state: "connected",
      reconnectAttempt: 0,
      maxReconnectAttempts: 15,
      disconnectedAt: null,
    });
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

  it("replays an early shell navigation frame when the handler attaches after the frame arrives", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test", "agent-token");
    client.connectWs();

    instances[0].onmessage?.({
      data: JSON.stringify({
        type: "shell:navigate:view",
        viewId: "settings",
        viewPath: "/settings",
      }),
    });

    const received: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) => received.push(data));
    await flushMicrotasks();

    expect(received).toEqual([
      {
        type: "shell:navigate:view",
        viewId: "settings",
        viewPath: "/settings",
      },
    ]);
  });

  it("keeps an early shell navigation frame if the first handler unsubscribes before replay", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test", "agent-token");
    client.connectWs();

    instances[0].onmessage?.({
      data: JSON.stringify({
        type: "shell:navigate:view",
        viewId: "settings",
        viewPath: "/settings",
      }),
    });

    const firstHandler = vi.fn();
    const unsubscribeFirst = client.onWsEvent(
      "shell:navigate:view",
      firstHandler,
    );
    unsubscribeFirst();
    await flushMicrotasks();

    const received: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) => received.push(data));
    await flushMicrotasks();

    expect(firstHandler).not.toHaveBeenCalled();
    expect(received).toEqual([
      {
        type: "shell:navigate:view",
        viewId: "settings",
        viewPath: "/settings",
      },
    ]);
  });

  it("does not replay an early shell navigation frame after it has been delivered", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test", "agent-token");
    client.connectWs();

    instances[0].onmessage?.({
      data: JSON.stringify({
        type: "shell:navigate:view",
        viewId: "settings",
        viewPath: "/settings",
      }),
    });

    const firstReceived: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) => firstReceived.push(data));
    await flushMicrotasks();

    const secondReceived: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) =>
      secondReceived.push(data),
    );
    await flushMicrotasks();

    expect(firstReceived).toHaveLength(1);
    expect(secondReceived).toEqual([]);
  });

  it("does not replay ordinary websocket frames that arrived before a handler attached", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test", "agent-token");
    client.connectWs();

    instances[0].onmessage?.({
      data: JSON.stringify({
        type: "status",
        state: "running",
      }),
    });

    const received: Record<string, unknown>[] = [];
    client.onWsEvent("status", (data) => received.push(data));
    await flushMicrotasks();

    expect(received).toEqual([]);
  });

  it("repointBaseUrl swaps the WS to the new host seamlessly (new socket, no disconnected flap)", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://shared.example.test", "tok");
    client.connectWs();
    expect(instances).toHaveLength(1);
    // Bring the first socket up so wsHasConnectedOnce is set — repoint should
    // still come up cleanly on the new host afterward.
    instances[0].readyState = 1; // OPEN
    instances[0].onopen?.();

    const states: string[] = [];
    client.onConnectionStateChange((s) => states.push(s.state));

    client.repointBaseUrl("https://dedicated.example.test");

    // A brand-new socket is opened against the dedicated host…
    expect(instances).toHaveLength(2);
    // …and the base is now the dedicated one.
    expect(client.getBaseUrl()).toBe("https://dedicated.example.test");
    // The seamless swap must NOT surface a "disconnected" connection state
    // (that's the visible drop disconnectWs() would cause). connectWs() only
    // emits on a *changed* state, and we suppressed the old socket's onclose,
    // so no "disconnected" is reported during the re-point.
    expect(states).not.toContain("disconnected");

    // Driving the OLD (now-detached) socket's onclose must be a no-op: the
    // re-point nulled its handlers, so it can't schedule a reconnect against
    // the stale host.
    const before = instances.length;
    instances[0].onclose?.();
    expect(instances).toHaveLength(before);
  });

  it("resetConnection leaves a healthy websocket connected without a disconnected flap", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test", "agent-token");
    client.connectWs();
    expect(instances).toHaveLength(1);

    instances[0].readyState = 1; // OPEN
    instances[0].onopen?.();

    const states: string[] = [];
    client.onConnectionStateChange((s) => states.push(s.state));

    client.resetConnection();

    expect(instances).toHaveLength(1);
    expect(client.getConnectionState()).toMatchObject({
      state: "connected",
      reconnectAttempt: 0,
      disconnectedAt: null,
    });
    expect(states).not.toContain("disconnected");
  });

  it("removes a parked network-status reconnect wake on intentional disconnect", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test", "agent-token");

    client.connectWs();
    expect(instances).toHaveLength(1);

    document.dispatchEvent(
      new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
        detail: { connected: false },
      }),
    );
    instances[0].onclose?.();

    client.disconnectWs();
    document.dispatchEvent(
      new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
        detail: { connected: true },
      }),
    );

    expect(instances).toHaveLength(1);
    expect(client.getConnectionState().state).toBe("disconnected");
  });
});
