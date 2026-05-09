import { type IAgentRuntime, logger, type Plugin } from '@elizaos/core';
import { N8nWorkflowService, N8nCredentialStore, EmbeddedN8nService } from './services/index';
import * as dbSchema from './db/index';
import {
  workflowStatusProvider,
  activeWorkflowsProvider,
  pendingDraftProvider,
} from './providers/index';
import { n8nRoutes } from './routes/index';

/**
 * n8n Workflow Plugin for ElizaOS
 *
 * Generate and manage n8n workflows from natural language using RAG pipeline.
 * Supports workflow CRUD, execution management, and credential resolution.
 *
 * **Required Configuration:**
 * - `N8N_API_KEY`: Your n8n API key
 * - `N8N_HOST`: Your n8n instance URL (e.g., https://your.n8n.cloud)
 *
 * **Optional Configuration:**
 * - `workflows.credentials`: Pre-configured credential IDs for local mode
 *
 * **Example Character Configuration:**
 * ```json
 * {
 *   "name": "AI Workflow Builder",
 *   "plugins": ["@elizaos/plugin-n8n-workflow"],
 *   "settings": {
 *     "N8N_API_KEY": "env:N8N_API_KEY",
 *     "N8N_HOST": "https://your.n8n.cloud",
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
export const n8nWorkflowPlugin: Plugin = {
  name: 'n8n-workflow',
  description:
    'Generate and deploy n8n workflows from natural language. ' +
    'Supports 450+ native n8n nodes (Gmail, Slack, Stripe, etc.) with intelligent ' +
    'credential resolution and workflow management.',

  services: [EmbeddedN8nService, N8nWorkflowService, N8nCredentialStore],

  schema: dbSchema,

  actions: [],

  providers: [workflowStatusProvider, activeWorkflowsProvider, pendingDraftProvider],

  routes: n8nRoutes,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    const apiKey = runtime.getSetting('N8N_API_KEY');
    const host = runtime.getSetting('N8N_HOST');
    const embeddedEnabled =
      runtime.getSetting('N8N_BACKEND') === 'embedded' ||
      runtime.getSetting('N8N_MODE') === 'embedded' ||
      runtime.getSetting('N8N_HOST')?.toString().startsWith('embedded://') ||
      ['1', 'true', 'yes', 'on'].includes(
        runtime.getSetting('N8N_EMBEDDED_ENABLED')?.toString().toLowerCase() ?? ''
      );

    logger.info(
      `n8n Workflow Plugin - Backend: ${embeddedEnabled ? 'embedded' : 'http'}, API Key: ${apiKey ? 'configured' : 'not configured'}, Host: ${host || 'not set'}`
    );

    if (!embeddedEnabled && !apiKey) {
      logger.debug(
        'N8N_API_KEY not provided - plugin will not be functional. ' +
          'Please set N8N_API_KEY in your environment or character settings.'
      );
    }

    if (!embeddedEnabled && !host) {
      logger.debug(
        'N8N_HOST not provided - plugin will not be functional. ' +
          'Please set N8N_HOST to your n8n instance URL (e.g., https://your.n8n.cloud).'
      );
    }

    // Check for pre-configured credentials (optional)
    // Note: runtime.getSetting() only returns primitives — nested objects must be read directly
    const workflowSettings = runtime.character?.settings?.workflows as
      | { credentials?: Record<string, string> }
      | undefined;
    if (workflowSettings?.credentials) {
      const credCount = Object.keys(workflowSettings.credentials).filter(
        (k) => workflowSettings.credentials![k]
      ).length;
      logger.info(
        { src: 'plugin:n8n-workflow:plugin:init' },
        `Pre-configured credentials: ${credCount} credential types`
      );
    }

    logger.info(
      { src: 'plugin:n8n-workflow:plugin:init' },
      'n8n Workflow Plugin initialized successfully'
    );
  },
};

export default n8nWorkflowPlugin;
