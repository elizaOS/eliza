import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the WS reconnect logic in ElizaClient.
 *
 * We import and test the real ElizaClient class, mocking WebSocket
 * and browser globals so connectWs() and onWsEvent() can run in Node.
 */

// ---------------------------------------------------------------------------
// WebSocket stub — captures instances so tests can trigger onopen/onclose
// ---------------------------------------------------------------------------

let latestWs: {
  onopen: (() => void) | null;
  onclose: ((ev?: { code?: number }) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} | null = null;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = MockWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();

  constructor(_url: string) {
    latestWs = this;
  }
}

// Install global mocks before importing the client module
vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
    text: async () => "",
  }),
);

// Mock contract modules that api-client.ts imports from autonomous.
vi.mock("@elizaos/autonomous/contracts/drop", () => ({}));
vi.mock("@elizaos/autonomous/contracts/onboarding", () => ({}));
vi.mock("@elizaos/autonomous/contracts/verification", () => ({}));
vi.mock("@elizaos/autonomous/contracts/wallet", () => ({}));
vi.mock("@elizaos/autonomous/contracts/permissions", () => ({}));

// Provide window.location so connectWs() can build a WS URL
vi.stubGlobal("window", {
  location: { protocol: "http:", host: "localhost:2138" },
  sessionStorage: { getItem: () => null, setItem: () => {} },
  navigator: { userAgent: "" },
  __ELIZA_API_BASE__: undefined,
});

// ---------------------------------------------------------------------------
// Import the real ElizaClient
// ---------------------------------------------------------------------------

const { ElizaClient } = await import("@elizaos/app-core/api");

describe("ElizaClient WS reconnect", () => {
  let client: InstanceType<typeof ElizaClient>;

  beforeEach(() => {
    latestWs = null;
    client = new ElizaClient("http://localhost:2138");
  });

  afterEach(() => {
    client.disconnectWs();
  });

  it("does not fire ws-reconnected on first connect", () => {
    const handler = vi.fn();
    client.onWsEvent("ws-reconnected", handler);

    client.connectWs();
    // Simulate WebSocket open
    latestWs?.onopen?.();

    expect(handler).not.toHaveBeenCalled();
  });

  it("fires ws-reconnected on reconnect after first connect", () => {
    const handler = vi.fn();
    client.onWsEvent("ws-reconnected", handler);

    // First connect
    client.connectWs();
    latestWs?.onopen?.();
    expect(handler).not.toHaveBeenCalled();

    // Simulate disconnect + reconnect
    const oldWs = latestWs;
    if (oldWs) oldWs.readyState = MockWebSocket.CLOSED;
    client.connectWs();
    latestWs?.onopen?.();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws-reconnected" }),
    );
  });

  it("fires ws-reconnected on every subsequent reconnect", () => {
    const handler = vi.fn();
    client.onWsEvent("ws-reconnected", handler);

    // First connect
    client.connectWs();
    latestWs?.onopen?.();

    // Reconnect 1
    if (latestWs) latestWs.readyState = MockWebSocket.CLOSED;
    client.connectWs();
    latestWs?.onopen?.();

    // Reconnect 2
    if (latestWs) latestWs.readyState = MockWebSocket.CLOSED;
    client.connectWs();
    latestWs?.onopen?.();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("onWsEvent returns an unsubscribe function", () => {
    const handler = vi.fn();
    const unsub = client.onWsEvent("ws-reconnected", handler);

    // First connect
    client.connectWs();
    latestWs?.onopen?.();

    // Unsubscribe before reconnect
    unsub();

    if (latestWs) latestWs.readyState = MockWebSocket.CLOSED;
    client.connectWs();
    latestWs?.onopen?.();

    expect(handler).not.toHaveBeenCalled();
  });
});
