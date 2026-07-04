/**
 * Plugin definition and init for the in-process workflow engine. Wires the
 * WORKFLOW/EVAL_CODE actions, the workflow providers, the Drizzle schema, and the
 * services (WorkflowService, EmbeddedWorkflowService, credential store,
 * WORKFLOW_DISPATCH). init registers the dispatch service so trigger tasks can
 * fire workflows without the agent action layer; dispose stops long-lived
 * services. Default-enabled (opt out with `workflow.enabled: false`).
 */
import { type IAgentRuntime, logger, type Plugin } from '@elizaos/core';
import { evalCodeAction, workflowAction } from './actions/index';
import * as dbSchema from './db/index';
import {
  activeWorkflowsProvider,
  pendingDraftProvider,
  workflowStatusProvider,
} from './providers/index';
// Register the rawPath route plugin (`@elizaos/plugin-workflow:routes`) with
// the app-route-plugin-registry so the runtime mounts /api/workflow/* on the
// host HTTP server. The value import keeps bundlers from dropping this module as
// a side-effect-only import.
import { workflowRouteRegistration } from './register-routes';
import { workflowRoutes } from './routes/index';
import {
  EmbeddedWorkflowService,
  registerWorkflowDispatchService,
  WorkflowCredentialStore,
  WorkflowService,
} from './services/index';

void workflowRouteRegistration;

/**
 * Workflow Plugin for ElizaOS
 *
 * Generate and manage workflows from natural language using a RAG pipeline.
 * Supports workflow CRUD, execution management, and credential resolution.
 *
 * **Optional Configuration:**
 * - `workflows.credentials`: Pre-configured credential IDs for local mode
 *
 * **Example Character Configuration:**
 * ```json
 * {
 *   "name": "AI Workflow Builder",
 *   "plugins": ["@elizaos/plugin-workflow"],
 *   "settings": {
 *     "workflows": {
 *       "credentials": {
 *         "gmailOAuth2": "cred_gmail_123",
 *         "stripeApi": "cred_stripe_456"
 *       }
 *     }
 *   }
 * }
 * ```
 */
export const workflowPlugin: Plugin = {
  name: 'workflow',
  description:
    'Generate and deploy workflows from natural language. ' +
    'Runs supported workflow nodes in-process with credential resolution.',

  services: [EmbeddedWorkflowService, WorkflowService, WorkflowCredentialStore],

  async dispose(runtime: IAgentRuntime) {
    await runtime.getService<WorkflowService>(WorkflowService.serviceType)?.stop();
    await runtime.getService<EmbeddedWorkflowService>(EmbeddedWorkflowService.serviceType)?.stop();
    await runtime.getService<WorkflowCredentialStore>(WorkflowCredentialStore.serviceType)?.stop();
  },

  schema: dbSchema,

  actions: [workflowAction, evalCodeAction],

  providers: [workflowStatusProvider, activeWorkflowsProvider, pendingDraftProvider],

  routes: workflowRoutes,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    // Check for pre-configured credentials (optional)
    // Note: runtime.getSetting() only returns primitives — nested objects must be read directly
    const workflowSettings = runtime.character.settings?.workflows as
      | { credentials?: Record<string, string> }
      | undefined;
    if (workflowSettings?.credentials) {
      const credCount = Object.keys(workflowSettings.credentials).filter(
        (k) => workflowSettings.credentials?.[k]
      ).length;
      logger.info(
        { src: 'plugin:workflow:plugin:init' },
        `Pre-configured credentials: ${credCount} credential types`
      );
    }

    // Register WORKFLOW_DISPATCH so trigger-kind=workflow tasks can call
    // runtime.getService("WORKFLOW_DISPATCH").execute(workflowId).
    registerWorkflowDispatchService(runtime);

    logger.info(
      { src: 'plugin:workflow:plugin:init' },
      'Workflow Plugin initialized successfully (in-process runtime)'
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
