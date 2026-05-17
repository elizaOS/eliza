import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Background task kinds the native plugin can wake the JS layer with.
 *
 *  - `refresh`     → iOS `BGAppRefreshTaskRequest` — short (~30s), network-OK
 *                    foreground-equivalent wake. Used for the polling poke
 *                    against `/api/internal/wake`.
 *  - `processing`  → iOS `BGProcessingTaskRequest` — long-running (~minutes),
 *                    runs while the device is charging and idle. Used for the
 *                    local-LLM warmup pass that has no time pressure.
 *  - `remote-push` → silent APNs `content-available:1` push (gated on
 *                    `ELIZA_APNS_ENABLED` in Info.plist). Mirrors the BG-task
 *                    contract so the JS side can treat all three uniformly.
 */
export type ElizaTaskKind = "refresh" | "processing" | "remote-push";

export type ElizaTaskIdentifier =
  | "ai.eliza.tasks.refresh"
  | "ai.eliza.tasks.processing";

/**
 * Wake event delivered to JS listeners. Mirrors the `addEventListener("wake")`
 * contract in `runners/eliza-tasks.js` so the BackgroundRunner runner and the
 * BGTaskScheduler-driven runner share one client-side handler.
 */
export interface ElizaTasksWakeEvent {
  kind: ElizaTaskKind;
  identifier: ElizaTaskIdentifier | "ai.eliza.tasks.remote-push";
  deadlineSec: number;
  /** When the OS dispatched the wake (epoch ms). */
  firedAtMs: number;
  /**
   * For `remote-push`, the raw `userInfo` from APNs (minus `aps`). For
   * BGTaskScheduler wakes, an empty object — wake-time payload lives in the
   * agent's loopback HTTP route.
   */
  payload: Record<string, unknown>;
}

export interface ElizaTasksScheduleOptions {
  /**
   * Earliest begin date for the next wake, expressed as seconds from now.
   * `BGTaskScheduler` treats this as a hint — the OS controls the actual
   * dispatch time. Must be ≥ 1.
   */
  earliestBeginSec?: number;
  /**
   * If true, also enqueue the long-running BGProcessingTask. The processing
   * variant only fires while the device is charging and idle.
   */
  alsoProcessing?: boolean;
}

export interface ElizaTasksScheduleResult {
  scheduled: boolean;
  identifier: ElizaTaskIdentifier;
  earliestBeginAtMs: number | null;
  reason: string | null;
}

export interface ElizaTasksStatus {
  supported: boolean;
  platform: "ios" | "android" | "web";
  refreshScheduled: boolean;
  processingScheduled: boolean;
  lastWakeFiredAtMs: number | null;
  lastWakeKind: ElizaTaskKind | null;
  reason: string | null;
}

export interface ElizaTasksPlugin {
  /**
   * Enqueue the next BG refresh wake. Idempotent — calling repeatedly
   * replaces the pending request rather than stacking.
   */
  scheduleNext(
    options?: ElizaTasksScheduleOptions,
  ): Promise<ElizaTasksScheduleResult>;

  /**
   * Snapshot of the plugin's view of BGTaskScheduler state. Used by the JS
   * layer to decide whether to fall back to the BackgroundRunner repeat poll.
   */
  getStatus(): Promise<ElizaTasksStatus>;

  /**
   * Cancel any pending refresh + processing requests. Used during the
   * `disable mobile background tasks` flow.
   */
  cancelAll(): Promise<{ cancelled: boolean }>;

  addListener(
    eventName: "wake",
    listenerFunc: (event: ElizaTasksWakeEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
