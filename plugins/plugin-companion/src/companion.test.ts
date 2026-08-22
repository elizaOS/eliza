/**
 * Deterministic mock-device suite for the companion plugin. Spins up a real
 * in-process `ws` WebSocket server that impersonates the ESP32 firmware
 * (welcome/register handshake, token check, correlated commandResults,
 * events, pong keepalive) and drives the real CompanionService, actions, and
 * provider against it. No hardware, no vi.mock, no network egress.
 */
import type { AddressInfo } from "node:net";
import {
  ElizaError,
  type IAgentRuntime,
  validateActionParams,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as DeviceSocket, WebSocketServer } from "ws";
import { getCompanionStatusAction, setCompanionMoodAction } from "./actions";
import { companionDeviceProvider } from "./provider";
import { CompanionService } from "./service";

const VALID_MOODS = new Set(["happy", "sleepy", "curious"]);

interface MockDeviceOptions {
  token?: string;
  autoWelcome?: boolean;
  autoRegister?: boolean;
  registerFrame?: Record<string, unknown>;
  pong?: boolean;
  onCommand?: (frame: Record<string, unknown>, socket: DeviceSocket) => boolean;
}

interface MockDevice {
  url: string;
  sockets: DeviceSocket[];
  received: Record<string, unknown>[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function startMockDevice(options: MockDeviceOptions = {}): Promise<MockDevice> {
  const token = options.token ?? "secret";
  const wss = new WebSocketServer({ port: 0 });
  const sockets: DeviceSocket[] = [];
  const received: Record<string, unknown>[] = [];
  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://device.local");
    if (url.searchParams.get("token") !== token) {
      socket.close(4001, "bad token");
      return;
    }
    sockets.push(socket);
    let mood = "idle";
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      received.push(frame);
      if (options.onCommand?.(frame, socket)) return;
      if (frame.type === "ping") {
        if (options.pong !== false) {
          socket.send(JSON.stringify({ type: "pong", at: frame.at }));
        }
        return;
      }
      if (frame.type === "SET_MOOD") {
        const requested = String(frame.mood);
        if (!VALID_MOODS.has(requested)) {
          socket.send(
            JSON.stringify({
              type: "commandResult",
              correlationId: frame.correlationId,
              ok: false,
              error: `invalid mood: ${requested}`,
            }),
          );
          return;
        }
        mood = requested;
        socket.send(
          JSON.stringify({
            type: "commandResult",
            correlationId: frame.correlationId,
            ok: true,
            mood,
          }),
        );
        return;
      }
      if (frame.type === "GET_STATUS") {
        socket.send(
          JSON.stringify({
            type: "commandResult",
            correlationId: frame.correlationId,
            ok: true,
            mood,
            status: { uptimeSeconds: 42 },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          type: "commandResult",
          correlationId: frame.correlationId ?? "unknown",
          ok: false,
          error: "unknown-command",
        }),
      );
    });
    if (options.autoWelcome !== false) {
      socket.send(
        JSON.stringify({ type: "welcome", protocol: "eliza-companion/1" }),
      );
      if (options.autoRegister !== false) {
        socket.send(
          JSON.stringify(
            options.registerFrame ?? {
              type: "register",
              deviceId: "esp32-companion-01",
              firmware: "companion-fw 1.4.0",
              capabilities: { platform: "esp32-s3", touch: true },
            },
          ),
        );
      }
    }
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      wss.close(() => resolve());
    });
  cleanups.push(close);
  return new Promise((resolve) => {
    wss.on("listening", () => {
      const { port } = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}/api/companion/device-bridge`,
        sockets,
        received,
        close,
      });
    });
  });
}

interface StubRuntime {
  runtime: IAgentRuntime;
  reported: { scope: string; error: unknown }[];
  services: Map<string, unknown>;
}

function makeRuntime(settings: Record<string, string>): StubRuntime {
  const reported: { scope: string; error: unknown }[] = [];
  const services = new Map<string, unknown>();
  const runtime = {
    getSetting: (key: string) => settings[key] ?? null,
    reportError: (scope: string, error: unknown) => {
      reported.push({ scope, error });
    },
    getService: (type: string) => services.get(type) ?? null,
  } as unknown as IAgentRuntime;
  return { runtime, reported, services };
}

const FAST_TIMING = {
  COMPANION_PING_INTERVAL_MS: "40",
  COMPANION_PONG_TIMEOUT_MS: "60",
  COMPANION_COMMAND_TIMEOUT_MS: "400",
  COMPANION_RECONNECT_DELAY_MS: "60000",
};

async function startService(
  url: string,
  overrides: Record<string, string> = {},
): Promise<{ service: CompanionService; stub: StubRuntime }> {
  const stub = makeRuntime({
    COMPANION_WS_URL: url,
    COMPANION_PAIRING_TOKEN: "secret",
    ...FAST_TIMING,
    ...overrides,
  });
  const service = await CompanionService.start(stub.runtime);
  stub.services.set(CompanionService.serviceType, service);
  cleanups.push(() => service.stop());
  return { service, stub };
}

async function until(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("until(): condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const NO_MESSAGE = {} as never;

describe("configuration boundary", () => {
  it("fails fast without a URL or an explicit pairing token", async () => {
    const noUrl = makeRuntime({ COMPANION_PAIRING_TOKEN: "secret" });
    await expect(CompanionService.start(noUrl.runtime)).rejects.toMatchObject({
      code: "COMPANION_URL_MISSING",
    });
    const noToken = makeRuntime({ COMPANION_WS_URL: "ws://127.0.0.1:9/x" });
    await expect(CompanionService.start(noToken.runtime)).rejects.toMatchObject(
      { code: "COMPANION_TOKEN_MISSING" },
    );
  });
});

describe("handshake (UC4/UC5)", () => {
  it("completes welcome→register and records the device identity", async () => {
    const device = await startMockDevice();
    const { service } = await startService(device.url);
    await until(() => service.isReady());
    const snapshot = service.snapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.deviceId).toBe("esp32-companion-01");
    expect(snapshot.firmware).toBe("companion-fw 1.4.0");
    expect(snapshot.capabilities).toMatchObject({ platform: "esp32-s3" });
  });

  it("rejects a wrong pairing token and fails commands closed", async () => {
    const device = await startMockDevice({ token: "other-token" });
    const { service } = await startService(device.url);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(service.isReady()).toBe(false);
    await expect(service.setMood("happy")).rejects.toMatchObject({
      code: "COMPANION_NOT_CONNECTED",
    });
  });

  it("sends no commands before register completes", async () => {
    const device = await startMockDevice({ autoRegister: false });
    const { service } = await startService(device.url);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.isReady()).toBe(false);
    await expect(service.setMood("happy")).rejects.toMatchObject({
      code: "COMPANION_NOT_CONNECTED",
    });
    // The device saw no host frames at all — not even a ping.
    expect(device.received).toHaveLength(0);
  });

  it("does not treat a register without deviceId as connected", async () => {
    const device = await startMockDevice({
      registerFrame: { type: "register", capabilities: {} },
    });
    const { service, stub } = await startService(device.url);
    await until(() => stub.reported.length > 0);
    expect(service.isReady()).toBe(false);
    expect(
      stub.reported.some(
        (entry) =>
          entry.error instanceof ElizaError &&
          entry.error.code === "COMPANION_BAD_FRAME",
      ),
    ).toBe(true);
  });
});

describe("commands (UC1/UC2)", () => {
  it("SET_MOOD resolves the device-confirmed mood via correlationId", async () => {
    const device = await startMockDevice();
    const { service } = await startService(device.url);
    await until(() => service.isReady());
    await expect(service.setMood("happy")).resolves.toBe("happy");
    const sent = device.received.find((frame) => frame.type === "SET_MOOD");
    expect(sent).toBeDefined();
    expect(typeof sent?.correlationId).toBe("string");
  });

  it("ignores an uncorrelated commandResult and still matches the real one", async () => {
    const device = await startMockDevice({
      onCommand: (frame, socket) => {
        if (frame.type !== "SET_MOOD") return false;
        socket.send(
          JSON.stringify({
            type: "commandResult",
            correlationId: "not-this-command",
            ok: false,
            error: "stale",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "commandResult",
            correlationId: frame.correlationId,
            ok: true,
            mood: frame.mood,
          }),
        );
        return true;
      },
    });
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());
    await expect(service.setMood("curious")).resolves.toBe("curious");
    expect(
      stub.reported.some(
        (entry) =>
          entry.error instanceof ElizaError &&
          entry.error.code === "COMPANION_UNCORRELATED_RESULT",
      ),
    ).toBe(true);
  });

  it("invalid mood is a typed rejection, not a silent idle", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());
    await expect(service.setMood("angry")).rejects.toMatchObject({
      code: "COMPANION_COMMAND_REJECTED",
    });
    const result = await setCompanionMoodAction.handler(
      stub.runtime,
      NO_MESSAGE,
      undefined,
      { parameters: { mood: "angry" } },
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("invalid mood");
  });

  it("GET_STATUS returns identity + device status and fails closed after disconnect", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());
    const status = await service.getStatus();
    expect(status.deviceId).toBe("esp32-companion-01");
    expect(status.firmware).toBe("companion-fw 1.4.0");
    expect(status.status).toMatchObject({ uptimeSeconds: 42 });

    const action = await getCompanionStatusAction.handler(
      stub.runtime,
      NO_MESSAGE,
    );
    expect(action?.success).toBe(true);
    expect(action?.text).toContain("esp32-companion-01");

    await device.close();
    await until(() => !service.isReady());
    await expect(service.getStatus()).rejects.toMatchObject({
      code: "COMPANION_NOT_CONNECTED",
    });
    const failed = await getCompanionStatusAction.handler(
      stub.runtime,
      NO_MESSAGE,
    );
    expect(failed?.success).toBe(false);
    expect(failed?.text).toContain("COMPANION_NOT_CONNECTED");
  });

  it("SET_COMPANION_MOOD without a mood parameter fails explicitly", async () => {
    const device = await startMockDevice();
    const { stub } = await startService(device.url);
    const result = await setCompanionMoodAction.handler(
      stub.runtime,
      NO_MESSAGE,
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("mood");
  });

  it("SET_COMPANION_MOOD rejects missing, non-string, and blank planner payloads", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());

    for (const parameters of [
      {},
      { mood: { name: "curious" } },
      { mood: "   " },
    ]) {
      const validation = validateActionParams(
        setCompanionMoodAction,
        parameters,
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors).not.toHaveLength(0);
      const result = await setCompanionMoodAction.handler(
        stub.runtime,
        NO_MESSAGE,
        undefined,
        { parameters },
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("requires a `mood` parameter");
    }
    expect(
      device.received.filter((frame) => frame.type === "SET_MOOD"),
    ).toHaveLength(0);
  });

  it("SET_COMPANION_MOOD accepts the canonical planner parameter envelope", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());

    expect(setCompanionMoodAction.parameters).toEqual([
      expect.objectContaining({
        name: "mood",
        required: true,
        schema: expect.objectContaining({
          type: "string",
          minLength: 1,
          pattern: "\\S",
        }),
      }),
    ]);
    const result = await setCompanionMoodAction.handler(
      stub.runtime,
      NO_MESSAGE,
      undefined,
      { parameters: { mood: " curious " } },
    );
    expect(result).toMatchObject({
      success: true,
      data: { mood: "curious" },
    });
  });
});

describe("touch events (UC3)", () => {
  it("stores the device touch event and surfaces it through the provider", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());
    device.sockets[0]?.send(
      JSON.stringify({ type: "event", event: "touch", data: { zone: "head" } }),
    );
    await until(() => service.snapshot().lastEvent?.event === "touch");
    const result = await companionDeviceProvider.get(
      stub.runtime,
      NO_MESSAGE,
      NO_MESSAGE,
    );
    expect(result.values?.companionLastEvent).toBe("touch");
    expect(result.text).toContain("lastEvent=touch");
  });

  it("mood_changed events update the tracked mood", async () => {
    const device = await startMockDevice();
    const { service } = await startService(device.url);
    await until(() => service.isReady());
    device.sockets[0]?.send(
      JSON.stringify({ type: "event", event: "mood_changed", mood: "sleepy" }),
    );
    await until(() => service.snapshot().mood === "sleepy");
    expect(service.snapshot().mood).toBe("sleepy");
  });
});

describe("keepalive (UC6)", () => {
  it("a device that answers pings stays connected across intervals", async () => {
    const device = await startMockDevice();
    const { service } = await startService(device.url);
    await until(() => service.isReady());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(service.isReady()).toBe(true);
    expect(device.received.some((frame) => frame.type === "ping")).toBe(true);
  });

  it("a stale socket (no pong) marks disconnected and rejects commands", async () => {
    const device = await startMockDevice({ pong: false });
    const { service } = await startService(device.url);
    await until(() => service.isReady());
    await until(() => !service.isReady());
    await expect(service.setMood("happy")).rejects.toMatchObject({
      code: "COMPANION_NOT_CONNECTED",
    });
  });
});

describe("resilience (UC7)", () => {
  it("survives malformed JSON and unknown frames; commands still work", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());
    device.sockets[0]?.send("{ not json");
    device.sockets[0]?.send(JSON.stringify({ type: "mystery", x: 1 }));
    await until(() => stub.reported.length >= 2);
    expect(service.isReady()).toBe(true);
    await expect(service.setMood("sleepy")).resolves.toBe("sleepy");
  });

  it("provider reports disconnected state distinctly", async () => {
    const device = await startMockDevice();
    const { service, stub } = await startService(device.url);
    await until(() => service.isReady());
    await device.close();
    await until(() => !service.isReady());
    const result = await companionDeviceProvider.get(
      stub.runtime,
      NO_MESSAGE,
      NO_MESSAGE,
    );
    expect(result.values?.companionConnected).toBe(false);
    expect(result.text).toContain("disconnected");
    void service;
  });
});
