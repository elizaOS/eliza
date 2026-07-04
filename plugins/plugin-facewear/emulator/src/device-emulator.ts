/**
 * WebSocket client that speaks the facewear XR hello and frame protocol for
 * local headset simulation.
 */
import { WebSocket } from "ws";

export type FacewearDeviceType =
  | "meta-quest"
  | "xreal"
  | "even-realities"
  | "apple-vision-pro"
  | "simulator";

// XR sessions expect the protocol deviceType field, not the package profile id.
const DEVICE_TYPE_MAP: Record<FacewearDeviceType, string> = {
  "meta-quest": "quest3",
  xreal: "xreal",
  "even-realities": "simulator", // BLE device uses simulator mode for WS
  "apple-vision-pro": "simulator",
  simulator: "simulator",
};

export class DeviceEmulator {
  connected = false;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private messageHandlers: Array<(msg: unknown) => void> = [];

  constructor(public readonly deviceType: FacewearDeviceType) {}

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "nodebuffer";

      this.ws.on("open", () => {
        const hello = JSON.stringify({
          type: "hello",
          deviceType: DEVICE_TYPE_MAP[this.deviceType],
          sessionId: `emulator-${Date.now()}`,
        });
        this.ws!.send(hello);
      });

      this.ws.on("message", (data) => {
        const text = data instanceof Buffer ? data.toString() : String(data);
        try {
          const msg = JSON.parse(text) as { type: string; sessionId?: string };
          if (msg.type === "ready" && msg.sessionId) {
            this.sessionId = msg.sessionId;
            this.connected = true;
            resolve();
          }
          for (const handler of this.messageHandlers) {
            handler(msg);
          }
        } catch {
          // binary frame — TTS audio etc.
        }
      });

      this.ws.on("error", reject);
      this.ws.on("close", () => {
        this.connected = false;
      });
      setTimeout(() => reject(new Error("Connection timeout")), 5000);
    });
  }

  sendAudioChunk(
    chunk: Uint8Array,
    encoding: "webm-opus" | "pcm-f32" = "webm-opus",
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const header = JSON.stringify({
      type: "audio",
      ts: Date.now(),
      sampleRate: 16000,
      encoding,
    });
    const headerBytes = Buffer.from(header, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerBytes.length, 0);
    this.ws.send(Buffer.concat([lenBuf, headerBytes, chunk]));
  }

  sendCameraFrame(jpeg: Uint8Array, width = 640, height = 480): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const header = JSON.stringify({
      type: "frame",
      ts: Date.now(),
      width,
      height,
      format: "jpeg",
    });
    const headerBytes = Buffer.from(header, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerBytes.length, 0);
    this.ws.send(Buffer.concat([lenBuf, headerBytes, jpeg]));
  }

  sendControl(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  disconnect(): void {
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.sessionId = null;
    this.connected = false;
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}
