import { logger } from "@elizaos/core";
import WebSocket from "ws";
import type { NavigationResult, WebSocketMessage, WebSocketResponse } from "../types.js";

type MessageHandler = (response: WebSocketResponse) => void;

export class BrowserWebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers = new Map<string, MessageHandler>();
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(private serverUrl: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.serverUrl);

        this.ws.on("open", () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          logger.info(`[Browser] Connected to server at ${this.serverUrl}`);
          resolve();
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
          try {
            const messageText = this.rawDataToString(data);
            const message = JSON.parse(messageText) as WebSocketResponse;

            if (message.requestId && this.messageHandlers.has(message.requestId)) {
              const handler = this.messageHandlers.get(message.requestId);
              this.messageHandlers.delete(message.requestId);
              handler?.(message);
            }

            if (message.type === "connected") {
              logger.info(`[Browser] Server connected: ${JSON.stringify(message)}`);
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[Browser] Error parsing message: ${errorMessage}`);
          }
        });

        this.ws.on("error", (error: Error) => {
          logger.error(`[Browser] WebSocket error: ${error.message}`);
          if (!this.connected) {
            reject(error);
          }
        });

        this.ws.on("close", () => {
          this.connected = false;
          logger.info("[Browser] Disconnected from server");

          if (this.ws && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.attemptReconnect();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private rawDataToString(data: WebSocket.RawData): string {
    if (typeof data === "string") {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString("utf8");
    }
    return String(data);
  }

  private async attemptReconnect(): Promise<void> {
    this.reconnectAttempts++;
    logger.info(
      `[Browser] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, this.reconnectDelay * this.reconnectAttempts)
    );

    try {
      await this.connect();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[Browser] Reconnection failed: ${errorMessage}`);
    }
  }

  async sendMessage(type: string, data: Record<string, unknown>): Promise<WebSocketResponse> {
    if (!this.ws || !this.connected) {
      throw new Error("Not connected to browser server");
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const message: WebSocketMessage = {
      type,
      requestId,
      ...data,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(requestId);
        reject(new Error(`Request timeout for ${type}`));
      }, 30000);

      this.messageHandlers.set(requestId, (response) => {
        clearTimeout(timeout);
        if (response.type === "error") {
          reject(new Error(response.error ?? "Unknown error"));
        } else {
          resolve(response);
        }
      });

      this.ws?.send(JSON.stringify(message));
      logger.debug(`[Browser] Sent message: ${type} (${requestId})`);
    });
  }

  disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info("[Browser] Client disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async navigate(sessionId: string, url: string): Promise<NavigationResult> {
    const response = await this.sendMessage("navigate", {
      sessionId,
      data: { url },
    });
    const data = response.data as Record<string, unknown> | undefined;
    return {
      success: Boolean(data?.success),
      url: String(data?.url ?? url),
      title: String(data?.title ?? ""),
    };
  }

  async getState(
    sessionId: string
  ): Promise<{ url: string; title: string; sessionId: string; createdAt: Date }> {
    const response = await this.sendMessage("getState", { sessionId });
    const data = response.data as Record<string, unknown> | undefined;
    return {
      url: String(data?.url ?? ""),
      title: String(data?.title ?? ""),
      sessionId,
      createdAt: new Date(),
    };
  }

  async goBack(sessionId: string): Promise<NavigationResult> {
    const response = await this.sendMessage("goBack", { sessionId });
    const data = response.data as Record<string, unknown> | undefined;
    return {
      success: Boolean(data?.success ?? true),
      url: String(data?.url ?? ""),
      title: String(data?.title ?? ""),
    };
  }

  async goForward(sessionId: string): Promise<NavigationResult> {
    const response = await this.sendMessage("goForward", { sessionId });
    const data = response.data as Record<string, unknown> | undefined;
    return {
      success: Boolean(data?.success ?? true),
      url: String(data?.url ?? ""),
      title: String(data?.title ?? ""),
    };
  }

  async refresh(sessionId: string): Promise<NavigationResult> {
    const response = await this.sendMessage("refresh", { sessionId });
    const data = response.data as Record<string, unknown> | undefined;
    return {
      success: Boolean(data?.success ?? true),
      url: String(data?.url ?? ""),
      title: String(data?.title ?? ""),
    };
  }

  async click(sessionId: string, description: string): Promise<WebSocketResponse> {
    return await this.sendMessage("click", {
      sessionId,
      data: { description },
    });
  }

  async type(sessionId: string, text: string, field: string): Promise<WebSocketResponse> {
    return await this.sendMessage("type", {
      sessionId,
      data: { text, field },
    });
  }

  async select(sessionId: string, option: string, dropdown: string): Promise<WebSocketResponse> {
    return await this.sendMessage("select", {
      sessionId,
      data: { option, dropdown },
    });
  }

  async extract(sessionId: string, instruction: string): Promise<WebSocketResponse> {
    return await this.sendMessage("extract", {
      sessionId,
      data: { instruction },
    });
  }

  async screenshot(sessionId: string): Promise<WebSocketResponse> {
    return await this.sendMessage("screenshot", { sessionId });
  }

  async solveCaptcha(sessionId: string): Promise<WebSocketResponse> {
    return await this.sendMessage("solveCaptcha", { sessionId });
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.sendMessage("health", {});
      return response.type === "health" && (response.data as { status: string })?.status === "ok";
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[Browser] Health check failed: ${errorMessage}`);
      return false;
    }
  }
}
