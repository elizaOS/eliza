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
  /**
   * Monotonic lifecycle token. `tick()` captures the current value before its
   * heartbeat await and threads it into `attemptReconnect()`; `stop()`
   * increments it. After every `await` point the loop compares its captured
   * token to the live one and early-returns without firing any callback when
   * they differ — this is the only way to cancel a detached tick/retry loop
   * that is mid-`heartbeat()`, mid-`provision()`, or mid-backoff-sleep when
   * `stop()` runs, so no onStatusChange/onReconnect/onReconnectExhausted fires
   * after teardown and a dead monitor's backoff sleep cannot keep it alive.
   */
  private runToken = 0;

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
    // Invalidate any in-flight attemptReconnect() loop: it re-checks this token
    // after each await and bails without firing callbacks once it changes.
    this.runToken++;
    this.consecutiveFailures = 0;
    this.reconnecting = false;
    logger.info("[cloud-monitor] Connection monitor stopped");
  }

  isMonitoring(): boolean {
    return this.timer !== null;
  }

  private async tick(): Promise<void> {
    if (this.reconnecting) return;

    // Capture the lifecycle token before the heartbeat await. stop() bumps the
    // token while a tick is parked here; without this checkpoint the stale
    // continuation would fire onDisconnect() and enter attemptReconnect() after
    // teardown, and that loop would capture the already-incremented token as
    // its own baseline — defeating every downstream checkpoint.
    const token = this.runToken;

    const alive = await this.client.heartbeat(this.agentId).catch(() => false);

    // stop() may have run during the heartbeat await. Abandon this stale tick so
    // a torn-down monitor fires no callback and starts no reconnect loop.
    if (this.runToken !== token) return;

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

      // onDisconnect() is a public synchronous callback and may tear the
      // monitor down (e.g. call stop()). stop() bumps runToken synchronously,
      // so re-check before entering attemptReconnect(): a monitor stopped from
      // inside onDisconnect() must emit no "reconnecting" status and call no
      // provision(). Without this checkpoint the reconnect loop runs up to its
      // first post-await check, which is after those side effects.
      if (this.runToken !== token) return;

      await this.attemptReconnect(token);
    }
  }

  private async attemptReconnect(token: number): Promise<void> {
    // The lifecycle token is captured by tick() before its heartbeat await and
    // threaded in here, so a stop() during that await is already reflected. stop()
    // bumps runToken, which lets every post-await checkpoint below detect that
    // this loop was cancelled and abandon it silently.
    //
    // Defensive entry checkpoint: tick() already re-checks the token after
    // onDisconnect(), but guarding here too means no caller can enter this loop
    // with a stale token and fire "reconnecting"/provision() on a stopped
    // monitor before the first post-await check.
    if (this.runToken !== token) return;
    this.reconnecting = true;
    this.callbacks.onStatusChange?.("reconnecting");

    let delay = 3_000;
    for (let attempt = 1; attempt <= 10; attempt++) {
      logger.info(`[cloud-monitor] Reconnect attempt ${attempt}/10...`);
      const ok = await this.client
        .provision(this.agentId)
        .then(() => true)
        .catch(() => false);

      // provision() may have resolved after stop(): a stopped monitor must fire
      // no success callback and must not flip a torn-down manager back to
      // "connected".
      if (this.runToken !== token) return;

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

      // The backoff sleep is the other place stop() can land. Abandon the loop
      // here too so a dead monitor cannot keep retrying for tens of seconds or
      // reach the exhaustion callbacks below.
      if (this.runToken !== token) return;
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
