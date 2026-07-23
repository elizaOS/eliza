/**
 * Scheduling package barrel exports the runner spine, routes, dispatch policy,
 * plugin object, and anchor registry helpers for hosts.
 */
export {
  __resetAnchorRegistryForTests,
  APP_LIFEOPS_ANCHORS,
  getAnchorRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
} from "./anchors/anchor-registry.ts";
export {
  buildPrShepherdScheduleInput,
  CODING_AGENT_SCHEDULE_METADATA_KEY,
  type CreateCodingAgentScheduleDispatcherOptions,
  createCodingAgentScheduleDispatcher,
  deleteCodingAgentSchedule,
  GITHUB_PR_SHEPHERD_SERVICE_TYPE,
  type GitHubPrShepherdService,
  ORCHESTRATOR_TASK_SERVICE_TYPE,
  PR_SHEPHERD_RECIPE,
  type PrShepherdPullRequest,
  type PrShepherdRunReceipt,
  type PrShepherdRunSummary,
  type PrShepherdScheduleMetadata,
  type PrShepherdSchedulePolicy,
  pauseCodingAgentSchedule,
  resumeCodingAgentSchedule,
} from "./coding-agent-schedules.ts";
export {
  type DispatchFailureReason,
  type DispatchPolicyContext,
  type DispatchPolicyDecision,
  decideDispatchPolicy,
} from "./dispatch-policy.ts";
export type { DispatchResult } from "./dispatch-types.ts";
export {
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "./plugin.ts";
export { buildSchedulingRoutes } from "./routes/plugin-routes.ts";
export {
  makeScheduledTasksRouteHandler,
  SCHEDULED_TASKS_ROUTE_PATHS,
  type SchedulingRouteContext,
} from "./routes/scheduled-tasks.ts";
export * from "./scheduled-task/index.ts";
