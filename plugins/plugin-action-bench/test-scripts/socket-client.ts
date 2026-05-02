/**
 * WebSocket client for connecting to ELIZA server
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { config } from "./config";
import { SocketMessage, ElizaResponse } from "./types";

export class ElizaSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private messageQueue: SocketMessage[] = [];
  private responseTimeout: NodeJS.Timeout | null = null;
  private currentMessageId: number = 0;

  constructor(private url: string = config.server.url) {
    super();
  }

  /**
   * Connect to the ELIZA WebSocket server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on("open", () => {
          console.log(`[Socket] Connected to ${this.url}`);
          this.connected = true;
          this.reconnectAttempts = 0;
          this.processMessageQueue();
          this.emit("connected");
          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            console.error("[Socket] Failed to parse message:", error);
          }
        });

        this.ws.on("error", (error: Error) => {
          console.error("[Socket] WebSocket error:", error);
          this.emit("error", error);
        });

        this.ws.on("close", (code: number, reason: string) => {
          console.log(`[Socket] Disconnected (${code}): ${reason}`);
          this.connected = false;
          this.emit("disconnected", { code, reason });
          this.handleReconnect();
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Send a message to ELIZA
   */
  async sendMessage(text: string, timeout?: number): Promise<ElizaResponse> {
    return new Promise((resolve, reject) => {
      const messageId = ++this.currentMessageId;
      const message: SocketMessage = {
        type: "message",
        text,
        userId: config.agent.userId,
        roomId: config.agent.roomId,
        messageId,
        timestamp: Date.now(),
      };

      const timeoutMs = timeout || config.test.defaultTimeout;
      
      // Set up response listener
      const responseHandler = (response: ElizaResponse) => {
        if (this.responseTimeout) {
          clearTimeout(this.responseTimeout);
          this.responseTimeout = null;
        }
        this.removeListener(`response-${messageId}`, responseHandler);
        resolve(response);
      };

      this.once(`response-${messageId}`, responseHandler);

      // Set timeout
      this.responseTimeout = setTimeout(() => {
        this.removeListener(`response-${messageId}`, responseHandler);
        reject(new Error(`Response timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // Send or queue message
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify(message));
      } else {
        this.messageQueue.push(message);
        reject(new Error("Not connected to server"));
      }
    });
  }

  /**
   * Handle incoming messages from ELIZA
   */
  private handleMessage(message: any): void {
    // Check if this is a response to our message
    if (message.type === "response" || message.text) {
      const response: ElizaResponse = {
        text: message.text || "",
        actions: message.actions || [],
        state: message.state,
        timestamp: Date.now(),
      };

      // Emit response for the specific message ID if available
      if (message.messageId) {
        this.emit(`response-${message.messageId}`, response);
      }

      // Also emit general response event
      this.emit("response", response);
    }

    // Emit raw message for debugging
    this.emit("message", message);
  }

  /**
   * Process queued messages
   */
  private processMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.connected && this.ws) {
      const message = this.messageQueue.shift();
      if (message) {
        this.ws.send(JSON.stringify(message));
      }
    }
  }

  /**
   * Handle reconnection logic
   */
  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= config.server.reconnectAttempts) {
      console.error("[Socket] Max reconnection attempts reached");
      this.emit("reconnectFailed");
      return;
    }

    this.reconnectAttempts++;
    console.log(`[Socket] Reconnecting... (attempt ${this.reconnectAttempts})`);
    
    await new Promise(resolve => setTimeout(resolve, config.server.reconnectDelay));
    
    try {
      await this.connect();
    } catch (error) {
      console.error("[Socket] Reconnection failed:", error);
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.removeAllListeners();
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Wait for connection to be established
   */
  async waitForConnection(timeout: number = 5000): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, timeout);

      this.once("connected", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
