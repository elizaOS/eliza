/**
 * Lightweight WebSocket server that simulates plugin-facewear's XRSessionService.
 * Used in Playwright tests — starts a real ws server on a configurable port,
 * records all received binary frames, and lets tests script responses.
 */

import { WebSocket, WebSocketServer } from "ws";
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  type XRBinaryHeader,
  type XRClientControl,
  type XRTTSAudioHeader,
} from "../../src/protocol/xr.ts";

export interface ReceivedFrame {
  header: XRBinaryHeader | XRTTSAudioHeader;
  payload: Buffer;
  receivedAt: number;
}

export interface ReceivedControl {
  message: XRClientControl;
  receivedAt: number;
}

export interface MockAgentServerOptions {
  port?: number;
  /** Automatically send a transcript response after receiving N audio frames */
  autoTranscriptAfterFrames?: number;
  autoTranscriptText?: string;
}

export class MockAgentServer {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;

  readonly receivedFrames: ReceivedFrame[] = [];
  readonly receivedControls: ReceivedControl[] = [];
  private waiters = new Map<string, Array<() => void>>();

  constructor(private readonly options: MockAgentServerOptions = {}) {}

  get port(): number {
    return this.options.port ?? 31338;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on("listening", resolve);
      this.wss.on("error", reject);
      this.wss.on("connection", (ws) => this.onClient(ws));
    });
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = null;
    return new Promise((resolve) => this.wss?.close(() => resolve()));
  }

  // ── Sending responses ──────────────────────────────────────────────────

  sendTranscript(text: string, final = true): void {
    this.sendText({ type: "transcript", text, final });
  }

  sendAgentText(text: string): void {
    this.sendText({ type: "agent_text", text });
  }

  sendTTSAudio(audio: Buffer, sampleRate = 24000): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    const header: XRTTSAudioHeader = {
      type: "tts_audio",
      sampleRate,
      channels: 1,
      encoding: "mp3",
    };
    this.client.send(encodeBinaryFrame(header, audio), { binary: true });
  }

  // ── Waiting helpers ────────────────────────────────────────────────────

  /** Resolves when the device has connected and sent a 'hello' message.
   *  Resolves immediately if 'hello' was already received (handles the race
   *  where the connection fires before the waiter is registered). */
  waitForConnection(timeoutMs = 5000): Promise<void> {
    if (this.receivedControls.some((c) => c.message.type === "hello")) {
      return Promise.resolve();
    }
    return this.waitFor("connected", timeoutMs);
  }

  /** Resolves when at least one audio binary frame has been received. */
  waitForAudioFrame(timeoutMs = 10000): Promise<ReceivedFrame> {
    return this.waitForFrame("audio", timeoutMs);
  }

  /** Resolves when at least one camera binary frame has been received. */
  waitForCameraFrame(timeoutMs = 10000): Promise<ReceivedFrame> {
    return this.waitForFrame("frame", timeoutMs);
  }

  audioFrames(): ReceivedFrame[] {
    return this.receivedFrames.filter((f) => f.header.type === "audio");
  }

  cameraFrames(): ReceivedFrame[] {
    return this.receivedFrames.filter((f) => f.header.type === "frame");
  }

  reset(): void {
    this.receivedFrames.length = 0;
    this.receivedControls.length = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private onClient(ws: WebSocket): void {
    this.client = ws;

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleBinary(data as Buffer);
      } else {
        this.handleText(ws, data.toString("utf8"));
      }
    });

    ws.on("close", () => {
      if (this.client === ws) this.client = null;
    });
  }

  private handleText(ws: WebSocket, raw: string): void {
    try {
      const msg = JSON.parse(raw) as XRClientControl;
      this.receivedControls.push({ message: msg, receivedAt: Date.now() });

      if (msg.type === "hello") {
        // Send ready
        ws.send(JSON.stringify({ type: "ready", sessionId: "mock-session" }));
        this.notify("connected");
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {}
  }

  private handleBinary(data: Buffer): void {
    try {
      const { header, payload } = decodeBinaryFrame(data);
      const frame: ReceivedFrame = { header, payload, receivedAt: Date.now() };
      this.receivedFrames.push(frame);
      this.notify(`frame:${header.type}`);

      // Auto-transcript after N audio frames
      const { autoTranscriptAfterFrames, autoTranscriptText } = this.options;
      if (
        header.type === "audio" &&
        autoTranscriptAfterFrames !== undefined &&
        this.audioFrames().length >= autoTranscriptAfterFrames
      ) {
        const text = autoTranscriptText ?? "test transcript";
        setTimeout(() => {
          this.sendTranscript(text);
          this.sendAgentText(`Agent response to: ${text}`);
        }, 50);
      }
    } catch {}
  }

  private sendText(msg: object): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(msg));
  }

  private waitFor(event: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`MockAgentServer: timeout waiting for "${event}"`)),
        timeoutMs,
      );
      const list = this.waiters.get(event) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(event, list);
    });
  }

  private waitForFrame(
    type: string,
    timeoutMs: number,
  ): Promise<ReceivedFrame> {
    // Check if already received
    const existing = this.receivedFrames.find((f) => f.header.type === type);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `MockAgentServer: timeout waiting for frame type "${type}"`,
            ),
          ),
        timeoutMs,
      );
      const event = `frame:${type}`;
      const list = this.waiters.get(event) ?? [];
      list.push(() => {
        clearTimeout(timer);
        const frame = [...this.receivedFrames].reverse().find(
          (f: ReceivedFrame) => f.header.type === type,
        )!;
        resolve(frame);
      });
      this.waiters.set(event, list);
    });
  }

  private notify(event: string): void {
    const list = this.waiters.get(event) ?? [];
    this.waiters.delete(event);
    for (const cb of list) cb();
  }
}
