import { WebPlugin } from "@capacitor/core";
import type {
  ElizaTasksPlugin,
  ElizaTasksScheduleOptions,
  ElizaTasksScheduleResult,
  ElizaTasksStatus,
} from "./definitions";

/**
 * Web fallback for the ElizaTasks plugin.
 *
 * Browsers have no `BGTaskScheduler` equivalent. The plugin resolves to a
 * `supported: false` status so the runtime knows to fall back to the
 * BackgroundRunner repeat poll (already configured in `capacitor.config.ts`).
 */
export class ElizaTasksWeb extends WebPlugin implements ElizaTasksPlugin {
  scheduleNext(
    _options?: ElizaTasksScheduleOptions,
  ): Promise<ElizaTasksScheduleResult> {
    return Promise.resolve({
      scheduled: false,
      identifier: "ai.eliza.tasks.refresh",
      earliestBeginAtMs: null,
      reason: "BGTaskScheduler is iOS-only; web has no background wake path.",
    });
  }

  getStatus(): Promise<ElizaTasksStatus> {
    return Promise.resolve({
      supported: false,
      platform: "web",
      refreshScheduled: false,
      processingScheduled: false,
      lastWakeFiredAtMs: null,
      lastWakeKind: null,
      reason: "BGTaskScheduler is iOS-only; web has no background wake path.",
    });
  }

  cancelAll(): Promise<{ cancelled: boolean }> {
    return Promise.resolve({ cancelled: false });
  }
}
