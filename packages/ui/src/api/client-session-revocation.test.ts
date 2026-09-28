/** An authenticated socket revocation reaches the pairing owner without replaying queued sends. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];
  readyState = TestWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = TestWebSocket.CLOSED;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  TestWebSocket.instances = [];
});

describe("revoked remote WebSocket session", () => {
  it("reports the target and stops stale reconnect/queued sends", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestWebSocket);
    const client = new ElizaClient("http://10.0.0.241:31722");
    const events: Array<Record<string, unknown>> = [];
    client.onWsEvent("auth-revoked", (event) => events.push(event));
    client.connectWs();
    const socket = TestWebSocket.instances.at(-1);
    expect(socket).toBeDefined();
    if (!socket) return;
    socket.readyState = TestWebSocket.OPEN;
    socket.onopen?.();
    socket.readyState = TestWebSocket.CLOSED;
    socket.onclose?.({ code: 1008, reason: "session_revoked" });

    expect(events).toEqual([
      {
        type: "auth-revoked",
        apiBase: "http://10.0.0.241:31722",
        reason: "session_revoked",
      },
    ]);
    expect(client.getConnectionState().state).toBe("disconnected");
    vi.advanceTimersByTime(60_000);
    expect(TestWebSocket.instances).toHaveLength(1);
    client.disconnectWs();
  });
});
