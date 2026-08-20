/** Verifies ElizaClient websocket connection policy through the package's configured test harness. */
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}

/**
 * Unit coverage for the base client's WebSocket lifecycle and the
 * network-status-change event it emits. WebSocket stubbed, no live server.
 */

import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_STATUS_CHANGE_EVENT } from "../events";

const { isElectrobunRuntimeMock } = vi.hoisted(() => ({
  isElectrobunRuntimeMock: vi.fn(() => false),
}));

vi.mock("../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: isElectrobunRuntimeMock,
}));

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
  url: string;
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
    constructor(readonly url: string) {
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

function stubWindowProtocol(protocol: string): void {
  const jsdomWindow = window;
  const location = new Proxy(jsdomWindow.location, {
    get(target, property) {
      if (property === "protocol") return protocol;
      return Reflect.get(target, property, target);
    },
  });
  vi.stubGlobal(
    "window",
    new Proxy(jsdomWindow, {
      get(target, property) {
        if (property === "location") return location;
        return Reflect.get(target, property, target);
      },
    }),
  );
}

// Stub the page origin (protocol + host) the same-origin WS derivation reads
// when the client has no explicit base — the self-hosted "nginx in front of
// the agent on a portless HTTPS domain" shape. `origin` is derived so
// #20342's injected-vs-page origin comparison sees the same value.
function stubWindowOrigin(protocol: string, host: string): void {
  const jsdomWindow = window;
  const location = new Proxy(jsdomWindow.location, {
    get(target, property) {
      if (property === "protocol") return protocol;
      if (property === "host") return host;
      if (property === "origin") return `${protocol}//${host}`;
      return Reflect.get(target, property, target);
    },
  });
  vi.stubGlobal(
    "window",
    new Proxy(jsdomWindow, {
      get(target, property) {
        if (property === "location") return location;
        return Reflect.get(target, property, target);
      },
    }),
  );
}

describe("ElizaClient websocket connection policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetNetworkStatusForTests();
    isElectrobunRuntimeMock.mockReturnValue(false);
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

  it("opens a same-origin websocket from a portless HTTPS host in a plain browser", () => {
    // Regression (sol-dev 2026-08-05): the Capacitor synthetic-host guard was
    // unconditional, so a browser served same-origin from `https://host/` (no
    // port — nginx terminating TLS in front of the agent) silently never
    // opened /ws. REST kept working, so server-pushed WS events
    // (proactive-message: voice-turn mirrors, proactive sends) never rendered
    // live in the open thread.
    const createdUrls = stubWebSocket();
    stubWindowOrigin("https:", "sol-dev.example.test");

    const client = new ElizaClient("", "agent-token");
    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("wss://sol-dev.example.test/ws?");
    expect(createdUrls[0]).toContain("token=agent-token");
  });

  it("still skips the synthetic-host websocket on Capacitor native", () => {
    const createdUrls = stubWebSocket();
    stubWindowOrigin("https:", "myapp.app");
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });

    const client = new ElizaClient("", "agent-token");
    client.connectWs();

    // Native WebView bundle host has no server behind it — no socket attempt.
    expect(createdUrls).toEqual([]);
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

  it("uses REST-only transport for cleartext ws from a Capacitor origin", () => {
    const createdUrls = stubWebSocket();
    const client = new ElizaClient("http://127.0.0.1:31338", "agent-token");
    stubWindowProtocol("capacitor:");

    client.connectWs();

    expect(window.location.protocol).toBe("capacitor:");
    expect(createdUrls).toEqual([]);
    expect(client.getConnectionState()).toEqual({
      state: "connected",
      reconnectAttempt: 0,
      maxReconnectAttempts: 15,
      disconnectedAt: null,
    });
  });

  it("opens loopback ws from a local Android sideload renderer", () => {
    const createdUrls = stubWebSocket();
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    const client = new ElizaClient("http://127.0.0.1:31338", "agent-token");

    client.connectWs();

    expect(window.location.protocol).toBe("https:");
    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("ws://127.0.0.1:31338/ws?");
  });

  it("opens trusted private-LAN ws from a local Android sideload renderer", () => {
    const createdUrls = stubWebSocket();
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    const client = new ElizaClient("http://192.168.1.10:31338", "agent-token");

    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("ws://192.168.1.10:31338/ws?");
  });

  it("still blocks public cleartext ws from a local Android sideload renderer", () => {
    const createdUrls = stubWebSocket();
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    const client = new ElizaClient("http://203.0.113.10:31338", "agent-token");

    client.connectWs();

    expect(createdUrls).toEqual([]);
  });

  it("still opens cleartext ws from an HTTP page", () => {
    const createdUrls = stubWebSocket();
    const client = new ElizaClient("http://127.0.0.1:31338", "agent-token");
    stubWindowProtocol("http:");

    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("ws://127.0.0.1:31338/ws?");
  });

  it("still opens secure wss from a Capacitor origin", () => {
    const createdUrls = stubWebSocket();
    const client = new ElizaClient("https://agent.example.test", "agent-token");
    stubWindowProtocol("capacitor:");

    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("wss://agent.example.test/ws?");
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

  it("treats a control-plane host base as connected without opening a websocket (#18172)", () => {
    const instances = stubWebSocketWithInstances();
    // staging console — the alias Worker routes only /api*//steward* and
    // strips Connection/Upgrade, so /ws can never upgrade; dialing it burned
    // 15 reconnects and raised the fatal overlay over a working REST backend.
    const client = new ElizaClient(
      "https://staging.elizacloud.ai",
      "cloud-token",
    );
    client.connectWs();
    expect(instances).toHaveLength(0);
    expect(client.getConnectionState().state).toBe("connected");
  });

  it("covers production control-plane hosts too, not just staging", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://app.elizacloud.ai", "cloud-token");
    client.connectWs();
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
        if (i < 14) vi.runOnlyPendingTimers();
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

  it("repointBaseUrl installs the selected bearer before opening the replacement socket", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://old.example.test", "old-token");
    client.connectWs();

    client.repointBaseUrl("https://new.example.test", "new-token");

    expect(instances).toHaveLength(2);
    const replacementUrl = new URL(instances[1].url);
    expect(replacementUrl.origin).toBe("wss://new.example.test");
    expect(replacementUrl.searchParams.get("token")).toBe("new-token");
    expect(replacementUrl.searchParams.get("token")).not.toBe("old-token");
    expect(client.getRestAuthToken()).toBe("new-token");
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

  it("drops a queued frame from a socket closed by setBaseUrl", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent-a.example.test", "token");
    const handler = vi.fn();
    client.onWsEvent("agent_event", handler);
    client.connectWs();
    const staleMessage = instances[0].onmessage;

    client.setBaseUrl("https://agent-b.example.test");
    staleMessage?.({
      data: JSON.stringify({ type: "agent_event", payload: "stale" }),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(instances[0].onmessage).toBeNull();
  });

  it("rotates an open anonymous socket when an API token is installed", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test");
    client.connectWs();
    instances[0].readyState = 1;
    instances[0].onopen?.();

    client.setToken("new-token");

    expect(instances).toHaveLength(2);
    expect(instances[0].onmessage).toBeNull();
    expect(instances[1].url).toContain("token=new-token");
  });

  // --- #20342: injected __ELIZA_WS_BASE__ precedence ------------------
  // The Vite dev server injects a WS base computed from the page origin so
  // tunnels can proxy /ws. That injection is ambient: it must not pin
  // realtime to the dev origin when the user explicitly selected a remote
  // HTTP(S) agent after boot. A genuinely separate injected WS host stays
  // authoritative.
  function stubInjectedWsBase(value: string | undefined): void {
    if (value === undefined) {
      delete (window as { __ELIZA_WS_BASE__?: string }).__ELIZA_WS_BASE__;
    } else {
      (window as { __ELIZA_WS_BASE__?: string }).__ELIZA_WS_BASE__ = value;
    }
  }

  it("derives realtime from an explicitly selected remote base when the injected WS base is just the dev origin", () => {
    const createdUrls = stubWebSocket();
    // Page served by Vite at 127.0.0.1:2653; injected WS base mirrors it.
    stubWindowOrigin("http:", "127.0.0.1:2653");
    stubInjectedWsBase("ws://127.0.0.1:2653");

    const client = new ElizaClient("", "agent-token");
    client.setBaseUrl("https://agent.example.test", { persist: false });
    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("wss://agent.example.test/ws?");
    expect(createdUrls[0]).not.toContain("2653");
    stubInjectedWsBase(undefined);
  });

  it("uses the same-origin websocket proxy for an Electrobun loopback agent", () => {
    const createdUrls = stubWebSocket();
    stubWindowOrigin("http:", "127.0.0.1:2653");
    stubInjectedWsBase("ws://127.0.0.1:2653");
    isElectrobunRuntimeMock.mockReturnValue(true);

    const client = new ElizaClient("", "");
    client.setBaseUrl("http://127.0.0.1:31337", { persist: false });
    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("ws://127.0.0.1:2653/ws?");
    expect(createdUrls[0]).not.toContain("31337");
    stubInjectedWsBase(undefined);
  });

  it("keeps a genuinely separate injected WS host authoritative over an explicit HTTP base", () => {
    const createdUrls = stubWebSocket();
    // Page at the dev origin, but the injected WS base points at a real
    // separately-hosted realtime service on a different origin.
    stubWindowOrigin("http:", "127.0.0.1:2653");
    stubInjectedWsBase("wss://realtime.example.test:4443");

    const client = new ElizaClient("", "agent-token");
    client.setBaseUrl("http://127.0.0.1:31337", { persist: false });
    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("wss://realtime.example.test:4443/ws?");
    stubInjectedWsBase(undefined);
  });

  it("keeps same-origin behavior unchanged when no explicit base is set", () => {
    const createdUrls = stubWebSocket();
    stubWindowOrigin("http:", "127.0.0.1:2653");
    stubInjectedWsBase("ws://127.0.0.1:2653");

    const client = new ElizaClient("", "agent-token");
    client.connectWs();

    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain("ws://127.0.0.1:2653/ws?");
    stubInjectedWsBase(undefined);
  });
});
