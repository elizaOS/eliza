/**
 * Serial heartbeat monitor with cancellable exponential-backoff reconnects.
 *
 * Heartbeats use a one-shot timer so a slow request or reconnect cycle cannot
 * overlap another tick. Stopping the monitor invalidates in-flight work and
 * releases a pending backoff immediately.
 */

import { logger } from "@elizaos/core";
import type { ElizaCloudClient } from "./bridge-client.js";

type ConnectionClient = Pick<ElizaCloudClient, "heartbeat" | "provision">;

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayResolve: ((active: boolean) => void) | null = null;
  private consecutiveFailures = 0;
  private reconnecting = false;
  private running = false;
  private generation = 0;

  constructor(
    private client: ConnectionClient,
    private agentId: string,
    private callbacks: ConnectionMonitorCallbacks,
    private heartbeatIntervalMs: number = 30_000,
    private maxFailures: number = 3,
  ) {}

  start(): void {
    if (this.running) return;
    logger.info(
      `[cloud-monitor] Starting connection monitor (interval: ${this.heartbeatIntervalMs}ms, maxFailures: ${this.maxFailures})`,
    );
    this.running = true;
    this.generation++;
    this.consecutiveFailures = 0;
    this.scheduleHeartbeat(this.generation);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.generation++;
    this.cancelReconnectDelay();
    this.consecutiveFailures = 0;
    this.reconnecting = false;
    logger.info("[cloud-monitor] Connection monitor stopped");
  }

  isMonitoring(): boolean {
    return this.running;
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private scheduleHeartbeat(generation: number): void {
    if (!this.isActive(generation) || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(generation)
        .catch((error) => {
          // error-policy:J7 the timer is an asynchronous service boundary; log
          // unexpected callback failures while keeping future health checks live.
          logger.error(
            `[cloud-monitor] Heartbeat cycle failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          this.scheduleHeartbeat(generation);
        });
    }, this.heartbeatIntervalMs);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.isActive(generation) || this.reconnecting) return;

    const alive = await this.client.heartbeat(this.agentId).catch(() => false);
    if (!this.isActive(generation)) return;

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
      await this.attemptReconnect(generation);
    }
  }

  private async attemptReconnect(generation: number): Promise<void> {
    if (!this.isActive(generation)) return;
    this.reconnecting = true;
    this.callbacks.onStatusChange?.("reconnecting");

    let delay = 3_000;
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (!this.isActive(generation)) return;
      logger.info(`[cloud-monitor] Reconnect attempt ${attempt}/10...`);
      const ok = await this.client
        .provision(this.agentId)
        .then(() => true)
        .catch(() => false);
      if (!this.isActive(generation)) return;

      if (ok) {
        logger.info("[cloud-monitor] Reconnection successful");
        this.consecutiveFailures = 0;
        this.reconnecting = false;
        this.callbacks.onStatusChange?.("connected");
        this.callbacks.onReconnect();
        return;
      }

      // There is no reason to wait after the final failed attempt: the next
      // state transition is immediate exhaustion reporting.
      if (attempt === 10) break;
      if (!(await this.waitForReconnectDelay(delay, generation))) return;
      delay = Math.min(delay * 2, 60_000);
    }

    if (!this.isActive(generation)) return;
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

  private waitForReconnectDelay(
    delayMs: number,
    generation: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.reconnectDelayResolve = resolve;
      this.reconnectDelayTimer = setTimeout(() => {
        this.reconnectDelayTimer = null;
        this.reconnectDelayResolve = null;
        resolve(this.isActive(generation));
      }, delayMs);
    });
  }

  private cancelReconnectDelay(): void {
    if (this.reconnectDelayTimer) {
      clearTimeout(this.reconnectDelayTimer);
      this.reconnectDelayTimer = null;
    }
    const resolve = this.reconnectDelayResolve;
    this.reconnectDelayResolve = null;
    resolve?.(false);
  }
}
