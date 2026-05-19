import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import { AinexBridgeClient } from "../src/bridge-client";

interface BridgeServerHarness {
  url: string;
  close: () => Promise<void>;
  emitEvent: (event: string, data: Record<string, unknown>) => void;
  /** Set the handler used to reply to incoming CommandEnvelopes. */
  onCommand: (
    fn: (
      command: string,
      payload: Record<string, unknown>,
      request_id: string,
    ) => { ok: boolean; message?: string; data?: Record<string, unknown> } | null,
  ) => void;
  /** All commands the test server has received this run. */
  received: Array<{ command: string; payload: Record<string, unknown>; preempt: boolean }>;
}

async function startBridgeServer(): Promise<BridgeServerHarness> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}`;
  const sockets: WsWebSocket[] = [];
  const received: BridgeServerHarness["received"] = [];

  let handler: BridgeServerHarness extends { onCommand: (fn: infer H) => unknown }
    ? H
    : never = (() => ({ ok: true, message: "ok", data: {} })) as never;

  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: "event",
        event: "session.hello",
        timestamp: new Date().toISOString(),
        backend: "test",
        data: { capabilities: { walk_set: true } },
      }),
    );
    socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type !== "command") return;
      received.push({
        command: parsed.command,
        payload: parsed.payload,
        preempt: parsed.preempt === true,
      });
      const reply = handler(parsed.command, parsed.payload, parsed.request_id);
      if (reply === null) {
        // Drop the response on the floor — used to test client-side timeouts.
        return;
      }
      socket.send(
        JSON.stringify({
          type: "response",
          request_id: parsed.request_id,
          timestamp: new Date().toISOString(),
          ok: reply.ok,
          backend: "test",
          message: reply.message ?? (reply.ok ? "ok" : "error"),
          data: reply.data ?? {},
        }),
      );
    });
  });

  return {
    url,
    received,
    onCommand(fn) {
      handler = fn as typeof handler;
    },
    emitEvent(event, data) {
      const payload = JSON.stringify({
        type: "event",
        event,
        timestamp: new Date().toISOString(),
        backend: "test",
        data,
      });
      for (const s of sockets) s.send(payload);
    },
    async close() {
      for (const s of sockets) s.close();
      await new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

describe("AinexBridgeClient", () => {
  let harness: BridgeServerHarness;

  beforeEach(async () => {
    harness = await startBridgeServer();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("connects, sends a walk.set command, and resolves the response", async () => {
    const client = new AinexBridgeClient({ url: harness.url });
    await client.connect();
    expect(client.isConnected()).toBe(true);

    harness.onCommand((cmd, payload) => {
      if (cmd === "walk.set") {
        return { ok: true, message: "ok", data: { speed: payload.speed } };
      }
      return { ok: false, message: "unsupported" };
    });

    const response = await client.send("walk.set", {
      speed: 2,
      height: 0.036,
      x: 0.04,
      y: 0,
      yaw: 0,
    });

    expect(response.ok).toBe(true);
    expect(response.data.speed).toBe(2);
    expect(harness.received).toHaveLength(1);
    expect(harness.received[0]!.command).toBe("walk.set");
    expect(harness.received[0]!.payload.x).toBe(0.04);

    await client.disconnect();
  });

  it("dispatches event envelopes to per-event handlers", async () => {
    const client = new AinexBridgeClient({ url: harness.url });
    await client.connect();
    const events: Array<{ battery_mv: number }> = [];
    client.on("telemetry.basic", (env) => {
      events.push({ battery_mv: env.data.battery_mv as number });
    });

    harness.emitEvent("telemetry.basic", { battery_mv: 12000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ battery_mv: 12000 }]);

    await client.disconnect();
  });

  it("rejects sends that exceed the timeout window", async () => {
    const client = new AinexBridgeClient({
      url: harness.url,
      sendTimeoutMs: 80,
    });
    await client.connect();

    // Tell the harness to drop responses (return null) so the client's
    // sendTimeoutMs window expires.
    harness.onCommand(() => null);

    await expect(
      client.send("walk.set", { speed: 2, height: 0.036, x: 0, y: 0, yaw: 0 }),
    ).rejects.toThrow(/timeout/i);
    await client.disconnect();
  });

  it("rejects sends when disconnected", async () => {
    const client = new AinexBridgeClient({ url: harness.url });
    await client.connect();
    await client.disconnect();
    await expect(client.send("walk.command", { action: "stop" })).rejects.toThrow(
      /not connected/i,
    );
  });
});
