import type { Route } from '@elizaos/core';
import { embeddedWebhookRoutes } from './embedded-webhooks';
import { executionRoutes } from './executions';
import { nodeRoutes } from './nodes';
import { validationRoutes } from './validation';
import { workflowRoutes as workflowCrudRoutes } from './workflows';

export { handleAutomationsRoutes, type AutomationsRouteContext } from './automations';

export const workflowRoutes: Route[] = [
  ...validationRoutes,
  ...workflowCrudRoutes,
  ...nodeRoutes,
  ...executionRoutes,
  ...embeddedWebhookRoutes,
];
