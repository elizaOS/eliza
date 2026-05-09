import type { Route } from '@elizaos/core';
import { workflowRoutes } from './workflows';
import { validationRoutes } from './validation';
import { nodeRoutes } from './nodes';
import { executionRoutes } from './executions';
import { embeddedWebhookRoutes } from './embedded-webhooks';

export const n8nRoutes: Route[] = [
  ...validationRoutes,
  ...workflowRoutes,
  ...nodeRoutes,
  ...executionRoutes,
  ...embeddedWebhookRoutes,
];
