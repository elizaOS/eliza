// Integration test for AinexService + actions/providers, using a mock
// bridge ws server that mimics the Python envelope contract.

import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import { stopAction, walkForwardAction, waveAction } from "../src/actions";
import { batteryProvider, robotStateProvider } from "../src/providers";
import { AinexService } from "../src/service";

interface FakeRuntime {
  service: AinexService | null;
  settings: Record<string, string>;
}

function buildRuntime(): IAgentRuntime {
  const state: FakeRuntime = { service: null, settings: {} };
  // Minimal IAgentRuntime fake with only the methods actions/providers reach for.
  const runtime: Partial<IAgentRuntime> = {
    agentId: "test-agent" as IAgentRuntime["agentId"],
    getSetting: (key: string) => state.settings[key] ?? null,
    getService: <T>(_serviceType: string) => state.service as unknown as T,
  };
  return Object.assign(runtime, { __state: state }) as IAgentRuntime;
}

async function buildBridgeServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  const sockets: WsWebSocket[] = [];
  const received: Array<{ command: string; payload: Record<string, unknown> }> =
    [];

  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: "event",
        event: "session.hello",
        timestamp: new Date().toISOString(),
        backend: "test",
        data: {},
      }),
    );
    socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type !== "command") return;
      received.push({ command: parsed.command, payload: parsed.payload });
      socket.send(
        JSON.stringify({
          type: "response",
          request_id: parsed.request_id,
          timestamp: new Date().toISOString(),
          ok: true,
          backend: "test",
          message: "ok",
          data: {},
        }),
      );
    });
  });

  return {
    url,
    received,
    emit(event: string, data: Record<string, unknown>) {
      const frame = JSON.stringify({
        type: "event",
        event,
        timestamp: new Date().toISOString(),
        backend: "test",
        data,
      });
      for (const s of sockets) s.send(frame);
    },
    async close() {
      for (const s of sockets) s.close();
      await new Promise<void>((res, rej) =>
        wss.close((e) => (e ? rej(e) : res())),
      );
    },
  };
}

describe("plugin-ainex integration", () => {
  let server: Awaited<ReturnType<typeof buildBridgeServer>>;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    server = await buildBridgeServer();
    runtime = buildRuntime();
    (
      runtime as unknown as { __state: FakeRuntime }
    ).__state.settings.ELIZA_AINEX_BRIDGE_URL = server.url;
    const service = await AinexService.start(runtime);
    (runtime as unknown as { __state: FakeRuntime }).__state.service = service;
    // Give the session.hello + telemetry replay a moment to settle.
    await new Promise((r) => setTimeout(r, 30));
  });

  afterEach(async () => {
    const state = (runtime as unknown as { __state: FakeRuntime }).__state;
    await state.service?.stop();
    state.service = null;
    await server.close();
  });

  it("AINEX_WALK_FORWARD sends walk.set+walk.command:start to the bridge", async () => {
    const result = await walkForwardAction.handler(
      runtime,
      {} as never,
      undefined,
      undefined,
      async () => undefined,
    );
    expect(result.success).toBe(true);

    const walkSet = server.received.find((r) => r.command === "walk.set");
    const walkStart = server.received.find(
      (r) => r.command === "walk.command" && r.payload.action === "start",
    );
    expect(walkSet).toBeDefined();
    expect(walkSet?.payload.x).toBeGreaterThan(0);
    expect(walkStart).toBeDefined();
  });

  it("AINEX_STOP sends walk.command:stop with preempt", async () => {
    server.received.length = 0;
    const result = await stopAction.handler(
      runtime,
      {} as never,
      undefined,
      undefined,
      async () => undefined,
    );
    expect(result.success).toBe(true);
    const stop = server.received.find((r) => r.command === "walk.command");
    expect(stop).toBeDefined();
    expect(stop?.payload.action).toBe("stop");
  });

  it("AINEX_WAVE sends action.play(name=wave)", async () => {
    server.received.length = 0;
    const result = await waveAction.handler(
      runtime,
      {} as never,
      undefined,
      undefined,
      async () => undefined,
    );
    expect(result.success).toBe(true);
    const wave = server.received.find((r) => r.command === "action.play");
    expect(wave).toBeDefined();
    expect(wave?.payload.name).toBe("wave");
  });

  it("robotState provider reflects basic telemetry events", async () => {
    server.emit("telemetry.basic", {
      battery_mv: 12000,
      is_walking: true,
      imu_roll: 0.01,
      imu_pitch: -0.02,
      walk_x: 0.04,
      walk_y: 0,
      walk_yaw: 0,
      walk_speed: 2,
      walk_height: 0.036,
      head_pan: 0,
      head_tilt: 0,
      joint_positions: { r_hip_pitch: 0.1 },
    });
    await new Promise((r) => setTimeout(r, 30));

    const result = await robotStateProvider.get(
      runtime,
      {} as never,
      {} as never,
    );
    expect(result.values?.ainexConnected).toBe(true);
    expect(result.values?.isWalking).toBe(true);
    expect(result.text).toContain("walking: yes");
  });

  it("battery provider reports voltage + percent + low flag", async () => {
    server.emit("telemetry.basic", {
      battery_mv: 6500,
      is_walking: false,
      imu_roll: 0,
      imu_pitch: 0,
      walk_x: 0,
      walk_y: 0,
      walk_yaw: 0,
      walk_speed: 0,
      walk_height: 0,
      head_pan: 0,
      head_tilt: 0,
      joint_positions: {},
    });
    await new Promise((r) => setTimeout(r, 30));

    const result = await batteryProvider.get(runtime, {} as never, {} as never);
    expect(result.values?.ainexConnected).toBe(true);
    expect(result.values?.batteryLow).toBe(true);
    expect(result.text).toContain("LOW");
  });
});
