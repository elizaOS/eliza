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
  // stop() advances this. A reconnect ladder captures it on entry and abandons
  // itself after every await once it has moved, so a monitor the host tore
  // down never provisions again or reports "connected" on a stale client.
  private epoch = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeBackoff: (() => void) | null = null;

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
    this.epoch += 1;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cancelBackoff();
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

  /** Wake a pending backoff sleep so the ladder can observe stop() at once. */
  private cancelBackoff(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    const wake = this.wakeBackoff;
    this.wakeBackoff = null;
    wake?.();
  }

  private sleepBackoff(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeBackoff = resolve;
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        this.wakeBackoff = null;
        resolve();
      }, delayMs);
    });
  }

  private async attemptReconnect(): Promise<void> {
    const epoch = this.epoch;
    this.reconnecting = true;
    this.callbacks.onStatusChange?.("reconnecting");

    let delay = 3_000;
    for (let attempt = 1; attempt <= 10; attempt++) {
      logger.info(`[cloud-monitor] Reconnect attempt ${attempt}/10...`);
      const ok = await this.client
        .provision(this.agentId)
        .then(() => true)
        .catch(() => false);
      if (epoch !== this.epoch) return;

      if (ok) {
        logger.info("[cloud-monitor] Reconnection successful");
        this.consecutiveFailures = 0;
        this.reconnecting = false;
        this.callbacks.onStatusChange?.("connected");
        this.callbacks.onReconnect();
        return;
      }

      await this.sleepBackoff(delay);
      if (epoch !== this.epoch) return;
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
