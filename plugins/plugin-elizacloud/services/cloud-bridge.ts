/**
 * CloudBridgeService — WebSocket bridge to cloud-hosted agents.
 *
 * Establishes a JSON-RPC 2.0 WebSocket connection per container, allowing
 * the local eliza client to send messages to and receive events from
 * cloud-hosted ElizaOS agents. Handles reconnection with exponential
 * backoff and heartbeat keepalive.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { WebSocket } from "undici";
import type {
  BridgeConnection,
  BridgeConnectionState,
  BridgeMessage,
  BridgeMessageHandler,
} from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import type { CloudAuthService } from "./cloud-auth";

interface ActiveConnection {
  ws: WebSocket;
  state: BridgeConnectionState;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  reconnectAttempts: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  handlers: Set<BridgeMessageHandler>;
  pendingRequests: Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
  nextRequestId: number;
}

export class CloudBridgeService extends Service {
  static serviceType = "CLOUD_BRIDGE";
  capabilityDescription = "WebSocket bridge to cloud-hosted ElizaOS agents";

  private authService!: CloudAuthService;
  private readonly bridgeConfig = DEFAULT_CLOUD_CONFIG.bridge;
  private connections: Map<string, ActiveConnection> = new Map();

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudBridgeService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    for (const [containerId] of this.connections) {
      await this.disconnect(containerId);
    }
    logger.info("[CloudBridge] Service stopped");
  }

  private async initialize(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH");
    if (!auth) {
      logger.debug("[CloudBridge] CloudAuthService not available");
      return;
    }
    this.authService = auth as CloudAuthService;
    logger.info("[CloudBridge] Service initialized");
  }

  // ─── Connection Management ─────────────────────────────────────────────

  async connect(containerId: string): Promise<void> {
    const existing = this.connections.get(containerId);
    if (existing) {
      if (existing.state === "connected" || existing.state === "connecting") {
        logger.debug(`[CloudBridge] Already connected/connecting to ${containerId}`);
        return;
      }
    }

    await this.establishConnection(containerId, 0);
  }

  async disconnect(containerId: string): Promise<void> {
    const conn = this.connections.get(containerId);
    if (!conn) return;

    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);

    // Reject all pending requests
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge disconnected"));
    }
    conn.pendingRequests.clear();

    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(1000, "Client disconnect");
    }

    this.connections.delete(containerId);
    logger.info(`[CloudBridge] Disconnected from ${containerId}`);
  }

  private async establishConnection(containerId: string, reconnectAttempts: number): Promise<void> {
    const client = this.authService.getClient();
    const apiKey = this.authService.getApiKey();
    const wsUrl = client.buildWsUrl(`/agent-bridge/${containerId}`);

    // Append API key as query parameter for WebSocket auth
    const authUrl = apiKey ? `${wsUrl}?token=${encodeURIComponent(apiKey)}` : wsUrl;

    const conn: ActiveConnection = {
      ws: new WebSocket(authUrl),
      state: "connecting",
      connectedAt: null,
      lastHeartbeat: null,
      reconnectAttempts,
      heartbeatTimer: null,
      reconnectTimer: null,
      handlers: this.connections.get(containerId)?.handlers ?? new Set(),
      pendingRequests: new Map(),
      nextRequestId: 1,
    };

    this.connections.set(containerId, conn);

    conn.ws.addEventListener("open", () => {
      conn.state = "connected";
      conn.connectedAt = Date.now();
      conn.reconnectAttempts = 0;
      logger.info(`[CloudBridge] Connected to agent ${containerId}`);

      // Start heartbeat
      conn.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat(containerId);
      }, this.bridgeConfig.heartbeatIntervalMs);
    });

    conn.ws.addEventListener("message", (event) => {
      const raw = event.data;
      const data =
        typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString("utf-8") : String(raw);
      const message = JSON.parse(data) as BridgeMessage;

      // Handle heartbeat responses
      if (message.method === "heartbeat.ack") {
        conn.lastHeartbeat = Date.now();
        return;
      }

      // Handle responses to pending requests
      if (message.id !== undefined && !message.method) {
        const pending = conn.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          conn.pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message.result);
          }
          return;
        }
      }

      // Dispatch to handlers
      for (const handler of conn.handlers) {
        handler(message);
      }
    });

    conn.ws.addEventListener("close", (event: CloseEvent) => {
      conn.state = "disconnected";
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);

      // Don't reconnect on clean close
      if (event.code === 1000) {
        logger.info(`[CloudBridge] Clean disconnect from ${containerId}`);
        return;
      }

      logger.warn(
        `[CloudBridge] Connection lost to ${containerId} (code=${event.code}, reason=${event.reason})`
      );
      this.scheduleReconnect(containerId, conn.reconnectAttempts + 1);
    });

    conn.ws.addEventListener("error", () => {
      logger.error(`[CloudBridge] WebSocket error for ${containerId}`);
    });
  }

  private scheduleReconnect(containerId: string, attempt: number): void {
    if (attempt > this.bridgeConfig.maxReconnectAttempts) {
      logger.error(
        `[CloudBridge] Max reconnect attempts (${this.bridgeConfig.maxReconnectAttempts}) reached for ${containerId}`
      );
      this.connections.delete(containerId);
      return;
    }

    // Exponential backoff with jitter: base * 2^attempt + random jitter
    const base = this.bridgeConfig.reconnectIntervalMs;
    const delay = Math.min(base * 2 ** Math.min(attempt, 5), 120_000);
    const jitter = Math.floor(Math.random() * 1000);

    logger.info(
      `[CloudBridge] Reconnecting to ${containerId} in ${Math.round((delay + jitter) / 1000)}s (attempt ${attempt})`
    );

    const conn = this.connections.get(containerId);
    if (conn) {
      conn.state = "reconnecting";
      conn.reconnectTimer = setTimeout(() => {
        this.establishConnection(containerId, attempt);
      }, delay + jitter);
    }
  }

  private sendHeartbeat(containerId: string): void {
    const conn = this.connections.get(containerId);
    if (!conn || conn.state !== "connected") return;

    const message: BridgeMessage = {
      jsonrpc: "2.0",
      method: "heartbeat",
      params: { timestamp: Date.now() },
    };

    conn.ws.send(JSON.stringify(message));
  }

  // ─── Messaging ─────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and wait for a response.
   */
  async sendRequest(
    containerId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<unknown> {
    const conn = this.connections.get(containerId);
    if (!conn || conn.state !== "connected") {
      throw new Error(`Not connected to container ${containerId}`);
    }

    const id = conn.nextRequestId++;
    const message: BridgeMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(id, { resolve, reject, timeout });
      conn.ws.send(JSON.stringify(message));
    });
  }

  /**
   * Send a one-way notification (no response expected).
   */
  sendNotification(containerId: string, method: string, params: Record<string, unknown>): void {
    const conn = this.connections.get(containerId);
    if (!conn || conn.state !== "connected") {
      throw new Error(`Not connected to container ${containerId}`);
    }

    const message: BridgeMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    conn.ws.send(JSON.stringify(message));
  }

  /**
   * Send a chat message to the cloud agent and get the response.
   */
  async sendChatMessage(
    containerId: string,
    text: string,
    roomId?: string,
    metadata?: Record<string, unknown>
  ): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    const result = await this.sendRequest(containerId, "message.send", {
      text,
      roomId,
      metadata,
    });
    return result as { text: string; metadata?: Record<string, unknown> };
  }

  /**
   * Request the cloud agent's current status.
   */
  async getAgentStatus(containerId: string): Promise<Record<string, unknown>> {
    const result = await this.sendRequest(containerId, "status.get", {});
    return result as Record<string, unknown>;
  }

  /**
   * Update the cloud agent's configuration.
   */
  async updateAgentConfig(containerId: string, config: Record<string, unknown>): Promise<void> {
    await this.sendRequest(containerId, "config.update", config);
  }

  // ─── Event Handlers ────────────────────────────────────────────────────

  onMessage(containerId: string, handler: BridgeMessageHandler): () => void {
    let conn = this.connections.get(containerId);
    if (!conn) {
      // Pre-register handler before connection is established
      conn = {
        ws: null as unknown as WebSocket,
        state: "disconnected",
        connectedAt: null,
        lastHeartbeat: null,
        reconnectAttempts: 0,
        heartbeatTimer: null,
        reconnectTimer: null,
        handlers: new Set(),
        pendingRequests: new Map(),
        nextRequestId: 1,
      };
      this.connections.set(containerId, conn);
    }

    conn.handlers.add(handler);

    // Return unsubscribe function
    return () => {
      conn.handlers.delete(handler);
    };
  }

  // ─── Accessors ─────────────────────────────────────────────────────────

  getConnectionState(containerId: string): BridgeConnectionState {
    return this.connections.get(containerId)?.state ?? "disconnected";
  }

  getConnectionInfo(containerId: string): BridgeConnection | null {
    const conn = this.connections.get(containerId);
    if (!conn) return null;

    return {
      containerId,
      state: conn.state,
      connectedAt: conn.connectedAt,
      lastHeartbeat: conn.lastHeartbeat,
      reconnectAttempts: conn.reconnectAttempts,
    };
  }

  getConnectedContainerIds(): string[] {
    const ids: string[] = [];
    for (const [id, conn] of this.connections) {
      if (conn.state === "connected") ids.push(id);
    }
    return ids;
  }
}
