import { elizaLogger, type Plugin } from '@elizaos/core';
import { BgTaskSchedulerService } from './services/BgTaskSchedulerService';

/**
 * Background runner plugin.
 *
 * Sets `runtime.serverless = true` and registers a background scheduler that
 * calls core `TaskService.runDueTasks()` on OS-level wake-ups (iOS
 * BGTaskScheduler / Android WorkManager via
 * `@capacitor-community/background-runner`). On non-Capacitor hosts it falls
 * back to a setInterval poll so the same plugin can be loaded uniformly.
 *
 * Native registration (BGTaskScheduler identifier in `Info.plist`,
 * AndroidManifest entries, runner JS files) is the host app's responsibility.
 * See INSTALL.md.
 */
export const backgroundRunnerPlugin: Plugin = {
  name: 'background-runner',
  description:
    'Drives core TaskService.runDueTasks() from OS-level wake-ups on Capacitor mobile builds (BGTaskScheduler / WorkManager). setInterval fallback for non-mobile hosts.',
  init: async (_config, runtime) => {
    elizaLogger.info(
      '[plugin-background-runner] registering BgTaskSchedulerService (serviceType="background_runner")'
    );
    await runtime.registerService(BgTaskSchedulerService);
  },
};

export default backgroundRunnerPlugin;

export { BgTaskSchedulerService } from './services/BgTaskSchedulerService';
export { CapacitorBgScheduler } from './capacitor/capacitor-scheduler';
export { IntervalBgScheduler } from './services/IntervalBgScheduler';
export {
  BACKGROUND_RUNNER_SERVICE_TYPE,
  type BgSchedulerKind,
  type IBgTaskScheduler,
  type ScheduleOptions,
} from './types';
export {
  type BackgroundRunnerLike,
  type CapacitorEnvironment,
  resolveCapacitorEnvironment,
} from './capacitor/bridge';
