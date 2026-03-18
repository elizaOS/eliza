// @vitest-environment jsdom

import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

class ControlledWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: ControlledWebSocket[] = [];

  readonly CONNECTING = ControlledWebSocket.CONNECTING;
  readonly OPEN = ControlledWebSocket.OPEN;
  readonly CLOSED = ControlledWebSocket.CLOSED;

  readonly url: string;
  readyState = ControlledWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    ControlledWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = ControlledWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = ControlledWebSocket.OPEN;
    this.onopen?.();
  }
}

describe("ElizaClient websocket queue", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    ControlledWebSocket.instances = [];
    (window.location as { protocol?: string }).protocol = "http:";
    Object.defineProperty(globalThis, "WebSocket", {
      value: ControlledWebSocket,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: originalWebSocket,
      writable: true,
      configurable: true,
    });
  });

  it("queues outbound messages until websocket is open", () => {
    const client = new ElizaClient("http://localhost:3137");
    client.sendWsMessage({ type: "ping" });

    expect(ControlledWebSocket.instances).toHaveLength(1);
    const ws = ControlledWebSocket.instances[0];
    expect(ws.sent).toEqual([]);

    ws.open();

    expect(ws.sent).toEqual([JSON.stringify({ type: "ping" })]);
  });

  it("keeps only the newest queued active-conversation update", () => {
    const client = new ElizaClient("http://localhost:3137");
    client.sendWsMessage({
      type: "active-conversation",
      conversationId: "conv-1",
    });
    client.sendWsMessage({
      type: "active-conversation",
      conversationId: "conv-2",
    });

    expect(ControlledWebSocket.instances).toHaveLength(1);
    const ws = ControlledWebSocket.instances[0];
    ws.open();

    expect(ws.sent).toEqual([
      JSON.stringify({ type: "active-conversation", conversationId: "conv-2" }),
    ]);
  });
});
