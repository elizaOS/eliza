/**
 * Heartbeat monitor with auto-reconnect via exponential backoff.
 */

import { logger } from "@elizaos/core";
import type { ElizaCloudClient } from "./bridge-client.js";

export interface ConnectionMonitorCallbacks {
  onDisconnect: () => void;
  onReconnect: () => void;
  onStatusChange?: (
    status: "connected" | "reconnecting" | "disconnected",
  ) => void;
  /**
   * error-policy:#14415 — fired once when every reconnect attempt is exhausted
   * (the connection is now durably down, not transiently reconnecting). Lets a
   * host wire this into `runtime.reportError` so a silently-dead cloud link
   * surfaces via RECENT_ERRORS + owner escalation instead of only a log line.
   * Best-effort: a throwing handler must never break the monitor, so callers
   * are invoked inside a try/catch.
   */
  onReconnectExhausted?: (context: { attempts: number }) => void;
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
      // Don't emit "disconnected" here — attemptReconnect() will emit
      // "reconnecting" first, and only emits "disconnected" if all
      // retry attempts fail. This avoids a misleading disconnected→
      // reconnecting flicker for callers.
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
    // error-policy:#14415 — the link is now durably down. Report exactly once
    // per exhaustion (not per failed attempt) so this is observable without
    // spamming. A throwing handler must not re-break the monitor.
    try {
      this.callbacks.onReconnectExhausted?.({ attempts: 10 });
    } catch (err) {
      logger.warn(
        `[cloud-monitor] onReconnectExhausted handler threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
