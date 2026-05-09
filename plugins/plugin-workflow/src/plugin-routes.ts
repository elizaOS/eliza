/**
 * Workflow route plugin — registers `/api/workflow/*` route handlers with the
 * elizaOS runtime plugin route system. The handlers run in-process against
 * plugin-workflow services; there is no external workflow server or sidecar.
 */

import type http from 'node:http';
import type { Plugin, Route } from '@elizaos/core';
import { handleWorkflowRoutes, type WorkflowRouteContext } from './routes/workflow-routes';

type AnyRuntime = WorkflowRouteContext['runtime'];

interface WorkflowCompatState {
  current: AnyRuntime;
}

function buildState(runtime: unknown): WorkflowCompatState {
  return { current: runtime as AnyRuntime } as WorkflowCompatState;
}

function makeWorkflowHandler() {
  return async (req: unknown, res: unknown, runtime: unknown): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? '/', 'http://localhost');
    const method = (httpReq.method ?? 'GET').toUpperCase();
    const state = buildState(runtime);

    await handleWorkflowRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      runtime: state.current,
      json: (_res, body, status = 200) => {
        if (httpRes.headersSent) return;
        httpRes.statusCode = status;
        httpRes.setHeader('content-type', 'application/json; charset=utf-8');
        httpRes.end(JSON.stringify(body));
      },
    });
  };
}

const workflowHandler = makeWorkflowHandler();

const workflowRouteList: Route[] = [
  // Status surface
  {
    type: 'GET',
    path: '/api/workflow/status',
    rawPath: true,
    handler: workflowHandler,
  },
  // Runtime lifecycle/status compatibility
  {
    type: 'POST',
    path: '/api/workflow/runtime/start',
    rawPath: true,
    handler: workflowHandler,
  },
  // Workflow CRUD
  {
    type: 'GET',
    path: '/api/workflow/workflows',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'POST',
    path: '/api/workflow/workflows',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'POST',
    path: '/api/workflow/workflows/generate',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'POST',
    path: '/api/workflow/workflows/resolve-clarification',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'GET',
    path: '/api/workflow/workflows/:id',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'PUT',
    path: '/api/workflow/workflows/:id',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'POST',
    path: '/api/workflow/workflows/:id/activate',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'POST',
    path: '/api/workflow/workflows/:id/deactivate',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'DELETE',
    path: '/api/workflow/workflows/:id',
    rawPath: true,
    handler: workflowHandler,
  },
  {
    type: 'GET',
    path: '/api/workflow/workflows/:id/executions',
    rawPath: true,
    handler: workflowHandler,
  },
];

export const workflowRoutePlugin: Plugin = {
  name: '@elizaos/plugin-workflow:routes',
  description: 'Workflow routes — in-process status, generation, CRUD, and lifecycle handlers.',
  routes: workflowRouteList,
};

export default workflowRoutePlugin;
