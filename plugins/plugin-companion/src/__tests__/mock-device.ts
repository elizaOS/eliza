import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type CompanionMood, parseFrame } from "../protocol";

export const TEST_TOKEN = "eliza-companion-dev";
export const TEST_DEVICE_ID = "S3-46BEAC";

export interface MockDeviceOptions {
  token?: string;
  deviceId?: string | null;
  firmware?: string;
  dropPong?: boolean;
  malformedOnConnect?: boolean;
}

export interface MockDevice {
  url: string;
  close: () => Promise<void>;
  emit: (frame: object) => void;
  lastSocket: () => WebSocket | null;
}

export async function startMockDevice(options: MockDeviceOptions = {}): Promise<MockDevice> {
  const token = options.token ?? TEST_TOKEN;
  const deviceId = options.deviceId === undefined ? TEST_DEVICE_ID : options.deviceId;
  let mood: CompanionMood = "idle";
  let socket: WebSocket | null = null;

  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socketRaw, head) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/api/companion/device-bridge") {
      socketRaw.destroy();
      return;
    }
    if (url.searchParams.get("token") !== token) {
      socketRaw.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socketRaw.destroy();
      return;
    }
    wss.handleUpgrade(request, socketRaw, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    socket = ws;
    if (options.malformedOnConnect) {
      ws.send("I (123) companion_bridge: boot");
    }
    ws.send(
      JSON.stringify({
        type: "welcome",
        payload: { deviceId: deviceId ?? undefined, protocol: "eliza-companion/1" },
      })
    );
    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          ...(deviceId ? { deviceId } : {}),
          pairingToken: token,
          firmware: options.firmware ?? "eliza-companion/0.1.0",
          capabilities: {
            platform: "esp32-s3",
            deviceModel: "waveshare-esp32-s3-touch-lcd-1.69",
            display: true,
            touch: true,
          },
        },
      })
    );

    ws.on("message", (raw) => {
      const frame = parseFrame(raw.toString("utf8"));
      if (!frame) {
        ws.send("not-json");
        return;
      }
      if (frame.type === "ping") {
        if (!options.dropPong) {
          const at = "at" in frame && typeof frame.at === "number" ? frame.at : Date.now();
          ws.send(JSON.stringify({ type: "pong", at }));
        }
        return;
      }
      if (frame.type !== "command") return;
      const command = frame as {
        type: "command";
        name?: string;
        correlationId: string;
        payload?: { mood?: string };
      };
      if (command.name === "SET_MOOD") {
        const next = command.payload?.mood;
        if (next !== "idle" && next !== "listening" && next !== "thinking" && next !== "happy") {
          ws.send(
            JSON.stringify({
              type: "commandResult",
              correlationId: command.correlationId,
              ok: false,
              error: "invalid-mood",
            })
          );
          return;
        }
        mood = next;
        ws.send(
          JSON.stringify({
            type: "event",
            name: "mood_changed",
            payload: { mood },
          })
        );
        ws.send(
          JSON.stringify({
            type: "commandResult",
            correlationId: command.correlationId,
            ok: true,
            payload: { mood },
          })
        );
        return;
      }
      if (command.name === "GET_STATUS") {
        ws.send(
          JSON.stringify({
            type: "commandResult",
            correlationId: command.correlationId,
            ok: true,
            payload: { mood },
          })
        );
        return;
      }
      ws.send(
        JSON.stringify({
          type: "commandResult",
          correlationId: command.correlationId,
          ok: false,
          error: "unknown-command",
        })
      );
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("mock device did not bind a port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/api/companion/device-bridge`,
    lastSocket: () => socket,
    emit: (frame) => {
      socket?.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
