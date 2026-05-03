import { claudeCodeWorkbenchPlugin } from "./plugin.ts";

export { claudeCodeWorkbenchListAction } from "./actions/list-workflows.ts";
export { claudeCodeWorkbenchRunAction } from "./actions/run-workflow.ts";
export type { ClaudeCodeWorkbenchConfig } from "./config.ts";
export {
  claudeCodeWorkbenchConfigSchema,
  DEFAULT_WORKBENCH_WORKFLOWS,
  isWorkflowAllowed,
  loadClaudeCodeWorkbenchConfig,
} from "./config.ts";
export { claudeCodeWorkbenchPlugin } from "./plugin.ts";
export { claudeCodeWorkbenchStatusProvider } from "./providers/status.ts";
export { claudeCodeWorkbenchRoutes } from "./routes.ts";

export type {
  WorkbenchRunInput,
  WorkbenchRunResult,
  WorkbenchStatus,
  WorkbenchWorkflowSummary,
} from "./services/workbench-service.ts";
export { ClaudeCodeWorkbenchService } from "./services/workbench-service.ts";
export type {
  WorkbenchWorkflow,
  WorkbenchWorkflowCategory,
} from "./workflows.ts";
export {
  findDefaultWorkflowById,
  getDefaultWorkflowIds,
  listDefaultWorkflows,
  normalizeWorkflowId,
} from "./workflows.ts";

export default claudeCodeWorkbenchPlugin;
