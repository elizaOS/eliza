import { elizaLogger, type IAgentRuntime, Service, ServiceType } from '@elizaos/core';
import {
  type BackgroundRunnerLike,
  type CapacitorEnvironment,
  resolveCapacitorEnvironment,
} from '../capacitor/bridge';
import { CapacitorBgScheduler } from '../capacitor/capacitor-scheduler';
import { BACKGROUND_RUNNER_SERVICE_TYPE, type IBgTaskScheduler } from '../types';
import { IntervalBgScheduler } from './IntervalBgScheduler';

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
   */
  static pickScheduler(env: CapacitorEnvironment): IBgTaskScheduler {
    if (env.isCapacitor && env.runner !== null) {
      return new CapacitorBgScheduler(env.runner as BackgroundRunnerLike, env);
    }
    return new IntervalBgScheduler();
  }
}
