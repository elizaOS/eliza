/**
 * Back-compat re-export shim.
 *
 * The long-lived `ScheduledTaskRunnerService` (serviceType
 * `"lifeops_scheduled_task_runner"`) + the `getScheduledTaskRunner` accessor
 * now live in `@elizaos/plugin-scheduling`, which is an always-loaded core
 * plugin that hosts the generic scheduled-task runtime primitive. PA injects
 * its production deps via `registerLifeOpsScheduledTaskRunnerDeps`
 * (see `./runtime-wiring.ts`) so the runner behaves identically when PA is
 * loaded.
 *
 * This module keeps PA's existing import path
 * (`./scheduled-task/service.js`) resolving for back-compat.
 */

export {
  type GetScheduledTaskRunnerOptions,
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
