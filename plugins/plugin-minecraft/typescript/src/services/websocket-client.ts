import { logger } from "@elizaos/core";
import WebSocket from "ws";
import { z } from "zod";
import type {
  JsonObject,
  JsonValue,
  MinecraftBridgeRequest,
  MinecraftBridgeRequestType,
  MinecraftBridgeResponse,
} from "../protocol.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const responseSchema = z.object({
  type: z.string(),
  requestId: z.string(),
  success: z.boolean(),
  data: z.record(z.string(), jsonValueSchema).optional(),
  error: z.string().optional(),
});

type PendingResolver = (value: MinecraftBridgeResponse) => void;
type PendingRejecter = (reason: Error) => void;

type PendingEntry = {
  resolve: PendingResolver;
  reject: PendingRejecter;
  timeoutId: ReturnType<typeof setTimeout>;
};

export class MinecraftWebSocketClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingEntry>();

  constructor(private serverUrl: string) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
      ws.on("message", (data) => this.onMessage(data.toString("utf8")));
      ws.on("close", () => {
        // reject all pending
        for (const [requestId, entry] of this.pending) {
          clearTimeout(entry.timeoutId);
          entry.reject(
            new Error(`WebSocket closed while waiting for ${requestId}`),
          );
        }
        this.pending.clear();
      });
    });

    logger.info(`[Minecraft] Connected to ${this.serverUrl}`);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  async health(): Promise<boolean> {
    const resp = await this.sendMessage("health", undefined, {});
    return resp.success && resp.data?.status === "ok";
  }

  async sendMessage(
    type: MinecraftBridgeRequestType,
    botId: string | undefined,
    data: JsonObject,
    timeoutMs: number = 30_000,
  ): Promise<MinecraftBridgeResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to Mineflayer bridge server");
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const msg: MinecraftBridgeRequest = {
      type,
      requestId,
      ...(botId ? { botId } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };

    const payload = JSON.stringify(msg);

    const response = await new Promise<MinecraftBridgeResponse>(
      (resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Request timeout: ${type}`));
        }, timeoutMs);

        this.pending.set(requestId, { resolve, reject, timeoutId });
        this.ws?.send(payload, (err) => {
          if (err) {
            clearTimeout(timeoutId);
            this.pending.delete(requestId);
            reject(err);
          }
        });
      },
    );

    if (!response.success) {
      throw new Error(response.error ?? `Request failed: ${type}`);
    }

    return response;
  }

  private onMessage(text: string): void {
    let parsed: MinecraftBridgeResponse;
    try {
      const json = JSON.parse(text) as JsonValue;
      parsed = responseSchema.parse(json) as MinecraftBridgeResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Minecraft] Failed to parse server message: ${msg}`);
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(parsed.requestId);
    pending.resolve(parsed);
  }
}
