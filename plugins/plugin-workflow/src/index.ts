import { type IAgentRuntime, logger, type Plugin } from '@elizaos/core';
import { workflowAction } from './actions/index';
import * as dbSchema from './db/index';
import { migrateLegacyTextTriggers, migrateLegacyWorkbenchTasks } from './lib/index';
import {
  activeWorkflowsProvider,
  pendingDraftProvider,
  workflowStatusProvider,
} from './providers/index';
import { workflowRoutes } from './routes/index';
import {
  EmbeddedWorkflowService,
  registerWorkflowDispatchService,
  WORKFLOW_SERVICE_TYPE,
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

    // Schedule one-shot legacy migrations off the init critical path. Service
    // start-order is not guaranteed at init: WorkflowService may not be in
    // the registry yet. Poll up to 10 times (1s spacing) and bail quietly
    // if it never appears. Each migration is idempotent so a duplicate run
    // on a future boot is harmless.
    scheduleLegacyMigrations(runtime);

    logger.info(
      { src: 'plugin:workflow:plugin:init' },
      'Workflow Plugin initialized successfully (in-process runtime)'
    );
  },
};

const MIGRATION_RETRY_LIMIT = 10;
const MIGRATION_RETRY_INTERVAL_MS = 1000;

function scheduleLegacyMigrations(runtime: IAgentRuntime): void {
  let attempts = 0;
  const tick = (): void => {
    attempts += 1;
    const ready = runtime.getService(WORKFLOW_SERVICE_TYPE);
    if (!ready) {
      if (attempts >= MIGRATION_RETRY_LIMIT) {
        logger.warn(
          { src: 'plugin:workflow:plugin:migration' },
          `WorkflowService still not registered after ${MIGRATION_RETRY_LIMIT} retries; legacy migrations will run on next boot`
        );
        return;
      }
      setTimeout(tick, MIGRATION_RETRY_INTERVAL_MS);
      return;
    }
    void runLegacyMigrations(runtime);
  };
  // Defer the first attempt off the init stack so the host runtime can
  // finish wiring before we probe the service registry.
  setImmediate(tick);
}

async function runLegacyMigrations(runtime: IAgentRuntime): Promise<void> {
  try {
    const summary = await migrateLegacyWorkbenchTasks(runtime);
    logger.info(
      {
        src: 'plugin:workflow:plugin:migration',
        migrated: summary.migrated,
        skipped: summary.skipped,
        failed: summary.failed,
      },
      `Workbench-task migration: ${summary.migrated} migrated, ${summary.skipped} skipped, ${summary.failed} failed`
    );
  } catch (err) {
    logger.warn(
      {
        src: 'plugin:workflow:plugin:migration',
        err: err instanceof Error ? err.message : String(err),
      },
      'Workbench-task migration threw; continuing'
    );
  }

  try {
    const summary = await migrateLegacyTextTriggers(runtime);
    logger.info(
      {
        src: 'plugin:workflow:plugin:migration',
        migrated: summary.migrated,
        skipped: summary.skipped,
        failed: summary.failed,
      },
      `Text-trigger migration: ${summary.migrated} migrated, ${summary.skipped} skipped, ${summary.failed} failed`
    );
  } catch (err) {
    logger.warn(
      {
        src: 'plugin:workflow:plugin:migration',
        err: err instanceof Error ? err.message : String(err),
      },
      'Text-trigger migration threw; continuing'
    );
  }
}

export default workflowPlugin;
