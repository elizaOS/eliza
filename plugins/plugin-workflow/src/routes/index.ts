import type { Route } from '@elizaos/core';
import { embeddedWebhookRoutes } from './embedded-webhooks';
import { executionRoutes } from './executions';
import { nodeRoutes } from './nodes';
import { validationRoutes } from './validation';

export { type AutomationsRouteContext, handleAutomationsRoutes } from './automations';

// Workflow CRUD is served canonically by the rawPath `/api/workflow/*` surface
// (plugin-routes.ts -> routes/workflow-routes.ts). The former plugin-relative
// `/workflows*` CRUD duplicate (routes/workflows.ts) was removed in #12177.
// The relative routes below have no rawPath twin, so they stay here.
export const workflowRoutes: Route[] = [
  ...validationRoutes,
  ...nodeRoutes,
  ...executionRoutes,
  ...embeddedWebhookRoutes,
];
