import { elizaLogger, type IAgentRuntime, Service, ServiceType } from '@elizaos/core';
import {
  type BackgroundRunnerLike,
  type CapacitorEnvironment,
  resolveCapacitorEnvironment,
} from '../capacitor/bridge.js';
import { CapacitorBgScheduler } from '../capacitor/capacitor-scheduler.js';
import { BACKGROUND_RUNNER_SERVICE_TYPE, type IBgTaskScheduler } from '../types.js';
import { IntervalBgScheduler } from './IntervalBgScheduler.js';

/**
 * Subset of core's TaskService that this plugin needs. Pinned structurally
 * here because TaskService is not re-exported from the published
 * `@elizaos/core` typings.
 */
interface TaskServiceLike {
  runDueTasks(): Promise<void>;
}

function isTaskServiceLike(service: Service | null): service is Service & TaskServiceLike {
  return service !== null && typeof Reflect.get(service, 'runDueTasks') === 'function';
}

/**
 * Integrates the host's background scheduler (iOS BGTaskScheduler / Android
 * WorkManager via Capacitor, or plain setInterval) with core's TaskService.
 *
 * The serverless seam: TaskService skips its own timer when
 * `runtime.serverless === true`. Each OS wake-up calls
 * `taskService.runDueTasks()` once and returns — no long-lived process.
 */
export class BgTaskSchedulerService extends Service {
  static override serviceType = BACKGROUND_RUNNER_SERVICE_TYPE;
  readonly capabilityDescription =
    'Drives core TaskService.runDueTasks() from OS-level wake-ups (BGTaskScheduler / WorkManager) on Capacitor mobile builds, with a setInterval fallback for non-mobile hosts.';

  private static readonly RUNNER_LABEL = 'eliza-tasks';
  private static readonly DEFAULT_INTERVAL_MINUTES = 15;

  private scheduler: IBgTaskScheduler | null = null;

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new BgTaskSchedulerService(runtime);
    await service.start();
    return service;
  }

  /**
   * Constructed scheduler. Visible to tests.
   */
  getScheduler(): IBgTaskScheduler | null {
    return this.scheduler;
  }

  async start(): Promise<void> {
    elizaLogger.info('[BgTaskSchedulerService] starting');
    this.runtime.serverless = true;

    this.scheduler = await this.buildScheduler();

    await this.scheduler.schedule({
      label: BgTaskSchedulerService.RUNNER_LABEL,
      minimumIntervalMinutes: BgTaskSchedulerService.DEFAULT_INTERVAL_MINUTES,
      onWake: () => this.onWake(),
    });

    elizaLogger.info(
      `[BgTaskSchedulerService] started kind=${this.scheduler.kind} serverless=true`
    );
  }

  async stop(): Promise<void> {
    if (this.scheduler !== null) {
      await this.scheduler.cancel();
      this.scheduler = null;
    }
  }

  /**
   * Wake-up handler. Drives core's TaskService once, then returns. Errors
   * surface — the host (Capacitor runner shim or interval) is responsible for
   * logging; we re-throw to keep the failure observable.
   */
  private async onWake(): Promise<void> {
    const service = this.runtime.getService(ServiceType.TASK);
    if (service === null) {
      elizaLogger.warn('[BgTaskSchedulerService] wake fired but no TaskService is registered');
      return;
    }
    if (!isTaskServiceLike(service)) {
      elizaLogger.warn(
        '[BgTaskSchedulerService] wake fired but registered TaskService does not expose runDueTasks'
      );
      return;
    }
    await service.runDueTasks();
  }

  /**
   * Capacitor when present and native, IntervalBgScheduler otherwise.
   * Override resolution lives in `resolveCapacitorEnvironment` so tests can
   * inject either branch.
   */
  protected async buildScheduler(): Promise<IBgTaskScheduler> {
    const env = await resolveCapacitorEnvironment();
    return BgTaskSchedulerService.pickScheduler(env);
  }

  /**
   * Pure factory exposed for tests — no I/O.
   *
   * Mobile (Capacitor native) hosts MUST install
   * `@capacitor/background-runner` (or alias `@capacitor-community/background-runner`).
   * Silently falling back to a setInterval would leave the app with no real
   * OS-level scheduling and the bug would only surface when the app is
   * backgrounded. Throw with a clear pointer to the install guide instead.
   */
  static pickScheduler(env: CapacitorEnvironment): IBgTaskScheduler {
    if (env.isCapacitor && env.runner !== null) {
      return new CapacitorBgScheduler(env.runner as BackgroundRunnerLike, env);
    }
    if (env.isCapacitor && env.runner === null) {
      throw new Error(
        '[plugin-background-runner] Capacitor native platform detected but `@capacitor/background-runner` is not installed. ' +
          'Add it to the host app and rebuild — see plugins/plugin-background-runner/INSTALL.md for the iOS/Android setup. ' +
          'Refusing to silently fall back to setInterval because that produces no real background execution on mobile.'
      );
    }
    return new IntervalBgScheduler();
  }
}
