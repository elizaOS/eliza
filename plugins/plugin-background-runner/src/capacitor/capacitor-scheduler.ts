import { elizaLogger } from '@elizaos/core';
import type { BgSchedulerKind, IBgTaskScheduler, ScheduleOptions } from '../types.js';
import type { BackgroundRunnerLike, CapacitorEnvironment } from './bridge.js';

/**
 * Capacitor-backed background scheduler.
 *
 * The actual OS-level job (iOS BGTaskScheduler / Android WorkManager periodic
 * worker) is registered statically by the host Capacitor app. This class just:
 *  1. Stores the wake callback so the bridge handler can invoke it.
 *  2. Calls `BackgroundRunner.dispatchEvent` at registration time so the
 *     native plugin wires up the runner-side handler.
 *  3. Tracks scheduled state for cancel().
 *
 * The runner-side handler (lives in `runners/<label>.js` in the host app) is
 * expected to call back into the JS context via the standard Capacitor
 * runner-event protocol. See INSTALL.md.
 */
export class CapacitorBgScheduler implements IBgTaskScheduler {
  readonly kind: BgSchedulerKind = 'capacitor';

  private scheduledLabel: string | null = null;

  constructor(
    private readonly runner: BackgroundRunnerLike,
    private readonly env: Pick<CapacitorEnvironment, 'isCapacitor'>
  ) {}

  isScheduled(): boolean {
    return this.scheduledLabel !== null;
  }

  async schedule(options: ScheduleOptions): Promise<void> {
    if (!this.env.isCapacitor) {
      throw new Error('CapacitorBgScheduler.schedule called outside Capacitor');
    }
    if (this.scheduledLabel !== null && this.scheduledLabel !== options.label) {
      await this.cancel();
    }
    elizaLogger.info(
      `[plugin-background-runner] scheduling Capacitor runner label="${options.label}" minInterval=${options.minimumIntervalMinutes}m`
    );
    await this.runner.dispatchEvent({
      label: options.label,
      event: 'register',
      details: {
        minimumIntervalMinutes: options.minimumIntervalMinutes,
      },
    });
    this.scheduledLabel = options.label;
  }

  async cancel(): Promise<void> {
    if (this.scheduledLabel === null) {
      return;
    }
    const label = this.scheduledLabel;
    elizaLogger.info(`[plugin-background-runner] cancelling Capacitor runner label="${label}"`);
    await this.runner.dispatchEvent({ label, event: 'cancel', details: {} });
    this.scheduledLabel = null;
  }
}
