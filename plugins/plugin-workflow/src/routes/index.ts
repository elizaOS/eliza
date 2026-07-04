/** Assembles the plugin-relative workflow route table (validation, nodes, executions, webhooks) mounted under `/workflow/*`. */
import type { Route } from '@elizaos/core';
import { embeddedWebhookRoutes } from './embedded-webhooks';
import { executionRoutes } from './executions';
import { nodeRoutes } from './nodes';
import { validationRoutes } from './validation';

export { type AutomationsRouteContext, handleAutomationsRoutes } from './automations';

// Workflow CRUD is served canonically by the rawPath `/api/workflow/*` surface
// (plugin-routes.ts -> routes/workflow-routes.ts). The relative routes below
// have no rawPath twin, so they stay here.
export const workflowRoutes: Route[] = [
  ...validationRoutes,
  ...nodeRoutes,
  ...executionRoutes,
  ...embeddedWebhookRoutes,
];
