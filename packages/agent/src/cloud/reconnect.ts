/**
 * Heartbeat monitor with auto-reconnect via exponential backoff.
 */

import { logger } from "@elizaos/core";
import type { ElizaCloudClient } from "./bridge-client";

export interface ConnectionMonitorCallbacks {
  onDisconnect: () => void;
  onReconnect: () => void;
  onStatusChange?: (
    status: "connected" | "reconnecting" | "disconnected",
  ) => void;
}

export class ConnectionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private reconnecting = false;

  constructor(
    private client: ElizaCloudClient,
    private agentId: string,
    private callbacks: ConnectionMonitorCallbacks,
    private heartbeatIntervalMs: number = 30_000,
    private maxFailures: number = 3,
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info(
      `[cloud-monitor] Starting connection monitor (interval: ${this.heartbeatIntervalMs}ms, maxFailures: ${this.maxFailures})`,
    );
    this.consecutiveFailures = 0;
    this.timer = setInterval(() => {
      this.tick();
    }, this.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.consecutiveFailures = 0;
    this.reconnecting = false;
    logger.info("[cloud-monitor] Connection monitor stopped");
  }

  isMonitoring(): boolean {
    return this.timer !== null;
  }

  private async tick(): Promise<void> {
    if (this.reconnecting) return;

    const alive = await this.client.heartbeat(this.agentId).catch(() => false);

    if (alive) {
      if (this.consecutiveFailures > 0) {
        this.consecutiveFailures = 0;
        this.callbacks.onStatusChange?.("connected");
      }
      return;
    }

    this.consecutiveFailures++;
    logger.warn(
      `[cloud-monitor] Heartbeat failed (${this.consecutiveFailures}/${this.maxFailures})`,
    );

    if (this.consecutiveFailures >= this.maxFailures) {
      this.callbacks.onStatusChange?.("disconnected");
      this.callbacks.onDisconnect();
      await this.attemptReconnect();
    }
  }

  private async attemptReconnect(): Promise<void> {
    this.reconnecting = true;
    this.callbacks.onStatusChange?.("reconnecting");

    let delay = 3_000;
    for (let attempt = 1; attempt <= 10; attempt++) {
      logger.info(`[cloud-monitor] Reconnect attempt ${attempt}/10...`);
      const ok = await this.client
        .provision(this.agentId)
        .then(() => true)
        .catch(() => false);

      if (ok) {
        logger.info("[cloud-monitor] Reconnection successful");
        this.consecutiveFailures = 0;
        this.reconnecting = false;
        this.callbacks.onStatusChange?.("connected");
        this.callbacks.onReconnect();
        return;
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }

    logger.error("[cloud-monitor] Failed to reconnect after 10 attempts");
    this.reconnecting = false;
    this.callbacks.onStatusChange?.("disconnected");
  }
}
