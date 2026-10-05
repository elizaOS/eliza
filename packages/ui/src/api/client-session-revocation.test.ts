/** A paired session revocation reaches the pairing owner over WebSocket or REST. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
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
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  TestWebSocket.instances = [];
});

it("treats a final 401 for the exact paired remote bearer as revocation", async () => {
  const base = "http://10.0.0.241:31725";
  savePersistedActiveServer(
    createPersistedActiveServer({
      kind: "remote",
      apiBase: base,
      accessToken: "paired-machine-session",
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  const client = new ElizaClient(base);
  client.setToken("paired-machine-session");
  const events: Array<Record<string, unknown>> = [];
  client.onWsEvent("auth-revoked", (event) => events.push(event));
  await expect(client.rawRequest("/api/status")).rejects.toMatchObject({
    status: 401,
  });
  expect(events).toEqual([
    { type: "auth-revoked", apiBase: base, reason: "session_invalid" },
  ]);
});

it("does not mistake a feature denial or changed saved authority for revocation", async () => {
  const base = "http://10.0.0.241:31725";
  savePersistedActiveServer(
    createPersistedActiveServer({
      kind: "remote",
      apiBase: base,
      accessToken: "paired-machine-session",
    }),
  );
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const client = new ElizaClient(base);
  client.setToken("paired-machine-session");
  const events: Array<Record<string, unknown>> = [];
  client.onWsEvent("auth-revoked", (event) => events.push(event));
  await expect(client.rawRequest("/api/owner-only")).rejects.toMatchObject({
    status: 401,
  });
  fetchMock.mockImplementationOnce(
    async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
  );
  await expect(client.rawRequest("/api/status")).rejects.toMatchObject({
    status: 403,
  });
  savePersistedActiveServer(
    createPersistedActiveServer({
      kind: "remote",
      apiBase: base,
      accessToken: "different-session",
    }),
  );
  await expect(client.rawRequest("/api/status")).rejects.toMatchObject({
    status: 401,
  });
  expect(events).toEqual([]);
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
