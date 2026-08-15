/**
 * Plugin definition and init for the in-process workflow engine. Wires the
 * WORKFLOW action, the workflow providers, the Drizzle schema, and the
 * services (WorkflowService, EmbeddedWorkflowService, WORKFLOW_DISPATCH).
 * init registers the dispatch service so trigger tasks can
 * fire workflows without the agent action layer; dispose stops long-lived
 * services. Default-enabled (opt out with `workflow.enabled: false`).
 */
import { type IAgentRuntime, logger, type Plugin } from '@elizaos/core';
import { workflowAction } from './actions/index';
import * as dbSchema from './db/index';
import { activeWorkflowsProvider, workflowStatusProvider } from './providers/index';
// Register the rawPath route plugin (`@elizaos/plugin-workflow:routes`) with
// the app-route-plugin-registry so the runtime mounts /api/workflow/* on the
// host HTTP server. The value import keeps bundlers from dropping this module as
// a side-effect-only import.
import { workflowRouteRegistration } from './register-routes';
import { workflowRoutes } from './routes/index';
import {
  EmbeddedWorkflowService,
  registerWorkflowDispatchService,
  WorkflowService,
} from './services/index';

void workflowRouteRegistration;

/**
 * Workflow Plugin for ElizaOS
 *
 * Generate, edit, run, schedule, and inspect native Smithers workflows through
 * elizaOS services and Cloud APIs.
 *
 */
export const workflowPlugin: Plugin = {
  name: 'workflow',
  description:
    'Create and administer native Smithers workflows through elizaOS Cloud, chat, and widgets.',

  services: [EmbeddedWorkflowService, WorkflowService],

  async dispose(runtime: IAgentRuntime) {
    await runtime.getService<WorkflowService>(WorkflowService.serviceType)?.stop();
    await runtime.getService<EmbeddedWorkflowService>(EmbeddedWorkflowService.serviceType)?.stop();
  },

  schema: dbSchema,

  actions: [workflowAction],

  providers: [workflowStatusProvider, activeWorkflowsProvider],

  routes: workflowRoutes,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    // Register WORKFLOW_DISPATCH so trigger-kind=workflow tasks can call
    // runtime.getService("WORKFLOW_DISPATCH").execute(workflowId).
    registerWorkflowDispatchService(runtime);

    logger.info(
      { src: 'plugin:workflow:plugin:init' },
      'Native Smithers workflow plugin initialized successfully'
    );
  },
};

export default workflowPlugin;

export * from './plugin-routes.js';
export * from './register-routes.js';
export * from './services/workflow-dispatch.js';
export {
  handleTriggerRoutes,
  type TriggerRouteContext,
  type TriggerRouteHelpers,
} from './trigger-routes.js';
