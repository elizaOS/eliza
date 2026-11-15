/**
 * A paired device that stops answering JSON heartbeats is evicted: its socket
 * is closed after three silent intervals and its outstanding request fails
 * with DEVICE_DISCONNECTED instead of waiting for the RPC deadline. A device
 * that answers each ping stays connected. Uses a real HTTP server and real
 * WebSocket clients, with a short configured heartbeat interval.
 */
import http from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const savedEnv = {
  ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
  ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
  ELIZA_DEVICE_HEARTBEAT_INTERVAL_MS:
    process.env.ELIZA_DEVICE_HEARTBEAT_INTERVAL_MS,
};

const pairingToken = "heartbeat-pairing-token";
const HEARTBEAT_INTERVAL_MS = 40;

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = pairingToken;
process.env.ELIZA_DEVICE_HEARTBEAT_INTERVAL_MS = String(HEARTBEAT_INTERVAL_MS);

const bridge = await import("./mobile-device-bridge-bootstrap");

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let server: http.Server | null = null;
let socket: WebSocket | null = null;

afterEach(async () => {
  await bridge.mobileDeviceBridge.close();
  socket?.terminate();
  socket = null;
  if (server?.listening) await new Promise((r) => server?.close(r));
  server = null;
});

function listen(target: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      const address = target.address();
      if (!address || typeof address === "string") {
        reject(new Error("Heartbeat server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectDevice(answerPings: boolean): Promise<WebSocket> {
  server = http.createServer((_req, res) => res.end("ok"));
  await bridge.attachMobileDeviceBridgeToServer(server);
  const port = await listen(server);
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=${pairingToken}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  if (answerPings) {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      }
    });
  }
  ws.send(
    JSON.stringify({
      type: "register",
      payload: {
        deviceId: answerPings ? "ponging-device" : "silent-device",
        pairingToken,
        capabilities: {
          platform: "android",
          deviceModel: "heartbeat-test",
          totalRamGb: 8,
          cpuCores: 8,
          gpu: { backend: "vulkan", available: true },
        },
        loadedPath: null,
      },
    }),
  );
  await waitFor(
    () => bridge.mobileDeviceBridge.status().connected,
    "device registration",
  );
  return ws;
}

describe("mobile device bridge heartbeat eviction", () => {
  it("closes a device that never pongs and rejects its pending request", async () => {
    socket = await connectDevice(false);
    const closed = new Promise<void>((resolve) =>
      socket?.once("close", resolve),
    );
    const startedAt = Date.now();

    const pending = bridge.mobileDeviceBridge.generate({ prompt: "hello" });
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^DEVICE_DISCONNECTED:/);
    await closed;
    // Three pings go unanswered before the fourth tick evicts the device.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      3 * HEARTBEAT_INTERVAL_MS,
    );
    expect(bridge.mobileDeviceBridge.status()).toMatchObject({
      connected: false,
      pendingRequests: 0,
    });
  });

  it("keeps a device that answers each ping", async () => {
    socket = await connectDevice(true);
    await new Promise((resolve) =>
      setTimeout(resolve, 8 * HEARTBEAT_INTERVAL_MS),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(bridge.mobileDeviceBridge.status().connected).toBe(true);
  });
});
