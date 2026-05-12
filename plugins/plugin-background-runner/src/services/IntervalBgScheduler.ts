import { elizaLogger } from '@elizaos/core';
import type { BgSchedulerKind, IBgTaskScheduler, ScheduleOptions } from '../types';

/**
 * Pure setInterval fallback. Used when Capacitor is unavailable AND the host
 * has explicitly opted into the background runner anyway (server/desktop dev
 * harnesses, web previews, tests).
 *
 * In production server mode the core TaskService already runs its own timer;
 * this fallback exists so the same plugin can be loaded uniformly without
 * having to special-case mobile.
 */
export class IntervalBgScheduler implements IBgTaskScheduler {
  readonly kind: BgSchedulerKind = 'interval';

  private timer: ReturnType<typeof setInterval> | null = null;
  private currentLabel: string | null = null;

  isScheduled(): boolean {
    return this.timer !== null;
  }

  async schedule(options: ScheduleOptions): Promise<void> {
    if (this.timer !== null) {
      await this.cancel();
    }
    const periodMs = Math.max(options.minimumIntervalMinutes, 1) * 60_000;
    elizaLogger.info(
      `[plugin-background-runner] scheduling interval label="${options.label}" period=${periodMs}ms`
    );
    this.currentLabel = options.label;
    this.timer = setInterval(() => {
      options.onWake().catch((error) => {
        elizaLogger.error(
          { err: error, label: options.label },
          '[plugin-background-runner] interval wake failed'
        );
      });
    }, periodMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  async cancel(): Promise<void> {
    if (this.timer === null) {
      return;
    }
    elizaLogger.info(
      `[plugin-background-runner] cancelling interval label="${this.currentLabel ?? '(unknown)'}"`
    );
    clearInterval(this.timer);
    this.timer = null;
    this.currentLabel = null;
  }
}
