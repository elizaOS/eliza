import { type IAgentRuntime, logger, type Plugin } from '@elizaos/core';
import { workflowAction } from './actions/index';
import * as dbSchema from './db/index';
import {
  activeWorkflowsProvider,
  pendingDraftProvider,
  workflowStatusProvider,
} from './providers/index';
import { workflowRoutes } from './routes/index';
import {
  EmbeddedWorkflowService,
  registerWorkflowDispatchService,
  WorkflowCredentialStore,
  WorkflowService,
} from './services/index';
// Side-effect: register the rawPath route plugin
// (`@elizaos/plugin-workflow:routes`) with the app-route-plugin-registry so
// the runtime mounts /api/workflow/* on the host HTTP server. Without this
// import the registry call in register-routes.ts never fires and every
// /api/workflow/* request returns 404.
import './register-routes';

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

  schema: dbSchema,

  actions: [workflowAction],

  providers: [workflowStatusProvider, activeWorkflowsProvider, pendingDraftProvider],

  routes: workflowRoutes,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    // Check for pre-configured credentials (optional)
    // Note: runtime.getSetting() only returns primitives — nested objects must be read directly
    const workflowSettings = runtime.character?.settings?.workflows as
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
