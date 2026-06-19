import type { Route } from '@elizaos/core';
import { embeddedWebhookRoutes } from './embedded-webhooks';
import { executionRoutes } from './executions';
import { nodeRoutes } from './nodes';
import { validationRoutes } from './validation';
import { workflowRoutes as workflowCrudRoutes } from './workflows';

export { type AutomationsRouteContext, handleAutomationsRoutes } from './automations';

export const workflowRoutes: Route[] = [
  ...validationRoutes,
  ...workflowCrudRoutes,
  ...nodeRoutes,
  ...executionRoutes,
  ...embeddedWebhookRoutes,
];
