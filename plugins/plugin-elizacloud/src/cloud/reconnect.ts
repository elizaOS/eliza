/**
 * Heartbeat monitor with auto-reconnect via exponential backoff.
 *
 * Each start() opens a run with its own AbortController. stop() aborts that
 * run: in-flight heartbeat/provision requests are cancelled, a pending backoff
 * sleep ends immediately, and every continuation re-checks the run before it
 * fires a callback, so nothing from a stopped (or restarted) run reaches the
 * host after teardown.
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

const MAX_RECONNECT_ATTEMPTS = 10;

export class ConnectionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private reconnecting = false;
  private tickInFlight = false;
  /**
   * The live run's controller. stop() aborts it; every await in tick() and
   * attemptReconnect() re-checks the captured signal (including after each
   * synchronous public callback, which may itself call stop()).
   */
  private run: AbortController | null = null;

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
    this.reconnecting = false;
    this.tickInFlight = false;
    const run = new AbortController();
    this.run = run;
    this.timer = setInterval(() => {
      void this.tick(run.signal);
    }, this.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Cancel in-flight requests and backoff sleeps of the current run; its
    // continuations observe the aborted signal and fire no callback.
    this.run?.abort();
    this.run = null;
    this.consecutiveFailures = 0;
    this.reconnecting = false;
    this.tickInFlight = false;
    logger.info("[cloud-monitor] Connection monitor stopped");
  }

  isMonitoring(): boolean {
    return this.timer !== null;
  }

  private async tick(signal: AbortSignal): Promise<void> {
    // A slow heartbeat must not overlap the next interval, and a running
    // reconnect loop owns the connection until it settles.
    if (signal.aborted || this.reconnecting || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const alive = await this.client
        .heartbeat(this.agentId, { signal })
        .catch(() => false);
      if (signal.aborted) return;

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
        // onDisconnect() may stop() the monitor synchronously.
        if (signal.aborted) return;
        await this.attemptReconnect(signal);
      }
    } finally {
      if (!signal.aborted) this.tickInFlight = false;
    }
  }

  private async attemptReconnect(signal: AbortSignal): Promise<void> {
    this.reconnecting = true;
    this.callbacks.onStatusChange?.("reconnecting");

    let delay = 3_000;
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      // A status callback may have stopped the monitor synchronously; a
      // stopped run issues no further provision() request.
      if (signal.aborted) return;
      logger.info(
        `[cloud-monitor] Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}...`,
      );
      const ok = await this.client
        .provision(this.agentId, { signal })
        .then(() => true)
        .catch(() => false);
      if (signal.aborted) return;

      if (ok) {
        logger.info("[cloud-monitor] Reconnection successful");
        this.consecutiveFailures = 0;
        this.reconnecting = false;
        this.callbacks.onStatusChange?.("connected");
        if (signal.aborted) return;
        this.callbacks.onReconnect();
        return;
      }

      await sleep(delay, signal);
      if (signal.aborted) return;
      delay = Math.min(delay * 2, 60_000);
    }

    logger.error(
      `[cloud-monitor] Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`,
    );
    this.reconnecting = false;
    this.callbacks.onStatusChange?.("disconnected");
    if (signal.aborted) return;
    // error-policy:#14415 — the link is now durably down. Report exactly once
    // per exhaustion (not per failed attempt) so this is observable without
    // spamming. A throwing handler must not re-break the monitor.
    try {
      this.callbacks.onReconnectExhausted?.({
        attempts: MAX_RECONNECT_ATTEMPTS,
      });
    } catch (err) {
      logger.warn(
        `[cloud-monitor] onReconnectExhausted handler threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Backoff sleep that ends (and releases its timer) as soon as the run stops. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
