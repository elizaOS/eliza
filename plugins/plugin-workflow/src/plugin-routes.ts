/**
 * n8n route plugin — registers `/api/workflow/*` route handlers with the
 * elizaOS runtime plugin route system.
 *
 * Migrated from packages/app-core/src/api/n8n-routes.ts. All routes use
 * `rawPath: true` to preserve the legacy `/api/workflow/*` paths without a
 * plugin-name prefix.
 *
 * The existing `n8n-workflow` plugin (`./plugin.ts`) ships actions,
 * services, providers, and schema. This file ships only the rawPath route
 * adapters used by the app-core HTTP server, so the two plugins stay
 * narrowly scoped: one for the runtime/agent surface, one for the
 * compatibility HTTP routes.
 */

import { loadElizaConfig } from '@elizaos/agent/config';
import { ensureRouteAuthorized } from '@elizaos/app-core';
import type { CompatRuntimeState } from '@elizaos/app-core';
import { sendJson } from '@elizaos/app-core';
import type { Plugin, Route } from '@elizaos/core';
import type http from 'node:http';
import { handleWorkflowRoutes, type WorkflowRouteContext } from './routes/n8n-routes';

type AnyRuntime = WorkflowRouteContext['runtime'];

interface WorkflowCompatState extends CompatRuntimeState {
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

    if (!(await ensureRouteAuthorized(httpReq, httpRes, state))) {
      return;
    }

    await handleWorkflowRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      config: loadElizaConfig(),
      runtime: state.current,
      json: (_res, body, status = 200) => {
        sendJson(httpRes, status, body);
      },
    });
  };
}

const workflowHandler = makeWorkflowHandler();

const n8nRouteList: Route[] = [
  // Status surface
  {
    type: 'GET',
    path: '/api/workflow/status',
    rawPath: true,
    handler: workflowHandler,
  },
  // Sidecar lifecycle
  {
    type: 'POST',
    path: '/api/workflow/sidecar/start',
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
];

export const n8nWorkflowRoutePlugin: Plugin = {
  name: '@elizaos/plugin-workflow:routes',
  description:
    'n8n workflow routes — status, sidecar lifecycle, and workflow CRUD proxy (extracted from app-core/server.ts)',
  routes: n8nRouteList,
};

export default n8nWorkflowRoutePlugin;
