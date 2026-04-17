/**
 * Device-bridge tests focus on behaviour that doesn't require a real
 * WebSocket: connection registration, scoring, routing, orphan rerouting,
 * and the durable pending-requests log.
 *
 * We drive the bridge through its private `handleConnection` path by
 * building a fake MinimalWebSocket that captures sent frames in a queue
 * and exposes fire() methods to simulate the other side talking back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceBridge } from "./device-bridge";

type FrameHandler = (data: string) => void;
type CloseHandler = () => void;
type ErrorHandler = (err: Error) => void;

interface FakeSocket {
  readyState: number;
  sent: string[];
  messageHandler: FrameHandler | null;
  closeHandler: CloseHandler | null;
  errorHandler: ErrorHandler | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: unknown) => void;
  fireMessage: (data: string) => void;
  fireClose: () => void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: 1, // OPEN
    sent: [],
    messageHandler: null,
    closeHandler: null,
    errorHandler: null,
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
      this.closeHandler?.();
    },
    on(event, listener) {
      if (event === "message") this.messageHandler = listener as FrameHandler;
      else if (event === "close") this.closeHandler = listener as CloseHandler;
      else if (event === "error") this.errorHandler = listener as ErrorHandler;
    },
    fireMessage(data) {
      this.messageHandler?.(data);
    },
    fireClose() {
      this.closeHandler?.();
    },
  };
  return socket;
}

// Private `handleConnection` access — we attach a helper to the bridge
// via a subclass so the test stays inside the module boundary.
class TestBridge extends DeviceBridge {
  connect(socket: FakeSocket, url = "http://a/api/local-inference/device-bridge"): void {
    // @ts-expect-error — intentionally calling the private method.
    this.handleConnection(
      socket,
      { OPEN: 1, CLOSED: 3 },
      new URL(url),
    );
  }
}

async function register(
  bridge: TestBridge,
  socket: FakeSocket,
  registration: {
    deviceId: string;
    platform: "ios" | "android" | "desktop" | "electrobun";
    totalRamGb: number;
    vramGb?: number;
    loadedPath?: string | null;
    deviceModel?: string;
  },
): Promise<void> {
  bridge.connect(socket);
  const gpu = registration.vramGb
    ? {
        backend: "metal" as const,
        available: true,
        totalVramGb: registration.vramGb,
      }
    : null;
  socket.fireMessage(
    JSON.stringify({
      type: "register",
      payload: {
        deviceId: registration.deviceId,
        capabilities: {
          platform: registration.platform,
          deviceModel: registration.deviceModel ?? registration.platform,
          totalRamGb: registration.totalRamGb,
          cpuCores: 8,
          gpu,
        },
        loadedPath: registration.loadedPath ?? null,
      },
    }),
  );
}

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((raw) => {
    const parsed = JSON.parse(raw) as { type: string };
    return parsed.type;
  });
}

function lastFrame(socket: FakeSocket): { [k: string]: unknown } {
  const last = socket.sent[socket.sent.length - 1];
  if (!last) throw new Error("no frames sent");
  return JSON.parse(last) as { [k: string]: unknown };
}

describe("DeviceBridge", () => {
  let bridge: TestBridge;
  let origStateDir: string | undefined;

  beforeEach(() => {
    origStateDir = process.env.ELIZA_STATE_DIR;
    // Isolate the pending-requests.json log to a temp root so tests don't
    // leak state across each other or into the developer's real state dir.
    process.env.ELIZA_STATE_DIR = `/tmp/milady-bridge-test-${Date.now()}-${Math.random()}`;
    bridge = new TestBridge();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = origStateDir;
    }
  });

  describe("scoring + status()", () => {
    it("reports a single device as primary", async () => {
      const sock = fakeSocket();
      await register(bridge, sock, {
        deviceId: "phone-1",
        platform: "ios",
        totalRamGb: 8,
      });
      const status = bridge.status();
      expect(status.connected).toBe(true);
      expect(status.devices.length).toBe(1);
      expect(status.primaryDeviceId).toBe("phone-1");
      expect(status.devices[0]?.isPrimary).toBe(true);
    });

    it("prefers a desktop over a phone with realistic RAM numbers", async () => {
      // Phone: 8 GB iOS (ios base 10 + 8*2 = 26). Mac: 32 GB desktop
      // (desktop base 100 + 32*2 = 164). Desktop wins comfortably.
      const phone = fakeSocket();
      await register(bridge, phone, {
        deviceId: "phone",
        platform: "ios",
        totalRamGb: 8,
      });
      const desktop = fakeSocket();
      await register(bridge, desktop, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 32,
      });

      const status = bridge.status();
      expect(status.primaryDeviceId).toBe("mac");
      expect(status.devices[0]?.deviceId).toBe("mac");
    });

    it("lets an absurdly RAM-rich phone outscore a small desktop", async () => {
      // This is the deliberate flip: scoring treats RAM linearly, so if
      // somehow a phone has vastly more RAM than a desktop (hypothetical
      // future hardware) it takes precedence. The rule isn't "desktop
      // always wins" — it's "biggest effective compute pool wins".
      const phone = fakeSocket();
      await register(bridge, phone, {
        deviceId: "beast-phone",
        platform: "ios",
        totalRamGb: 128,
      });
      const desktop = fakeSocket();
      await register(bridge, desktop, {
        deviceId: "small-mac",
        platform: "desktop",
        totalRamGb: 8,
      });
      expect(bridge.status().primaryDeviceId).toBe("beast-phone");
    });

    it("GPU VRAM boosts score significantly", async () => {
      const cpuDesktop = fakeSocket();
      await register(bridge, cpuDesktop, {
        deviceId: "cpu-only",
        platform: "desktop",
        totalRamGb: 32,
      });
      const gpuDesktop = fakeSocket();
      await register(bridge, gpuDesktop, {
        deviceId: "gpu",
        platform: "desktop",
        totalRamGb: 16,
        vramGb: 24,
      });
      // cpu-only: 100 + 32*2 + 0 = 164. gpu: 100 + 16*2 + 24*5 = 252.
      expect(bridge.status().primaryDeviceId).toBe("gpu");
    });
  });

  describe("routing + reconnect", () => {
    it("routes a generate() call to the best device", async () => {
      const phone = fakeSocket();
      await register(bridge, phone, {
        deviceId: "phone",
        platform: "ios",
        totalRamGb: 8,
      });
      const mac = fakeSocket();
      await register(bridge, mac, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 16,
      });

      const pending = bridge.generate({ prompt: "hello" });
      // mac should have received the request, phone should not.
      expect(sentTypes(mac)).toContain("generate");
      expect(sentTypes(phone)).not.toContain("generate");

      // Respond from mac to resolve the promise.
      const sent = lastFrame(mac) as {
        type: string;
        correlationId: string;
      };
      mac.fireMessage(
        JSON.stringify({
          type: "generateResult",
          correlationId: sent.correlationId,
          ok: true,
          text: "world",
          promptTokens: 1,
          outputTokens: 1,
          durationMs: 10,
        }),
      );
      await expect(pending).resolves.toBe("world");
    });

    it("orphans generates when the routed device drops and reroutes on a different device", async () => {
      const mac = fakeSocket();
      await register(bridge, mac, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 16,
      });
      const phone = fakeSocket();
      await register(bridge, phone, {
        deviceId: "phone",
        platform: "ios",
        totalRamGb: 8,
      });

      const pending = bridge.generate({ prompt: "x" });
      // Routed to mac.
      const macFirstFrame = lastFrame(mac) as {
        correlationId: string;
      };

      // Mac drops.
      mac.fireClose();

      // Phone should now have received the same correlation id.
      const phoneSent = phone.sent.map(
        (raw) => JSON.parse(raw) as { type: string; correlationId?: string },
      );
      const rerouted = phoneSent.find(
        (f) =>
          f.type === "generate" && f.correlationId === macFirstFrame.correlationId,
      );
      expect(rerouted).toBeDefined();

      // Phone responds.
      phone.fireMessage(
        JSON.stringify({
          type: "generateResult",
          correlationId: macFirstFrame.correlationId,
          ok: true,
          text: "answered by phone",
          promptTokens: 1,
          outputTokens: 1,
          durationMs: 10,
        }),
      );
      await expect(pending).resolves.toBe("answered by phone");
    });

    it("parks a generate when no device is connected and sends on first register", async () => {
      const pending = bridge.generate({ prompt: "q" });

      // No device yet — nothing sent.
      const mac = fakeSocket();
      await register(bridge, mac, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 16,
      });

      // mac should have received the parked request.
      const frames = sentTypes(mac);
      expect(frames.filter((t) => t === "generate").length).toBe(1);

      const cid = (lastFrame(mac) as { correlationId: string }).correlationId;
      mac.fireMessage(
        JSON.stringify({
          type: "generateResult",
          correlationId: cid,
          ok: true,
          text: "done",
          promptTokens: 1,
          outputTokens: 1,
          durationMs: 5,
        }),
      );
      await expect(pending).resolves.toBe("done");
    });

    it("times out a generate when no device ever responds", async () => {
      process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = "50";
      const freshBridge = new TestBridge();
      const pending = freshBridge.generate({ prompt: "q" });
      await expect(pending).rejects.toThrow(/DEVICE_TIMEOUT/);
      delete process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS;
    });

    it("supersedes a stale connection with the same deviceId", async () => {
      const a = fakeSocket();
      await register(bridge, a, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 16,
      });
      const b = fakeSocket();
      await register(bridge, b, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 32,
      });
      expect(a.readyState).toBe(3); // closed by supersession
      expect(bridge.status().devices.length).toBe(1);
      expect(bridge.status().devices[0]?.capabilities.totalRamGb).toBe(32);
    });
  });

  describe("pairing token", () => {
    it("rejects a register with a mismatching pairing token", async () => {
      process.env.ELIZA_DEVICE_PAIRING_TOKEN = "secret";
      const bridgeWithToken = new TestBridge();
      const sock = fakeSocket();
      bridgeWithToken.connect(
        sock,
        "http://a/api/local-inference/device-bridge?token=secret",
      );
      sock.fireMessage(
        JSON.stringify({
          type: "register",
          payload: {
            deviceId: "bad",
            pairingToken: "wrong",
            capabilities: {
              platform: "ios",
              deviceModel: "iPhone",
              totalRamGb: 8,
              cpuCores: 6,
              gpu: null,
            },
            loadedPath: null,
          },
        }),
      );
      expect(sock.readyState).toBe(3);
      expect(bridgeWithToken.status().devices.length).toBe(0);
      delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
    });
  });

  describe("currentModelPath", () => {
    it("returns the primary device's loaded path", async () => {
      const mac = fakeSocket();
      await register(bridge, mac, {
        deviceId: "mac",
        platform: "desktop",
        totalRamGb: 32,
        loadedPath: "/models/a.gguf",
      });
      expect(bridge.currentModelPath()).toBe("/models/a.gguf");
    });

    it("returns null when nothing is connected", () => {
      expect(bridge.currentModelPath()).toBeNull();
    });
  });
});
