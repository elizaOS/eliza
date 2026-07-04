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
  type DispatchFailureReason,
  type DispatchPolicyContext,
  type DispatchPolicyDecision,
  decideDispatchPolicy,
} from "./dispatch-policy.ts";
export type { DispatchResult } from "./dispatch-types.ts";
export { schedulingPlugin } from "./plugin.ts";
export { buildSchedulingRoutes } from "./routes/plugin-routes.ts";
export {
  makeScheduledTasksRouteHandler,
  SCHEDULED_TASKS_ROUTE_PATHS,
  type SchedulingRouteContext,
} from "./routes/scheduled-tasks.ts";
export * from "./scheduled-task/index.ts";
