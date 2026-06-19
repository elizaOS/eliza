/**
 * LifeOps ScheduledTask barrel.
 *
 * The storage-agnostic spine (types, runner, registries, due/next-fire-at math,
 * anchors) now lives in `@elizaos/plugin-scheduling` and is re-exported here so
 * existing PA importers keep their `./scheduled-task/index.js` path. The tick
 * driver (`processDueScheduledTasks`) and the runner Service stay PA-local
 * during the decomposition.
 */
export * from "@elizaos/plugin-scheduling";
export {
  type ProcessDueScheduledTasksRequest,
  type ProcessDueScheduledTasksResult,
  processDueScheduledTasks,
  type ScheduledTaskProcessingError,
} from "./scheduler.js";
export {
  type GetScheduledTaskRunnerOptions,
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "./service.js";
