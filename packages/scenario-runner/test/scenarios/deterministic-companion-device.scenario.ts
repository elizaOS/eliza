/**
 * Keyless end-to-end coverage for the ESP32 companion bridge. A loopback Bun
 * WebSocket server speaks the real device protocol while the scenario runner
 * loads the production plugin into a real AgentRuntime, then invokes both
 * shipped actions through the runner's action boundary. No hardware, model, or
 * credential leaves the process.
 */
import type { AgentRuntime } from "@elizaos/core";
import companionPlugin from "@elizaos/plugin-companion";
import { scenario } from "@elizaos/scenario-runner/schema";
import { CompanionService } from "../../../../plugins/plugin-companion/src/service.ts";

const PAIRING_TOKEN = "companion-scenario-token";
const SET_MOOD = "SET_COMPANION_MOOD";
const GET_STATUS = "GET_COMPANION_STATUS";

interface HostFrame {
  type?: unknown;
  correlationId?: unknown;
  mood?: unknown;
  at?: unknown;
}

interface ScenarioServer {
  port: number;
  stop: (force?: boolean) => void;
}

interface StoppableService {
  stop: () => Promise<void>;
}

let deviceServer: ScenarioServer | null = null;
const receivedFrames: HostFrame[] = [];

function successfulAction(
  turn: {
    actionsCalled: Array<{
      actionName: string;
      result?: { success?: boolean; data?: unknown; text?: string };
    }>;
  },
  actionName: string,
): { success?: boolean; data?: unknown; text?: string } | undefined {
  return turn.actionsCalled.find((call) => call.actionName === actionName)
    ?.result;
}

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [],
  },
  id: "deterministic-companion-device",
  title: "Companion device actions cross the authenticated WebSocket bridge",
  domain: "companion",
  tags: ["companion", "esp32", "websocket", "keyless"],
  description:
    "Loads the production companion plugin, completes the device handshake, changes mood, and reads status through a loopback protocol peer.",

  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "start authenticated companion protocol peer",
      apply: async (ctx) => {
        deviceServer?.stop(true);
        receivedFrames.length = 0;
        let mood = "idle";
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, bunServer) {
            const url = new URL(request.url);
            if (url.searchParams.get("token") !== PAIRING_TOKEN) {
              return new Response("unauthorized", { status: 401 });
            }
            if (bunServer.upgrade(request)) return undefined;
            return new Response("WebSocket upgrade required", { status: 426 });
          },
          websocket: {
            open(socket) {
              socket.send(
                JSON.stringify({
                  type: "welcome",
                  protocol: "eliza-companion/1",
                }),
              );
              socket.send(
                JSON.stringify({
                  type: "register",
                  deviceId: "scenario-esp32",
                  firmware: "scenario-fw 1.0.0",
                  capabilities: { platform: "esp32-s3", touch: true },
                }),
              );
            },
            message(socket, message) {
              const frame = JSON.parse(String(message)) as HostFrame;
              receivedFrames.push(frame);
              if (frame.type === "ping") {
                socket.send(JSON.stringify({ type: "pong", at: frame.at }));
                return;
              }
              if (frame.type === "SET_MOOD") {
                mood = String(frame.mood);
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
              }
            },
          },
        });
        deviceServer = server;

        const runtime = ctx.runtime as AgentRuntime;
        runtime.setSetting(
          "COMPANION_WS_URL",
          `ws://127.0.0.1:${server.port}/api/companion/device-bridge`,
        );
        runtime.setSetting("COMPANION_PAIRING_TOKEN", PAIRING_TOKEN);
        runtime.setSetting("COMPANION_PING_INTERVAL_MS", "60000");
        runtime.setSetting("COMPANION_PONG_TIMEOUT_MS", "1000");
        runtime.setSetting("COMPANION_COMMAND_TIMEOUT_MS", "2000");
        runtime.setSetting("COMPANION_RECONNECT_DELAY_MS", "60000");
        await runtime.registerPlugin(companionPlugin);
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Companion device",
    },
  ],

  turns: [
    {
      // Readiness is a state barrier, not a duration. `registerPlugin` in the
      // seed returns BEFORE the plugin's services are live: core registers
      // services lazily and starts them fire-and-forget
      // (packages/core/src/runtime.ts). Both actions below validate on nothing
      // but "is the COMPANION service live?", so a host slow enough to lose
      // that race fails the turn as a validation rejection. Poll the service
      // itself: registered AND past the welcome→register handshake.
      kind: "wait",
      name: "companion service is live and the device handshake completed",
      timeoutMs: 15_000,
      until: (ctx) => {
        const runtime = ctx.runtime as AgentRuntime;
        const service = runtime.getService<CompanionService>(
          CompanionService.serviceType,
        );
        return service?.isReady() === true;
      },
    },
    {
      kind: "action",
      name: "set the companion mood",
      actionName: SET_MOOD,
      text: "Show a curious mood.",
      options: { parameters: { mood: "curious" } },
      assertTurn: (turn) => {
        const result = successfulAction(turn, SET_MOOD);
        if (!result?.success) {
          return `${SET_MOOD} failed: ${result?.text ?? "no result"}`;
        }
        const data = result.data as { mood?: unknown } | undefined;
        if (data?.mood !== "curious") {
          return `expected device-confirmed curious mood, saw ${JSON.stringify(data)}`;
        }
      },
    },
    {
      kind: "action",
      name: "read the companion status",
      actionName: GET_STATUS,
      text: "Read the companion status.",
      assertTurn: (turn) => {
        const result = successfulAction(turn, GET_STATUS);
        if (!result?.success) {
          return `${GET_STATUS} failed: ${result?.text ?? "no result"}`;
        }
        const data = result.data as
          | { deviceId?: unknown; mood?: unknown; firmware?: unknown }
          | undefined;
        if (
          data?.deviceId !== "scenario-esp32" ||
          data.mood !== "curious" ||
          data.firmware !== "scenario-fw 1.0.0"
        ) {
          return `unexpected companion status: ${JSON.stringify(data)}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: SET_MOOD,
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: GET_STATUS,
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "device received correlated commands in order",
      predicate: () => {
        const commands = receivedFrames.filter(
          (frame) => frame.type === "SET_MOOD" || frame.type === "GET_STATUS",
        );
        if (commands.length !== 2) {
          return `expected exactly two device commands, saw ${JSON.stringify(commands)}`;
        }
        if (
          commands[0]?.type !== "SET_MOOD" ||
          commands[0]?.mood !== "curious" ||
          typeof commands[0]?.correlationId !== "string" ||
          commands[1]?.type !== "GET_STATUS" ||
          typeof commands[1]?.correlationId !== "string"
        ) {
          return `unexpected device command sequence: ${JSON.stringify(commands)}`;
        }
      },
    },
  ],

  cleanup: [
    {
      type: "custom",
      name: "stop companion service and protocol peer",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime;
        const service = runtime.getService(
          "COMPANION",
        ) as StoppableService | null;
        await service?.stop();
        deviceServer?.stop(true);
        deviceServer = null;
      },
    },
  ],
});
