import type { Route } from '@elizaos/core';
import { workflowRoutes as workflowCrudRoutes } from './workflows';
import { validationRoutes } from './validation';
import { nodeRoutes } from './nodes';
import { executionRoutes } from './executions';
import { embeddedWebhookRoutes } from './embedded-webhooks';

export const workflowRoutes: Route[] = [
  ...validationRoutes,
  ...workflowCrudRoutes,
  ...nodeRoutes,
  ...executionRoutes,
  ...embeddedWebhookRoutes,
];
